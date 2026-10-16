// Runs @corridor/service as a real, listening HTTP server — the launcher that
// packages/service/src/index.ts's docblock only sketches today. Wires the same
// real dependencies as `pnpm testnet` (examples/run-testnet.ts): Sep31Adapter +
// StellarSep10Signer + StellarSettlementSubmitter + a Postgres-or-in-memory
// idempotency store — behind createService().server().listen(PORT), plus the
// PrometheusMetrics + gracefulShutdown wiring documented in docs/operations.md.
//
// Serves every corridor manifest found in CORRIDORS_DIR (default: corridors/),
// not just one.
//
//   CORRIDOR_SIGNER_SECRET=S...
//   HORIZON_URL=https://horizon-testnet.stellar.org
//   PORT=8080
//   DATABASE_URL=postgres://...        # optional; falls back to in-memory
//   CORRIDOR_API_KEYS=key1,key2        # optional; empty = no auth (dev only)
//   CORRIDOR_RATELIMIT_CAPACITY=20     # optional; omit to disable rate limiting
//   CORRIDOR_RATELIMIT_REFILL_PER_SEC=5
//   CORRIDORS_DIR=corridors            # optional
//   pnpm serve
//
// SAFETY: a corridor manifest with settlement.network=public is NOT served
// unless CORRIDOR_ALLOW_MAINNET=1 — same guard as `pnpm testnet`, applied per
// corridor so one mainnet lane can't silently move real money behind a server
// nobody's watching. mx-example, ng-cn, and ng-cowrie are all `network: public`
// today, so by default this serves only reference-testnet. Read docs/key-management.md
// before setting that flag with anything but a throwaway testnet secret.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { StaticRouteResolver } from "@corridor/router";
import { Sep31Adapter } from "@corridor/sep31";
import {
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
} from "@corridor/stellar";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  PrometheusMetrics,
  consoleLogger,
  defaultSep31Gate,
  migrate,
  type EngineDeps,
  type IdempotencyStore,
} from "@corridor/engine";
import { createService, gracefulShutdown } from "@corridor/service";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`✗ missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

function corridorsDir(): string {
  const d = process.env.CORRIDORS_DIR ?? "corridors";
  return d.startsWith("/") ? d : fileURLToPath(new URL(`../${d}`, import.meta.url));
}

function loadCorridors(): Map<string, Corridor> {
  const dir = corridorsDir();
  const allowMainnet = process.env.CORRIDOR_ALLOW_MAINNET === "1";
  const map = new Map<string, Corridor>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".corridor.yaml")) continue;
    const loaded = loadCorridor(join(dir, f));
    if (!loaded.ok) {
      console.warn(`• skipping ${f}: ${loaded.error.message}`);
      continue;
    }
    const c = loaded.value;
    if (c.settlement.network === "public" && !allowMainnet) {
      console.warn(
        `• skipping "${c.id}": settles on MAINNET (network=public). Set ` +
          `CORRIDOR_ALLOW_MAINNET=1 to serve it — this moves real money.`,
      );
      continue;
    }
    map.set(c.id, c);
  }
  return map;
}

async function buildStore(): Promise<{ store: IdempotencyStore; close: () => Promise<void> }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("• idempotency: in-memory (set DATABASE_URL for a durable run)");
    return { store: new InMemoryIdempotencyStore(), close: async () => {} };
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: dbUrl });
  await migrate(pool);
  console.log("• idempotency: Postgres (migrated)");
  return { store: new PostgresIdempotencyStore(pool), close: () => pool.end() };
}

async function main(): Promise<void> {
  const corridors = loadCorridors();
  if (corridors.size === 0) {
    console.error(`✗ no runnable corridor manifests found in ${corridorsDir()}`);
    process.exit(1);
  }

  const signer = LocalKeypairSigner.fromSecret(env("CORRIDOR_SIGNER_SECRET"));
  const horizonUrl = env("HORIZON_URL", "https://horizon-testnet.stellar.org");
  const sep10 = new StellarSep10Signer(signer);
  const submitter = new StellarSettlementSubmitter({ signer, horizonUrl });
  const { store, close } = await buildStore();
  const metrics = new PrometheusMetrics();

  const deps: EngineDeps = {
    resolver: new StaticRouteResolver((corridor) => new Sep31Adapter(corridor, { sep10 }), {
      trustManifestWithoutAttestation: true,
    }),
    submitter,
    idempotency: store,
    audit: new InMemoryAuditLog(),
    logger: consoleLogger,
    metrics,
    trustManifestWithoutAttestation: true,
    gate: defaultSep31Gate({ horizon: horizonUrl }),
  };

  const apiKeys = (process.env.CORRIDOR_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const rateLimitCapacity = process.env.CORRIDOR_RATELIMIT_CAPACITY;

  const service = createService({
    corridors,
    deps,
    apiKeys: apiKeys.length > 0 ? new Set(apiKeys) : undefined,
    rateLimit: rateLimitCapacity
      ? {
          capacity: Number(rateLimitCapacity),
          refillPerSec: Number(process.env.CORRIDOR_RATELIMIT_REFILL_PER_SEC ?? "5"),
        }
      : undefined,
    metricsText: () => metrics.render(),
  });

  const port = Number(process.env.PORT ?? "8080");
  const srv = service.server();
  srv.listen(port, () => {
    console.log(`\n✓ @corridor/service listening on :${port}`);
    console.log(`  corridors: ${[...corridors.keys()].join(", ")}`);
    console.log(`  signer:    ${signer.publicKey}`);
    console.log(`  horizon:   ${horizonUrl}`);
    console.log(`  auth:      ${apiKeys.length > 0 ? "API key required" : "none (dev)"}`);
    console.log(`  metrics:   GET /metrics\n`);
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} received, draining…`);
      void gracefulShutdown(srv).then(async () => {
        await close();
        process.exit(0);
      });
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
