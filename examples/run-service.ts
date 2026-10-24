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
//   CORRIDOR_SIGNER=local                 # default; requires CORRIDOR_SIGNER_SECRET
//   CORRIDOR_SIGNER=vault                 # requires VAULT_ADDR, VAULT_TOKEN, VAULT_TRANSIT_KEY
//                                         # (optional VAULT_TRANSIT_MOUNT, default "transit")
//   CORRIDOR_SIGNER_SECRET=S...           # local signer only
//   HORIZON_URL=https://horizon-testnet.stellar.org
//   PORT=8080
//   DATABASE_URL=postgres://...        # optional; falls back to in-memory
//   CORRIDOR_API_KEYS=key1,key2        # optional; empty = no auth (dev only)
//   CORRIDOR_RATELIMIT_CAPACITY=20     # optional; omit to disable rate limiting
//   CORRIDOR_RATELIMIT_REFILL_PER_SEC=5
//   CORRIDORS_DIR=corridors            # optional
//   CORRIDOR_RESOLVER_MODULE=path|pkg  # optional; omit = StaticRouteResolver
//   CORRIDOR_RESOLVER_OPTIONS='{...}'  # optional; JSON options for the module
//   pnpm serve
//
// The active resolver is logged at boot under `resolver:` in the startup
// summary — see docs/route-resolver.md for the module contract.
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
import {
  createAdapterRegistry,
  loadResolver,
  StaticRouteResolver,
  type RouteResolver,
} from "@corridor/router";
import { Sep31Adapter } from "@corridor/sep31";
import {
  assertSignerProducesValidSignatures,
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
  VaultTransitSigner,
  type ExternalSigner,
} from "@corridor/stellar";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  PostgresAuditSink,
  PostgresIdempotencyStore,
  PrometheusMetrics,
  consoleLogger,
  defaultSep31Gate,
  migrate,
  type AuditSink,
  type EngineDeps,
  type IdempotencyStore,
} from "@corridor/engine";
import { createService, gracefulShutdown, storeCheck } from "@corridor/service";
import type { AnchorAdapter } from "@corridor/adapter-kit";

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

/** The single opt-in for real money, shared by the corridor filter and the submitter. */
function allowMainnet(): boolean {
  return process.env.CORRIDOR_ALLOW_MAINNET === "1";
}

function loadCorridors(): Map<string, Corridor> {
  const dir = corridorsDir();
  const mainnet = allowMainnet();
  const map = new Map<string, Corridor>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".corridor.yaml")) continue;
    const loaded = loadCorridor(join(dir, f));
    if (!loaded.ok) {
      console.warn(`• skipping ${f}: ${loaded.error.message}`);
      continue;
    }
    const c = loaded.value;
    if (c.settlement.network === "public" && !mainnet) {
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

async function buildStore(): Promise<{
  store: IdempotencyStore;
  audit: AuditSink;
  close: () => Promise<void>;
}> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("• idempotency + audit: in-memory (set DATABASE_URL for a durable run)");
    return {
      store: new InMemoryIdempotencyStore(),
      audit: new InMemoryAuditLog(),
      close: async () => {},
    };
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: dbUrl });
  await migrate(pool);
  console.log("• idempotency + audit: Postgres (migrated)");
  return {
    store: new PostgresIdempotencyStore(pool),
    audit: new PostgresAuditSink(pool),
    close: () => pool.end(),
  };
}

/**
 * Which resolver this process routes with, decided by config rather than code:
 * CORRIDOR_RESOLVER_MODULE names a module (filesystem path or installed
 * package) loaded through loadResolver(); unset falls back to the open default.
 * A named module that is missing or incompatible stops the boot — falling back
 * to a weaker resolver because the strong one failed to load is exactly the
 * behaviour a deploy-time injection seam must not have.
 */
async function buildResolver(adapterFor: (c: Corridor) => AnchorAdapter): Promise<{
  resolver: RouteResolver;
  label: string;
}> {
  const module = process.env.CORRIDOR_RESOLVER_MODULE;
  if (!module) {
    console.log("• resolver: StaticRouteResolver (default)");
    return {
      resolver: new StaticRouteResolver(adapterFor, { trustManifestWithoutAttestation: true }),
      label: "StaticRouteResolver (default)",
    };
  }

  const rawOptions = process.env.CORRIDOR_RESOLVER_OPTIONS;
  let options: unknown;
  if (rawOptions) {
    try {
      options = JSON.parse(rawOptions);
    } catch {
      console.error("✗ CORRIDOR_RESOLVER_OPTIONS is not valid JSON");
      process.exit(2);
    }
  }

  const resolver = await loadResolver({ module, options }, { adapterFor });
  console.log(`• resolver: ${module} (CORRIDOR_RESOLVER_MODULE)`);
  return { resolver, label: module };
}

/** Protocol -> adapter. Register `sep6` / `custom:<id>` here as those adapters are wired. */
function buildAdapterRegistry(sep10: StellarSep10Signer) {
  const registry = createAdapterRegistry();
  registry.register("sep31", (corridor) => new Sep31Adapter(corridor, { sep10 }));
  return registry;
}

/** Fail at startup, not at the first payment, when a manifest names a protocol with no adapter. */
function validateCorridors(
  corridors: Map<string, Corridor>,
  registry: ReturnType<typeof buildAdapterRegistry>,
): void {
  for (const c of corridors.values()) {
    if (!registry.has(c)) {
      console.error(
        `✗ corridor "${c.id}" uses protocol "${c.dest.protocol}" but no adapter is registered for it`,
      );
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const corridors = loadCorridors();
  if (corridors.size === 0) {
    console.error(`✗ no runnable corridor manifests found in ${corridorsDir()}`);
    process.exit(1);
  }

  const signerKind = process.env.CORRIDOR_SIGNER ?? "local";
  let signer: ExternalSigner;
  if (signerKind === "vault") {
    signer = await VaultTransitSigner.create({
      address: env("VAULT_ADDR"),
      token: env("VAULT_TOKEN"),
      keyName: env("VAULT_TRANSIT_KEY"),
      mount: process.env.VAULT_TRANSIT_MOUNT,
    });
  } else if (signerKind === "local") {
    signer = LocalKeypairSigner.fromSecret(env("CORRIDOR_SIGNER_SECRET"));
  } else {
    throw new Error(`unsupported CORRIDOR_SIGNER value: ${signerKind}`);
  }
  await assertSignerProducesValidSignatures(signer);
  console.log(`• signer: ${signerKind} (${signer.publicKey})`);
  const horizonUrl = env("HORIZON_URL", "https://horizon-testnet.stellar.org");
  const sep10 = new StellarSep10Signer(signer);
  // The per-corridor filter above only decides what gets _served_; this is the
  // guard that decides what can be _signed_. Both hang off the same opt-in, so
  // the submitter can never be looser than the launcher (see @corridor/stellar).
  const submitter = new StellarSettlementSubmitter({
    signer,
    horizonUrl,
    allowedNetworks: allowMainnet() ? ["testnet", "public"] : ["testnet"],
  });
  const { store, audit, close } = await buildStore();
  const metrics = new PrometheusMetrics();
  const adapters = buildAdapterRegistry(sep10);
  validateCorridors(corridors, adapters);
  const { resolver, label: resolverLabel } = await buildResolver((corridor) =>
    adapters.adapterFor(corridor),
  );

  const deps: EngineDeps = {
    resolver,
    submitter,
    idempotency: store,
    audit,
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
    // Wire the idempotency store check so /readyz reports store reachability.
    // PostgresIdempotencyStore has ping(); InMemoryIdempotencyStore does not —
    // only register the check when the store supports it.
    readinessChecks: "ping" in store ? [storeCheck(store as { ping(): Promise<void> })] : [],
  });

  const port = Number(process.env.PORT ?? "8080");
  const srv = service.server();
  srv.listen(port, () => {
    console.log(`\n✓ @corridor/service listening on :${port}`);
    console.log(`  corridors: ${[...corridors.keys()].join(", ")}`);
    console.log(`  signer:    ${signer.publicKey}`);
    console.log(`  horizon:   ${horizonUrl}`);
    console.log(`  resolver:  ${resolverLabel}`);
    console.log(`  auth:      ${apiKeys.length > 0 ? "API key required" : "none (dev)"}`);
    console.log(`  metrics:   GET /metrics\n`);
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} received, draining…`);
      void gracefulShutdown(srv, service).then(async () => {
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
