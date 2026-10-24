// Durable, append-only audit trail backed by SQL (Postgres).
//
// InMemoryAuditLog loses the trail on every restart, which defeats the point of
// an audit log: answering "what happened to this payment, and when" after the
// fact. This sink writes one row per state transition into `corridor_audit` and
// never updates or deletes one. Append-only is enforced at the database too, by
// running the service as a role with INSERT/SELECT only on the table (see
// docs/operations.md, "Database migrations").
//
// Same tiny `Queryable` seam as idempotency-pg.ts — we depend on the shape, not
// on `pg`, so the library does not force a driver on consumers.
//
// When a write fails, record() throws and execute() stops there. That is
// deliberate: the run's new state is already persisted, so the payment halts
// before its next side effect rather than moving money with no audit record,
// and a later resume carries on from the stored state. The transition whose
// write failed is not re-recorded on resume; it shows up as a gap in `version`
// for that key, which listAudit() makes easy to spot.

import type { Queryable } from "./idempotency-pg";
import type { AuditEntry, AuditSink } from "./observability";
import type { CorridorState } from "./state";

/**
 * One row per transition. The unique key makes a retried write of the same
 * transition a no-op, and its index (leading with idempotency_key, version) is
 * the one listAudit() reads, so no second index is needed.
 *
 * Fields beyond the fixed columns (route trust, fees, gate checks) go in
 * `detail` as JSON so the durable trail carries everything the in-memory one
 * does. The table is created by the engine's single `migrate()` entry point.
 */
export const CREATE_AUDIT_TABLE_SQL = `
create table if not exists corridor_audit (
  id              bigserial primary key,
  idempotency_key text not null,
  corridor_id     text not null,
  from_state      text not null,
  to_state        text not null,
  version         integer not null,
  at              timestamptz not null,
  error           text,
  request_id      text,
  detail          jsonb,
  constraint corridor_audit_transition_once unique (idempotency_key, version, to_state)
);`;

const FIXED = new Set([
  "idempotencyKey",
  "corridorId",
  "from",
  "to",
  "version",
  "at",
  "error",
  "requestId",
]);

interface Row {
  idempotency_key: string;
  corridor_id: string;
  from_state: string;
  to_state: string;
  version: number;
  at: Date | string;
  error: string | null;
  request_id: string | null;
  detail: Record<string, unknown> | string | null;
}

function toEntry(r: Row): AuditEntry {
  // pg parses jsonb; a driver that returns text gets parsed here instead.
  const detail = typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail;
  return {
    ...detail,
    idempotencyKey: r.idempotency_key,
    corridorId: r.corridor_id,
    from: r.from_state as CorridorState,
    to: r.to_state as CorridorState,
    version: r.version,
    at: new Date(r.at).getTime(),
    ...(r.error != null && { error: r.error }),
    ...(r.request_id != null && { requestId: r.request_id }),
  };
}

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly db: Queryable) {}

  /**
   * Append one transition. `on conflict do nothing` makes a retried write of
   * the same (key, version, to_state) a no-op instead of a duplicate row or an
   * error. Throws when the database does, which stops execute() (see above).
   */
  async record(entry: AuditEntry): Promise<void> {
    const extra = Object.fromEntries(Object.entries(entry).filter(([k]) => !FIXED.has(k)));
    await this.db.query(
      `insert into corridor_audit
         (idempotency_key, corridor_id, from_state, to_state, version, at, error, request_id, detail)
       values ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7, $8, $9)
       on conflict on constraint corridor_audit_transition_once do nothing`,
      [
        entry.idempotencyKey,
        entry.corridorId,
        entry.from,
        entry.to,
        entry.version,
        entry.at,
        entry.error ?? null,
        typeof entry.requestId === "string" ? entry.requestId : null,
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
      ],
    );
  }

  /** Every recorded transition for one payment, oldest first. For ops tooling. */
  async listAudit(idempotencyKey: string): Promise<AuditEntry[]> {
    const res = await this.db.query<Row>(
      `select idempotency_key, corridor_id, from_state, to_state, version, at,
              error, request_id, detail
         from corridor_audit where idempotency_key = $1
        order by version asc, id asc`,
      [idempotencyKey],
    );
    return res.rows.map(toEntry);
  }
}
