// PostgresAuditSink against a recording fake DB: the column mapping and the
// duplicate guard, without a server. tests/integration/audit-pg.test.ts runs the
// same sink against real Postgres.

import { describe, expect, it } from "vitest";
import {
  CREATE_AUDIT_TABLE_SQL,
  PostgresAuditSink,
  migrate,
  type Queryable,
} from "@corridor/engine";

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Queryable = {
    async query<R>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows: rows as R[] };
    },
  };
  return { db, calls };
}

describe("PostgresAuditSink", () => {
  it("maps an entry onto the fixed columns and keeps the rest in detail", async () => {
    const { db, calls } = fakeDb();
    await new PostgresAuditSink(db).record({
      idempotencyKey: "k",
      corridorId: "c",
      from: "settling",
      to: "settled",
      version: 6,
      at: 1_700_000_000_000,
      routeTrust: "attested",
      networkFee: "100",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/insert into corridor_audit/);
    expect(calls[0]!.text).toMatch(
      /on conflict on constraint corridor_audit_transition_once do nothing/,
    );
    expect(calls[0]!.params).toEqual([
      "k",
      "c",
      "settling",
      "settled",
      6,
      1_700_000_000_000,
      null,
      null,
      JSON.stringify({ routeTrust: "attested", networkFee: "100" }),
    ]);
  });

  it("stores no detail when an entry has only the fixed fields", async () => {
    const { db, calls } = fakeDb();
    await new PostgresAuditSink(db).record({
      idempotencyKey: "k",
      corridorId: "c",
      from: "created",
      to: "failed",
      version: 1,
      at: 0,
      error: "QUOTE_EXPIRED: late",
    });
    expect(calls[0]!.params!.slice(6)).toEqual(["QUOTE_EXPIRED: late", null, null]);
  });

  it("reads rows back as entries, in the order the query returns them", async () => {
    const { db, calls } = fakeDb([
      {
        idempotency_key: "k",
        corridor_id: "c",
        from_state: "created",
        to_state: "quoted",
        version: 1,
        at: new Date(1000),
        error: null,
        request_id: null,
        detail: null,
      },
      {
        idempotency_key: "k",
        corridor_id: "c",
        from_state: "quoted",
        to_state: "failed",
        version: 2,
        at: "1970-01-01T00:00:02.000Z",
        error: "boom",
        request_id: "req-1",
        detail: '{"routeTrust":"manifest"}',
      },
    ]);
    const got = await new PostgresAuditSink(db).listAudit("k");
    expect(calls[0]!.text).toMatch(/order by version asc, id asc/);
    expect(calls[0]!.params).toEqual(["k"]);
    expect(got).toEqual([
      {
        idempotencyKey: "k",
        corridorId: "c",
        from: "created",
        to: "quoted",
        version: 1,
        at: 1000,
      },
      {
        idempotencyKey: "k",
        corridorId: "c",
        from: "quoted",
        to: "failed",
        version: 2,
        at: 2000,
        error: "boom",
        requestId: "req-1",
        routeTrust: "manifest",
      },
    ]);
  });

  it("propagates a failed write, so execute() stops instead of running unaudited", async () => {
    const db: Queryable = {
      async query() {
        throw new Error("connection terminated");
      },
    };
    await expect(
      new PostgresAuditSink(db).record({
        idempotencyKey: "k",
        corridorId: "c",
        from: "verifying",
        to: "settling",
        version: 5,
        at: 0,
      }),
    ).rejects.toThrow("connection terminated");
  });

  it("is created by migrate()", async () => {
    const { db, calls } = fakeDb();
    await migrate(db);
    expect(calls.map((c) => c.text)).toContain(CREATE_AUDIT_TABLE_SQL);
  });
});
