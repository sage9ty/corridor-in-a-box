// Integration test for PostgresAuditSink against a REAL Postgres.
//
// Opt-in, like idempotency-pg.test.ts: skipped unless CORRIDOR_TEST_DATABASE_URL
// is set. CI provides a Postgres service container (.github/workflows/ci.yml).
// Locally:
//
//   docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
//   CORRIDOR_TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres \
//     pnpm exec vitest run tests/integration/audit-pg.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAuditSink,
  migrate,
  type AuditEntry,
  type CorridorState,
  type Queryable,
} from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("PostgresAuditSink (live Postgres)", () => {
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
    await pool.query("delete from corridor_audit");
  });

  const sink = () => new PostgresAuditSink(pool as unknown as Queryable);
  const t0 = Date.parse("2026-10-21T12:00:00Z");
  const entry = (
    key: string,
    from: CorridorState,
    to: CorridorState,
    version: number,
    extra: Partial<AuditEntry> = {},
  ): AuditEntry => ({
    idempotencyKey: key,
    corridorId: "c",
    from,
    to,
    version,
    at: t0 + version * 1000,
    ...extra,
  });

  it("returns a payment's entries in transition order", async () => {
    const s = sink();
    // Written out of order: listAudit orders by version, not by insertion.
    await s.record(entry("k1", "quoted", "compliant", 2));
    await s.record(entry("k1", "created", "quoted", 1));
    await s.record(entry("k1", "compliant", "opened", 3));
    await s.record(entry("other", "created", "quoted", 1));

    const got = await s.listAudit("k1");
    expect(got.map((e) => [e.from, e.to, e.version])).toEqual([
      ["created", "quoted", 1],
      ["quoted", "compliant", 2],
      ["compliant", "opened", 3],
    ]);
    expect(got[0]!.at).toBe(t0 + 1000);
  });

  it("ignores a duplicate write of the same transition", async () => {
    const s = sink();
    const e = entry("k-dup", "created", "quoted", 1);
    await s.record(e);
    await s.record(e);
    await Promise.all(Array.from({ length: 10 }, () => s.record(e)));

    expect(await s.listAudit("k-dup")).toHaveLength(1);
  });

  it("round-trips the error and the extra fields", async () => {
    const s = sink();
    await s.record(
      entry("k-detail", "verifying", "failed", 5, {
        error: "PRESETTLE_AMOUNT_OUT_OF_RANGE: above max",
        routeTrust: "manifest",
        networkFee: "100",
        checks: [
          {
            name: "limits.amount",
            passed: false,
            code: "PRESETTLE_AMOUNT_OUT_OF_RANGE",
            detail: "amount 20000 above max 10000",
            durationMs: 1,
          },
        ],
      }),
    );
    const [got] = await s.listAudit("k-detail");
    expect(got).toMatchObject({
      error: "PRESETTLE_AMOUNT_OUT_OF_RANGE: above max",
      routeTrust: "manifest",
      networkFee: "100",
      checks: [
        { name: "limits.amount", passed: false, code: "PRESETTLE_AMOUNT_OUT_OF_RANGE" },
      ],
    });
  });

  it("is append-only for a role granted INSERT/SELECT (docs/operations.md)", async () => {
    // The grants documented for the service role, applied to a throwaway role.
    const role = "corridor_audit_test_writer";
    await pool.query(`drop role if exists ${role}`);
    await pool.query(`create role ${role}`);
    try {
      await pool.query(`grant select, insert on corridor_audit to ${role}`);
      await pool.query(`grant usage on sequence corridor_audit_id_seq to ${role}`);
      await sink().record(entry("k-ro", "created", "quoted", 1));

      // One client, so `set role` applies to every statement that follows.
      const { Client } = await import("pg");
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`set role ${role}`);
        await new PostgresAuditSink(client).record(entry("k-ro", "quoted", "compliant", 2));
        await expect(
          client.query("update corridor_audit set error = 'x' where idempotency_key = 'k-ro'"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          client.query("delete from corridor_audit where idempotency_key = 'k-ro'"),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.end();
      }
      expect(await sink().listAudit("k-ro")).toHaveLength(2);
    } finally {
      await pool.query(`revoke all on corridor_audit from ${role}`);
      await pool.query(`revoke all on sequence corridor_audit_id_seq from ${role}`);
      await pool.query(`drop role ${role}`);
    }
  });
});
