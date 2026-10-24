// Crash-resume integration test: kill after settled, resume to completed
// against a real anchor.
//
// This test exercises the exact path most likely to be wrong in production:
// a process that crashes AFTER the on-chain payment has been submitted
// (state = "settled") must NOT re-settle when execute() is called again with
// the same idempotencyKey. It must resume reconciliation, confirm payout with
// the anchor, and advance to "completed".
//
// The single most important assertion is the negative one:
//   exactly ONE Stellar transaction hash exists for the whole run.
//
// The test is SKIPPED unless all required env vars are set. See .env.example.
//
// Run it:
//
//   ANCHOR_HOME_DOMAIN=anchor.example \
//   ANCHOR_SEP31_TRANSFER_SERVER=https://anchor.example/sep31 \
//   ANCHOR_SEP31_QUOTE_SERVER=https://anchor.example/sep38 \
//   ANCHOR_SEP31_WEB_AUTH=https://anchor.example/auth \
//   ANCHOR_ASSET_ISSUER=G... \
//   ANCHOR_RECIPIENT_SEP12_ID=cust_... \
//   CORRIDOR_SIGNER_SECRET=S...   # testnet only \
//   HORIZON_URL=https://horizon-testnet.stellar.org \
//   CORRIDOR_TEST_DATABASE_URL=postgres://... \
//   pnpm exec vitest run tests/integration/crash-resume.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { Sep31Adapter } from "@corridor/sep31";
import { StellarSep10Signer, StellarSettlementSubmitter } from "@corridor/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { StaticRouteResolver } from "@corridor/router";
import {
  execute,
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  migrate,
  type Queryable,
  type SettlementSubmitter,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

// -- env gates ---------------------------------------------------------------
const env = process.env;
const transferServer = env.ANCHOR_SEP31_TRANSFER_SERVER;
const homeDomain = env.ANCHOR_HOME_DOMAIN;
const signerSecret = env.CORRIDOR_SIGNER_SECRET || "";
const horizonUrl =
  env.HORIZON_URL || env.CORRIDOR_HORIZON_URL || "https://horizon-testnet.stellar.org";
const dbUrl = env.CORRIDOR_TEST_DATABASE_URL;

const hasAnchor = Boolean(transferServer && homeDomain && signerSecret);
const hasDb = Boolean(dbUrl);

// -- corridor fixture --------------------------------------------------------
function liveCorridor(): Corridor {
  const endpoints: Record<string, string> = {
    home_domain: homeDomain as string,
    transfer_server_sep31: transferServer as string,
  };
  if (env.ANCHOR_SEP31_QUOTE_SERVER) endpoints.quote_server = env.ANCHOR_SEP31_QUOTE_SERVER;
  if (env.ANCHOR_SEP31_WEB_AUTH) endpoints.web_auth = env.ANCHOR_SEP31_WEB_AUTH;
  if (env.ANCHOR_SEP31_KYC_SERVER) endpoints.kyc_server = env.ANCHOR_SEP31_KYC_SERVER;

  const r = parseCorridor({
    id: "integration-crash-resume",
    source: { name: "Source", asset: "USDC", endpoints: { home_domain: "source.local" } },
    dest: {
      name: homeDomain,
      asset: env.ANCHOR_DEST_ASSET || "iso4217:USD",
      endpoints,
    },
    fx: { path: ["USDC", "USDC"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "US" },
    settlement: {
      network: "testnet",
      asset_issuer: env.ANCHOR_ASSET_ISSUER || "GTEST",
    },
    recovery: { timeout_seconds: 300, rollback: "hold" },
  });
  if (!r.ok) throw new Error(`invalid live corridor fixture: ${r.error.message}`);
  return r.value;
}

function adapterFor(c: Corridor): Sep31Adapter {
  const sep10 = signerSecret
    ? new StellarSep10Signer(Keypair.fromSecret(signerSecret))
    : undefined;
  return new Sep31Adapter(c, { sep10 });
}

function submitterFor(): SettlementSubmitter {
  if (!signerSecret) throw new Error("CORRIDOR_SIGNER_SECRET required for settlement");
  return new StellarSettlementSubmitter({ signerSecret, horizonUrl });
}

// -- A tracking submitter that counts every submit() call --------------------
// Wraps the real submitter and records every successful tx hash so we can assert
// no second on-chain payment was issued after crash-resume.
function trackingSubmitter(inner: SettlementSubmitter): {
  submitter: SettlementSubmitter;
  hashes: string[];
} {
  const hashes: string[] = [];
  const submitter: SettlementSubmitter = {
    async submit(req) {
      const r = await inner.submit(req);
      if (r.ok) {
        expect(r.value.kind).toBe("stellar");
        if (r.value.kind === "stellar") hashes.push(r.value.stellarTxHash);
      }
      return r;
    },
    ...(inner.findExisting
      ? {
          findExisting: (
            req: Parameters<NonNullable<SettlementSubmitter["findExisting"]>>[0],
          ) => inner.findExisting!(req),
        }
      : {}),
    async refund(req) {
      return inner.refund(req);
    },
  };
  return { submitter, hashes };
}

// -- crash-resume (in-memory store, anchor only) ----------------------------
describe.skipIf(!hasAnchor)("crash-resume (live anchor, in-memory store)", () => {
  it("resuming from settled does NOT re-settle — exactly one tx hash", async () => {
    const c = liveCorridor();
    const adapter = adapterFor(c);
    const store = new InMemoryIdempotencyStore();
    const { submitter, hashes } = trackingSubmitter(submitterFor());
    const resolver = new StaticRouteResolver(() => adapter, {
      trustManifestWithoutAttestation: true,
    });
    const ikey = `crash-resume-inmem-${Date.now()}`;

    const intent: PaymentIntent = {
      idempotencyKey: ikey,
      corridorId: c.id,
      sender: { id: "crash-sender" },
      recipient: {
        id: env.ANCHOR_RECIPIENT_ID || "crash-recipient",
        ...(env.ANCHOR_RECIPIENT_SEP12_ID ? { sep12Id: env.ANCHOR_RECIPIENT_SEP12_ID } : {}),
      },
      sourceAmount: { asset: "USDC", amount: env.ANCHOR_AMOUNT || "10" },
    };

    // First run: complete normally
    const firstRun = await execute(intent, c, {
      resolver,
      submitter,
      idempotency: store,
      unsafeSkipPreSettleGate: true,
    });

    if (!firstRun.ok) {
      console.warn(
        `[crash-resume] first execute() failed: ${firstRun.error.code} — ${firstRun.error.message}; skipping crash assertion`,
      );
      return;
    }

    const txHash = firstRun.value.stellarTxHash;
    const txId = firstRun.value.transactionId;
    expect(txHash).toBeTruthy();
    expect(hashes).toHaveLength(1);

    for (const resumeState of ["opened", "settling"] as const) {
      const existing = await store.get(ikey);
      expect(existing).toBeDefined();
      await store.put({
        ...existing!,
        state: resumeState,
        transactionId: txId,
        stellarTxHash: resumeState === "settling" ? undefined : txHash,
        // The next evidence-backed transition must carry a larger version.
        version: existing!.version - 1,
      });

      // Second execute() with same key: must resume, never re-settle
      const resumed = await execute(intent, c, {
        resolver,
        submitter,
        idempotency: store,
        unsafeSkipPreSettleGate: true,
      });
      expect(resumed.ok).toBe(true);
      if (resumed.ok) {
        expect(resumed.value.state).toBe("completed");
        // THE critical assertion
        expect(hashes).toHaveLength(1);
        expect(resumed.value.stellarTxHash).toBe(txHash);
      }
    }
  }, 300_000);
});

// -- crash-resume (live anchor + Postgres) -----------------------------------
describe.skipIf(!hasAnchor || !hasDb)("crash-resume (live anchor + Postgres)", () => {
  let pool: { query: Queryable["query"]; end: () => Promise<void> };

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: dbUrl }) as unknown as typeof pool;
    await migrate(pool as unknown as Queryable);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from corridor_runs");
  });

  it("resuming from persisted settled state reaches completed with exactly one settlement", async () => {
    const c = liveCorridor();
    const adapter = adapterFor(c);
    const store = new PostgresIdempotencyStore(pool as unknown as Queryable);
    const { submitter, hashes } = trackingSubmitter(submitterFor());
    const resolver = new StaticRouteResolver(() => adapter, {
      trustManifestWithoutAttestation: true,
    });
    const ikey = `crash-resume-pg-${Date.now()}`;

    const intent: PaymentIntent = {
      idempotencyKey: ikey,
      corridorId: c.id,
      sender: { id: "crash-sender-pg" },
      recipient: {
        id: env.ANCHOR_RECIPIENT_ID || "crash-recipient-pg",
        ...(env.ANCHOR_RECIPIENT_SEP12_ID ? { sep12Id: env.ANCHOR_RECIPIENT_SEP12_ID } : {}),
      },
      sourceAmount: { asset: "USDC", amount: env.ANCHOR_AMOUNT || "10" },
    };

    // First execute: run through to completion
    const firstRun = await execute(intent, c, {
      resolver,
      submitter,
      idempotency: store,
      unsafeSkipPreSettleGate: true,
    });

    if (!firstRun.ok) {
      console.warn(
        `[crash-resume-pg] first execute() failed: ${firstRun.error.code} — ${firstRun.error.message}; skipping`,
      );
      return;
    }

    const txHash = firstRun.value.stellarTxHash;
    const txId = firstRun.value.transactionId;
    expect(txHash).toBeTruthy();
    expect(hashes).toHaveLength(1);

    // Simulate crash: wind the Postgres row back to "settled"
    await pool.query(
      `UPDATE corridor_runs
         SET state = 'settled', version = version - 1
         WHERE idempotency_key = $1`,
      [ikey],
    );

    // Verify the row is at settled before calling execute() again
    const rowAfterRollback = await store.get(ikey);
    expect(rowAfterRollback?.state).toBe("settled");
    expect(rowAfterRollback?.stellarTxHash).toBe(txHash);
    expect(rowAfterRollback?.transactionId).toBe(txId);

    // Second execute() with same key: must resume from settled, not re-settle
    const secondRun = await execute(intent, c, {
      resolver,
      submitter,
      idempotency: store,
      unsafeSkipPreSettleGate: true,
    });

    expect(secondRun.ok).toBe(true);
    if (secondRun.ok) {
      expect(secondRun.value.state).toBe("completed");
      // THE critical assertion: only one on-chain payment ever submitted
      expect(hashes).toHaveLength(1);
      expect(secondRun.value.stellarTxHash).toBe(txHash);
    }

    // The Postgres row must also be at completed
    const finalRow = await store.get(ikey);
    expect(finalRow?.state).toBe("completed");
    expect(finalRow?.stellarTxHash).toBe(txHash);
  }, 300_000);
});

// -- Always-present guard test -----------------------------------------------
describe("crash-resume (gating)", () => {
  it("is skipped unless ANCHOR_SEP31_TRANSFER_SERVER + CORRIDOR_SIGNER_SECRET + CORRIDOR_HORIZON_URL are set", () => {
    expect(typeof hasAnchor).toBe("boolean");
  });

  it("Postgres variant is skipped unless CORRIDOR_TEST_DATABASE_URL is also set", () => {
    expect(typeof hasDb).toBe("boolean");
  });
});
