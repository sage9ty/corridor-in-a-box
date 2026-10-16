// One-command REAL run against a live SEP-31 anchor. This is the wiring behind
// the README "Going live" list and docs/operations.md §1 — it swaps every mock
// for the production implementation and drives one payment end to end, then
// prints the trail + Stellar tx hash you paste into the README.
//
//   CORRIDOR_SIGNER_SECRET=S...            # testnet distribution account seed
//   HORIZON_URL=https://horizon-testnet.stellar.org
//   MANIFEST=corridors/reference.corridor.yaml
//   DATABASE_URL=postgres://...            # optional; falls back to in-memory
//   pnpm testnet
//
// SAFETY: refuses to run a `public` (mainnet) corridor unless you set
// CORRIDOR_ALLOW_MAINNET=1 — this moves real money. Read docs/key-management.md
// before pointing it at a mainnet seed (use a KMS-backed ExternalSigner, never a
// raw secret in env, for anything but throwaway testnet keys).

import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
import { StaticRouteResolver } from "@corridor/router";
import { Sep31Adapter, sep31GateChecks } from "@corridor/sep31";
import {
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
} from "@corridor/stellar";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  consoleLogger,
  defaultSep31Gate,
  execute,
  migrate,
  type EngineDeps,
  type IdempotencyStore,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`✗ missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  // Allow both repo-relative (default) and absolute/cwd-relative paths.
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
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
  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(1);
  }
  const corridor = loaded.value;

  if (corridor.settlement.network === "public" && process.env.CORRIDOR_ALLOW_MAINNET !== "1") {
    console.error(
      `✗ corridor "${corridor.id}" settles on MAINNET (network=public). This moves real ` +
        `money. Re-run with CORRIDOR_ALLOW_MAINNET=1 only if you mean it.`,
    );
    process.exit(3);
  }

  const sep31Server =
    "transfer_server_sep31" in corridor.dest.endpoints
      ? corridor.dest.endpoints.transfer_server_sep31
      : undefined;
  if (!sep31Server) {
    console.error(
      `✗ corridor "${corridor.id}" has no dest SEP-31 transfer server — not runnable. ` +
        `Fill dest.endpoints from the anchor's stellar.toml first (see 'pnpm cli plan').`,
    );
    process.exit(1);
  }

  const signer = LocalKeypairSigner.fromSecret(env("CORRIDOR_SIGNER_SECRET"));
  const horizonUrl = env("HORIZON_URL", "https://horizon-testnet.stellar.org");

  const adapter = new Sep31Adapter(corridor, { sep10: new StellarSep10Signer(signer) });
  const submitter = new StellarSettlementSubmitter({ signer, horizonUrl });
  const { store, close } = await buildStore();
  const audit = new InMemoryAuditLog();

  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => adapter, {
      trustManifestWithoutAttestation: true,
    }),
    submitter,
    idempotency: store,
    audit,
    logger: consoleLogger,
    trustManifestWithoutAttestation: true,
    gate: defaultSep31Gate({ adapter, horizon: horizonUrl, checks: sep31GateChecks(adapter) }),
  };

  // --- SEP-12 registration ------------------------------------------------
  // The receiving anchor pays out to a customer IT knows, identified by an id it
  // issued. Registering is the sending side's job — it holds the PII — and the
  // engine never does it, which is what keeps PII out of the payment path. So do
  // it here, before execute(), and carry only the returned id on the intent.
  //
  // Reuse an id with RECIPIENT_SEP12_ID to skip re-registering.
  // Which fields an anchor requires is ITS decision, published in its
  // `GET /sep12/customer` response under `fields` with `optional: false`. These
  // defaults are what the Anchor Platform reference server asks for; any other
  // anchor will want a different set. If registration leaves a customer at
  // NEEDS_INFO, read that response and fill in what it names.
  const register = async (role: "receiver" | "sender", type: string): Promise<string> => {
    console.log(`registering ${role} with ${corridor.dest.name} (SEP-12)…`);
    const reg = await adapter.registerCustomer(
      {
        first_name: process.env[`${role.toUpperCase()}_FIRST_NAME`] ?? "Alice",
        last_name: process.env[`${role.toUpperCase()}_LAST_NAME`] ?? "Example",
        email_address: process.env[`${role.toUpperCase()}_EMAIL`] ?? `${role}@example.com`,
        bank_account_number: "12345678901234",
        bank_number: "021000021",
        bank_account_type: "checking",
        clabe_number: "032180000118359719",
      },
      { type },
    );
    if (!reg.ok) {
      console.error(
        `✗ SEP-12 ${role} registration failed: ${reg.error.code} — ${reg.error.message}`,
      );
      console.error(
        `  The anchor decides which fields it needs; read its GET /sep12/customer ` +
          `response (fields with optional:false) and supply those.`,
      );
      process.exit(1);
    }
    console.log(`  ${role} sep12 id: ${reg.value}`);
    return reg.value;
  };

  // SEP-31 identifies BOTH parties to the receiving anchor: the sender because
  // the anchor must know who the funds came from for its own compliance, the
  // receiver because it is who gets paid.
  const senderSep12Id =
    process.env.SENDER_SEP12_ID ??
    (await register("sender", corridor.compliance.sep12_sender_type));
  const recipientSep12Id =
    process.env.RECIPIENT_SEP12_ID ??
    (await register("receiver", corridor.compliance.sep12_receiver_type));
  console.log();

  const intent: PaymentIntent = {
    idempotencyKey: process.env.IDEMPOTENCY_KEY ?? `testnet-${Date.now()}`,
    corridorId: corridor.id,
    sender: {
      id: process.env.SENDER_ID ?? "sender-1",
      jurisdiction: corridor.compliance.source_jurisdiction,
      sep12Id: senderSep12Id,
    },
    recipient: {
      id: process.env.RECIPIENT_ID ?? "recipient-1",
      jurisdiction: corridor.compliance.dest_jurisdiction,
      sep12Id: recipientSep12Id,
    },
    sourceAmount: {
      asset: corridor.settlement.bridge_asset,
      amount: process.env.AMOUNT ?? "10.00",
    },
    // Payout instructions the destination anchor requires. The names come from
    // its GET /sep31/info `fields.transaction`; these are what the Anchor
    // Platform reference server asks for.
    destinationFields: {
      receiver_routing_number: process.env.RECEIVER_ROUTING_NUMBER ?? "021000021",
      receiver_account_number: process.env.RECEIVER_ACCOUNT_NUMBER ?? "12345678901234",
      type: process.env.RECEIVER_DEPOSIT_TYPE ?? "SWIFT",
    },
  };

  console.log(`\nrunning corridor "${corridor.id}" on ${corridor.settlement.network}`);
  console.log(`signer:     ${signer.publicKey}`);
  console.log(`horizon:    ${horizonUrl}`);
  console.log(`anchor:     ${sep31Server}`);
  console.log(
    `intent:     ${intent.idempotencyKey} (${intent.sourceAmount.amount} ${intent.sourceAmount.asset})\n`,
  );

  try {
    const result = await execute(intent, corridor, deps);
    if (result.ok) {
      console.log("\n✓ payment completed");
      console.log(`  state:       ${result.value.state}`);
      console.log(`  stellar tx:  ${result.value.stellarTxHash}`);
      console.log(`  trail:       ${result.value.trail.join(" -> ")}`);
      console.log(`  audit:       ${audit.entries.length} transitions recorded`);
      console.log(`\nPaste the trail + stellar tx into the README to close the Phase-1 item.`);
    } else {
      console.error(`\n✗ payment failed: ${result.error.code} — ${result.error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
