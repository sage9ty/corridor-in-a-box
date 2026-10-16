// Integration test for PostgresIdempotencyStore against a REAL Postgres.
//
// The unit tests (tests/idempotency.test.ts) exercise the store against a
// hand-written fake DB. This file runs the same SQL — the atomic claim and the
// version-guarded upsert, the two pieces that actually protect against
// double-settlement — against a live server, so we know the real `INSERT … ON
// CONFLICT` semantics match our assumptions.
//
// It is opt-in: skipped unless CORRIDOR_TEST_DATABASE_URL is set. CI provides a
// Postgres service container (see .github/workflows/ci.yml). Locally:
//
//   docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
//   CORRIDOR_TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres \
//     pnpm exec vitest run tests/integration/idempotency-pg.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresIdempotencyStore,
  migrate,
  type Queryable,
  type StoredRun,
} from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("PostgresIdempotencyStore (live Postgres)", () => {
  // `pg.Pool` satisfies the structural `Queryable` shape; import lazily so the
  // suite doesn't require a running DB (or even pg) when the env var is unset.
  let pool: { query: Queryable["query"]; end: () => Promise<void> };

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url }) as unknown as typeof pool;
    await migrate(pool as unknown as Queryable);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from corridor_runs");
  });

  const store = () => new PostgresIdempotencyStore(pool as unknown as Queryable);
  const newRun = (key: string): StoredRun => ({
    idempotencyKey: key,
    corridorId: "c",
    state: "created",
    version: 0,
  });

  it("create() claims a key exactly once", async () => {
    const s = store();
    expect(await s.create(newRun("k1"))).toBe(true);
    expect(await s.create(newRun("k1"))).toBe(false);
    const got = await s.get("k1");
    expect(got?.state).toBe("created");
    expect(got?.version).toBe(0);
  });

  it("only ONE of many concurrent create() calls wins the claim", async () => {
    const s = store();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => s.create(newRun("race"))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("put() enforces optimistic concurrency on version", async () => {
    const s = store();
    await s.create(newRun("k2"));
    await s.put({ idempotencyKey: "k2", corridorId: "c", state: "settled", version: 5 });
    // A stale writer at a lower version must be ignored, not clobber the row.
    await s.put({ idempotencyKey: "k2", corridorId: "c", state: "settling", version: 3 });
    const got = await s.get("k2");
    expect(got?.state).toBe("settled");
    expect(got?.version).toBe(5);
  });

  it("persists and reads back refund_pending against real Postgres", async () => {
    // The state column is plain text with no CHECK constraint, so the new
    // state needs no migration — asserted here rather than assumed.
    const s = store();
    await s.create(newRun("k-rp"));
    await s.put({
      idempotencyKey: "k-rp",
      corridorId: "c",
      state: "refund_pending",
      version: 2,
      stellarTxHash: "hash_rp",
    });
    const got = await s.get("k-rp");
    expect(got?.state).toBe("refund_pending");
    expect(got?.stellarTxHash).toBe("hash_rp");
  });

  it("round-trips refundId", async () => {
    const s = store();
    await s.create(newRun("k-refund"));
    await s.put({
      idempotencyKey: "k-refund",
      corridorId: "c",
      state: "refunded",
      version: 3,
      stellarTxHash: "hash_out",
      refundId: "hash_back",
    });
    const got = await s.get("k-refund");
    expect(got?.refundId).toBe("hash_back");
    // A run with no refund reads back undefined, not null or "".
    await s.create(newRun("k-no-refund"));
    expect((await s.get("k-no-refund"))?.refundId).toBeUndefined();
  });

  it("never lets a later write erase a stored refundId", async () => {
    // The stored id is the evidence that stops a second refund. A writer that
    // lost it — an older in-memory copy of the run — must not be able to clear
    // it, or the next resume would request the refund again.
    const s = store();
    await s.create(newRun("k-keep"));
    await s.put({
      idempotencyKey: "k-keep",
      corridorId: "c",
      state: "refunded",
      version: 2,
      refundId: "hash_back",
    });
    await s.put({
      idempotencyKey: "k-keep",
      corridorId: "c",
      state: "refunded",
      version: 3,
      refundId: undefined,
    });
    expect((await s.get("k-keep"))?.refundId).toBe("hash_back");
  });

  it("adds refund_id to a table created by the previous version", async () => {
    // The upgrade path, against a real server: build the pre-change table
    // exactly as it was, run migrate(), and check the column arrives. This is
    // what `add column if not exists` in ALTER_TABLE_SQL buys — a no-op on a
    // fresh table, the whole migration on an existing one. Putting the column
    // only in CREATE_TABLE_SQL would leave every existing deployment without
    // it, silently.
    await pool.query("drop table if exists corridor_resolutions");
    await pool.query("drop table if exists corridor_runs");
    await pool.query(`
      create table corridor_runs (
        idempotency_key text primary key,
        corridor_id     text not null,
        state           text not null,
        version         integer not null,
        transaction_id  text,
        quote_id        text,
        stellar_tx_hash text,
        last_error      text,
        owner           text,
        updated_at      timestamptz not null default now()
      );`);
    await pool.query(
      `insert into corridor_runs (idempotency_key, corridor_id, state, version)
       values ('legacy', 'c', 'settled', 1)`,
    );

    await migrate(pool as unknown as Queryable);

    const s = store();
    // The pre-existing row survives and simply has no refund.
    expect((await s.get("legacy"))?.refundId).toBeUndefined();
    // And the column is really there — a write through it round-trips.
    await s.put({
      idempotencyKey: "legacy",
      corridorId: "c",
      state: "refunded",
      version: 2,
      refundId: "hash_back",
    });
    expect((await s.get("legacy"))?.refundId).toBe("hash_back");
  });

  it("round-trips all columns and maps NULLs to undefined", async () => {
    const s = store();
    await s.create(newRun("k3"));
    await s.put({
      idempotencyKey: "k3",
      corridorId: "c",
      state: "settled",
      version: 2,
      transactionId: "tx_1",
      stellarTxHash: "hash_1",
    });
    const got = await s.get("k3");
    expect(got).toMatchObject({
      idempotencyKey: "k3",
      state: "settled",
      version: 2,
      transactionId: "tx_1",
      stellarTxHash: "hash_1",
    });
    expect(got?.quoteId).toBeUndefined();
    expect(got?.refundId).toBeUndefined();
    expect(got?.lastError).toBeUndefined();
  });
});
