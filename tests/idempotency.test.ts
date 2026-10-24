import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  createMockSubmitter,
  execute,
  hasRequestedRefund,
  migrate,
  type EngineDeps,
  type Queryable,
  type QueryResult,
  type StoredRun,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "resume-1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function deps(store: InMemoryIdempotencyStore): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: store,
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
  };
}

describe("crash resume", () => {
  it("resumes a run persisted in 'settled' by reconciling, then completing", async () => {
    const store = new InMemoryIdempotencyStore();
    // Simulate a crash right after the on-chain payment but before reconcile.
    await store.put({
      idempotencyKey: "resume-1",
      corridorId: "test",
      state: "settled",
      version: 5,
      transactionId: "tx_crashed",
      stellarTxHash: "mocktx0001",
    });

    const r = await execute(intent, corridor(), deps(store));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.transactionId).toBe("tx_crashed");
      expect(r.value.trail).toEqual(["settled", "reconciled", "completed"]);
    }
  });

  it("does NOT auto-resume an ambiguous 'settling' run (no double-settle)", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "resume-1",
      corridorId: "test",
      state: "settling",
      version: 4,
    });
    const r = await execute(intent, corridor(), deps(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("concurrent claim", () => {
  it("two concurrent runs of the same key settle exactly once", async () => {
    const store = new InMemoryIdempotencyStore();
    // Count how many times the submitter actually moves money. A correct gate
    // lets exactly one of the two concurrent runs reach settle().
    let settlements = 0;
    const submitter = createMockSubmitter();
    const counting = {
      ...submitter,
      submit: (req: Parameters<typeof submitter.submit>[0]) => {
        settlements += 1;
        return submitter.submit(req);
      },
    };
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: counting,
      idempotency: store,
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const [a, b] = await Promise.all([
      execute(intent, corridor(), d),
      execute(intent, corridor(), d),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const loser = outcomes.find((r) => !r.ok);
    expect(loser && !loser.ok && loser.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(settlements).toBe(1);
  });
});

describe("held run resolution", () => {
  it("lists only held runs with limits and corridor filtering", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({ idempotencyKey: "held-a", corridorId: "a", state: "held", version: 4 });
    await store.put({ idempotencyKey: "held-b", corridorId: "b", state: "held", version: 2 });
    await store.put({
      idempotencyKey: "done",
      corridorId: "a",
      state: "completed",
      version: 8,
    });

    expect(await store.listByState("held", { corridorId: "a" })).toMatchObject([
      { idempotencyKey: "held-a", state: "held" },
    ]);
    expect(await store.listByState("held", { limit: 1 })).toHaveLength(1);
  });

  it("records one append-only resolution for a held run only", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({ idempotencyKey: "held", corridorId: "a", state: "held", version: 4 });
    await store.put({
      idempotencyKey: "done",
      corridorId: "a",
      state: "completed",
      version: 8,
    });
    const resolution = {
      idempotencyKey: "held",
      outcome: "refunded-offchain" as const,
      note: "Operations confirmed bank refund",
      resolvedBy: "operator-1",
      resolvedAt: 1700000000000,
    };

    expect(await store.recordResolution(resolution)).toBe(true);
    expect(await store.recordResolution(resolution)).toBe(false);
    expect(await store.recordResolution({ ...resolution, idempotencyKey: "done" })).toBe(
      false,
    );
    expect(await store.getResolution("held")).toEqual(resolution);
    expect((await store.get("held"))?.state).toBe("held");
  });
});

describe("PostgresIdempotencyStore.create", () => {
  it("claims a fresh key once and rejects a second claim", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    const run: StoredRun = {
      idempotencyKey: "k",
      corridorId: "c",
      state: "created",
      version: 0,
    };
    expect(await store.create(run)).toBe(true);
    expect(await store.create(run)).toBe(false);
    // The losing claim must not have clobbered the row.
    const got = await store.get("k");
    expect(got?.state).toBe("created");
    expect(got?.version).toBe(0);
  });
});

// A tiny in-memory fake that honours the version-guarded upsert semantics of the
// real SQL, so we can test PostgresIdempotencyStore's mapping + concurrency rule
// without a live database.
function fakeDb(): Queryable & { table: Map<string, Record<string, unknown>> } {
  const table = new Map<string, Record<string, unknown>>();
  return {
    table,
    async query<R = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (text.trimStart().startsWith("select")) {
        const row = table.get(params[0] as string);
        return { rows: (row ? [row] : []) as R[] };
      }
      const key = params[0] as string;
      const incoming = {
        idempotency_key: key,
        corridor_id: params[1],
        state: params[2],
        version: params[3] as number,
        transaction_id: params[4],
        source_transaction_id: params[5],
        quote_id: params[6],
        quote_expires_at: params[7],
        quote_firm: params[8],
        settlement_amount: params[9],
        stellar_tx_hash: params[10],
        settlement_kind: params[11],
        settlement_ref: params[12],
        deposit_address: params[13],
        memo: params[14],
        memo_type: params[15],
        refund_id: params[16],
        last_error: params[17],
        owner: params[18],
        settlement: params[19],
        manifest_hash: params[20],
      };
      // create(): INSERT … ON CONFLICT DO NOTHING RETURNING — only the first
      // writer for a key lands a row and gets it back; a conflict returns [].
      if (text.includes("do nothing")) {
        if (table.has(key)) return { rows: [] as R[] };
        table.set(key, incoming);
        return { rows: [{ idempotency_key: key }] as R[] };
      }
      // put(): upsert with version guard. `refund_id` is coalesced, not
      // overwritten, mirroring the real SQL: once a refund has been requested
      // the stored id must survive a writer that lost it.
      const current = table.get(key);
      if (!current || (current.version as number) < incoming.version) {
        table.set(key, {
          ...incoming,
          settlement_kind: incoming.settlement_kind ?? current?.settlement_kind,
          settlement_ref: incoming.settlement_ref ?? current?.settlement_ref,
          refund_id: current?.refund_id ?? incoming.refund_id,
          manifest_hash: current?.manifest_hash ?? incoming.manifest_hash,
        });
      }
      return { rows: [] as R[] };
    },
  };
}

describe("state round-trips", () => {
  // refund_pending is just a string to both stores — but a run parked in it
  // is a run with money in motion, so "it comes back exactly as written and
  // still reads as non-terminal" is asserted rather than assumed.
  it("InMemoryIdempotencyStore persists and reads back refund_pending", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "k-rp",
      corridorId: "c",
      state: "refund_pending",
      version: 4,
      stellarTxHash: "hash_rp",
    });
    const got = await store.get("k-rp");
    expect(got?.state).toBe("refund_pending");
    expect(got?.stellarTxHash).toBe("hash_rp");
  });

  it("PostgresIdempotencyStore persists and reads back refund_pending", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    await store.put({
      idempotencyKey: "k-rp",
      corridorId: "c",
      state: "refund_pending",
      version: 4,
      stellarTxHash: "hash_rp",
    });
    const got = await store.get("k-rp");
    expect(got?.state).toBe("refund_pending");
    expect(got?.stellarTxHash).toBe("hash_rp");
  });

  it("PostgresIdempotencyStore persists the source deposit reference", async () => {
    const store = new PostgresIdempotencyStore(fakeDb());
    await store.put({
      idempotencyKey: "k-source",
      corridorId: "c",
      state: "funding",
      version: 2,
      sourceTransactionId: "source-deposit-1",
    });
    expect((await store.get("k-source"))?.sourceTransactionId).toBe("source-deposit-1");
  });

  it("in-memory store never erases or replaces a source deposit reference", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "k-source-keep",
      corridorId: "c",
      state: "funding",
      version: 2,
      sourceTransactionId: "source-deposit-1",
    });
    await store.put({
      idempotencyKey: "k-source-keep",
      corridorId: "c",
      state: "funded",
      version: 3,
    });
    await store.put({
      idempotencyKey: "k-source-keep",
      corridorId: "c",
      state: "funded",
      version: 4,
      sourceTransactionId: "source-deposit-2",
    });
    expect((await store.get("k-source-keep"))?.sourceTransactionId).toBe("source-deposit-1");
  });
});

describe("hasRequestedRefund", () => {
  it("is the gate the refund request path asks before issuing another", () => {
    expect(hasRequestedRefund({ refundId: "hash_back" })).toBe(true);
    expect(hasRequestedRefund({})).toBe(false);
    expect(hasRequestedRefund({ refundId: undefined })).toBe(false);
    // An empty id is not evidence of anything.
    expect(hasRequestedRefund({ refundId: "" })).toBe(false);
  });
});

describe("refund state round-trips", () => {
  // A run that records the payment but not the refund can request a second
  // refund after a crash — the same class of bug the idempotency gate exists
  // to prevent, one leg further on.
  it("InMemoryIdempotencyStore round-trips refundId", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 4,
      stellarTxHash: "hash_out",
      refundId: "hash_back",
    });
    expect((await store.get("k-rf"))?.refundId).toBe("hash_back");

    await store.create({
      idempotencyKey: "k-none",
      corridorId: "c",
      state: "created",
      version: 0,
    });
    expect((await store.get("k-none"))?.refundId).toBeUndefined();
  });

  it("PostgresIdempotencyStore round-trips refundId", async () => {
    const store = new PostgresIdempotencyStore(fakeDb());
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 4,
      stellarTxHash: "hash_out",
      refundId: "hash_back",
    });
    const got = await store.get("k-rf");
    expect(got?.refundId).toBe("hash_back");
    expect(got?.stellarTxHash).toBe("hash_out");
  });

  it("PostgresIdempotencyStore never lets a later write erase refundId", async () => {
    const store = new PostgresIdempotencyStore(fakeDb());
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 4,
      refundId: "hash_back",
    });
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 5,
    });
    expect((await store.get("k-rf"))?.refundId).toBe("hash_back");
  });

  it("ships the refund_id column in BOTH the create DDL and the additive migration", async () => {
    // Putting it only in CREATE_TABLE_SQL would leave every deployment that
    // predates this change without the column, silently — the `owner` column
    // is the precedent and the comment above ALTER_TABLE_SQL explains why.
    const seen: string[] = [];
    await migrate({
      async query(text: string) {
        seen.push(text);
        return { rows: [] };
      },
    });
    expect(seen[0]).toContain("refund_id");
    expect(
      seen.some((sql) => sql.includes("create table if not exists corridor_resolutions")),
    ).toBe(true);
    expect(seen.slice(1).join("\n")).toContain("add column if not exists refund_id");
    expect(seen[0]).toContain("deposit_address");
    expect(seen[0]).toContain("memo");
    expect(seen[0]).toContain("memo_type");
    expect(seen.slice(1).join("\n")).toContain("add column if not exists deposit_address");
    expect(seen.slice(1).join("\n")).toContain("add column if not exists memo");
    expect(seen.slice(1).join("\n")).toContain("add column if not exists memo_type");
  });

  it("ships resume data columns in create DDL and additive migrations", async () => {
    const seen: string[] = [];
    await migrate({
      async query(text: string) {
        seen.push(text);
        return { rows: [] };
      },
    });
    for (const column of [
      "quote_expires_at",
      "quote_firm",
      "settlement_amount",
      "deposit_address",
      "manifest_hash",
      "source_transaction_id",
      "settlement_kind",
      "settlement_ref",
    ]) {
      expect(seen[0]).toContain(column);
      expect(seen.slice(1).join("\n")).toContain(`add column if not exists ${column}`);
    }
  });
});

describe("PostgresIdempotencyStore", () => {
  it("queries held runs with parameterized filters and bounded limits", async () => {
    let captured = { text: "", params: [] as unknown[] };
    const db: Queryable = {
      async query(text, params = []) {
        captured = { text, params };
        return {
          rows: [
            {
              idempotency_key: "held-1",
              corridor_id: "corridor-a",
              state: "held",
              version: 4,
              transaction_id: null,
              quote_id: null,
              stellar_tx_hash: "tx-hash",
              refund_id: null,
              last_error: "needs operator",
              owner: null,
            },
          ] as never,
        };
      },
    };
    const store = new PostgresIdempotencyStore(db);
    const runs = await store.listByState("held", { corridorId: "corridor-a", limit: 20 });
    expect(captured.text).toContain("where state = $1 and corridor_id = $2");
    expect(captured.text).toContain("limit $3");
    expect(captured.params).toEqual(["held", "corridor-a", 20]);
    expect(runs[0]).toMatchObject({ idempotencyKey: "held-1", stellarTxHash: "tx-hash" });
  });

  it("inserts out-of-band resolutions only when the run is held", async () => {
    let captured = "";
    const db: Queryable = {
      async query(text) {
        captured = text;
        return { rows: [{ idempotency_key: "held-1" }] as never };
      },
    };
    const store = new PostgresIdempotencyStore(db);
    const inserted = await store.recordResolution({
      idempotencyKey: "held-1",
      outcome: "written-off",
      note: "approved",
      resolvedBy: "operator",
      resolvedAt: 1_700_000_000_000,
    });
    expect(inserted).toBe(true);
    expect(captured).toContain("state = 'held'");
    expect(captured).toContain("on conflict (idempotency_key) do nothing");
  });

  it("round-trips a run and maps null columns to undefined", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    const run: StoredRun = {
      idempotencyKey: "k",
      corridorId: "c",
      state: "settled",
      version: 2,
      transactionId: "tx",
    };
    await store.put(run);
    const got = await store.get("k");
    expect(got).toMatchObject({ idempotencyKey: "k", state: "settled", transactionId: "tx" });
    expect(got?.stellarTxHash).toBeUndefined();
    expect(got?.quoteId).toBeUndefined();
    expect(got?.depositAddress).toBeUndefined();
    expect(got?.memo).toBeUndefined();
    expect(got?.memoType).toBeUndefined();
  });

  it("round-trips depositAddress, memo, and memoType", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    const run: StoredRun = {
      idempotencyKey: "k-dep",
      corridorId: "c",
      state: "opened",
      version: 3,
      transactionId: "tx-dep",
      depositAddress: "GDEP123",
      memo: "memo-test",
      memoType: "text",
    };
    await store.put(run);
    const got = await store.get("k-dep");
    expect(got?.depositAddress).toBe("GDEP123");
    expect(got?.memo).toBe("memo-test");
    expect(got?.memoType).toBe("text");
  });

  it("round-trips quote and opened transaction data", async () => {
    const store = new PostgresIdempotencyStore(fakeDb());
    await store.put({
      idempotencyKey: "resume-data",
      corridorId: "c",
      state: "opened",
      version: 2,
      transactionId: "tx",
      quoteId: "quote",
      quoteExpiresAt: 1234,
      quoteFirm: true,
      settlementAmount: "10.00",
      depositAddress: "GDEST",
      memo: "memo",
      memoType: "hash",
    });
    expect(await store.get("resume-data")).toMatchObject({
      quoteExpiresAt: 1234,
      quoteFirm: true,
      settlementAmount: "10.00",
      depositAddress: "GDEST",
      memo: "memo",
      memoType: "hash",
    });
  });

  it("ignores a stale write with a lower version (optimistic concurrency)", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    await store.put({ idempotencyKey: "k", corridorId: "c", state: "reconciled", version: 6 });
    await store.put({ idempotencyKey: "k", corridorId: "c", state: "settling", version: 3 });
    const got = await store.get("k");
    expect(got?.state).toBe("reconciled");
    expect(got?.version).toBe(6);
  });

  it("round-trips manifestHash", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    const run: StoredRun = {
      idempotencyKey: "k-hash",
      corridorId: "c",
      state: "opened",
      version: 1,
      manifestHash: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    };
    await store.create(run);
    const got = await store.get("k-hash");
    expect(got?.manifestHash).toBe(
      "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    );
  });

  it("round-trips settlementKind and settlementRef for both adapter and stellar", async () => {
    const memoryStore = new InMemoryIdempotencyStore();
    const db = fakeDb();
    const pgStore = new PostgresIdempotencyStore(db);

    for (const store of [memoryStore, pgStore]) {
      // Adapter settlement
      await store.put({
        idempotencyKey: "run-adapter",
        corridorId: "c",
        state: "settled",
        version: 2,
        settlementKind: "adapter",
        settlementRef: {
          kind: "adapter",
          reference: "otc_998877",
          reportedAt: 1700000000000,
        },
      });
      const adapterRun = await store.get("run-adapter");
      expect(adapterRun?.settlementKind).toBe("adapter");
      expect(adapterRun?.settlementRef).toEqual({
        kind: "adapter",
        reference: "otc_998877",
        reportedAt: 1700000000000,
      });
      expect(adapterRun?.stellarTxHash).toBeUndefined();

      // Stellar settlement
      await store.put({
        idempotencyKey: "run-stellar",
        corridorId: "c",
        state: "settled",
        version: 2,
        stellarTxHash: "tx_hash_stellar_123",
        settlementKind: "stellar",
        settlementRef: {
          kind: "stellar",
          stellarTxHash: "tx_hash_stellar_123",
          ledger: 54321,
        },
      });
      const stellarRun = await store.get("run-stellar");
      expect(stellarRun?.settlementKind).toBe("stellar");
      expect(stellarRun?.stellarTxHash).toBe("tx_hash_stellar_123");
      expect(stellarRun?.settlementRef).toEqual({
        kind: "stellar",
        stellarTxHash: "tx_hash_stellar_123",
        ledger: 54321,
      });
    }
  });

  it("maps legacy Postgres row with only stellar_tx_hash to stellar SettlementRef", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    // Simulate pre-existing row in database with no settlement_kind or settlement_ref columns
    db.table.set("legacy-row", {
      idempotency_key: "legacy-row",
      corridor_id: "c",
      state: "settled",
      version: 1,
      stellar_tx_hash: "old_stellar_tx_hash",
      settlement_kind: null,
      settlement_ref: null,
    });

    const run = await store.get("legacy-row");
    expect(run?.stellarTxHash).toBe("old_stellar_tx_hash");
    expect(run?.settlementKind).toBe("stellar");
    expect(run?.settlementRef).toEqual({
      kind: "stellar",
      stellarTxHash: "old_stellar_tx_hash",
    });
  });
});
