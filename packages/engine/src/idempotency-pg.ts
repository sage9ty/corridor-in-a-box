// Durable idempotency store backed by SQL (Postgres). In-memory is fine for
// tests/examples; production needs a row per idempotencyKey that survives a
// crash, with optimistic concurrency on `version` so two workers can't advance
// the same payment past each other.
//
// We depend only on a tiny `Queryable` shape rather than the `pg` package, so the
// open library doesn't force a driver on consumers — pass your `pg.Pool` (it
// satisfies this structurally) or any compatible client.

import type {
  IdempotencyStore,
  ListRunsOptions,
  OutOfBandResolution,
  StoredRun,
} from "./idempotency";
import type { CorridorState } from "./state";
// A value import, and the DDL for the breaker table lives with the store that
// uses it rather than being duplicated here. This file does not import
// breaker-pg's types, so there is no module cycle at runtime.
import { CREATE_BREAKERS_TABLE_SQL, BREAKERS_MIGRATION_SQL } from "./breaker-pg";

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** DDL for the runs table. Run once at startup (or via your migration tool). */
export const CREATE_TABLE_SQL = `
create table if not exists corridor_runs (
  idempotency_key text primary key,
  corridor_id     text not null,
  state           text not null,
  version         integer not null,
  transaction_id  text,
  quote_id        text,
  quote_expires_at bigint,
  quote_firm      boolean,
  settlement_amount text,
  stellar_tx_hash text,
  deposit_address text,
  memo            text,
  memo_type       text,
  refund_id       text,
  last_error      text,
  owner           text,
  settlement      text,
  updated_at      timestamptz not null default now()
);
`;

export const CREATE_RESOLUTIONS_TABLE_SQL = `
create table if not exists corridor_resolutions (
  idempotency_key text primary key references corridor_runs(idempotency_key),
  outcome         text not null check (outcome in ('refunded-offchain', 'paid-out-manually', 'written-off')),
  note            text not null,
  resolved_by     text not null,
  resolved_at     timestamptz not null
);`;

/** Additive migrations for tables created by an earlier version. `add column if
 *  not exists` is a no-op on a fresh table and the upgrade path on an existing
 *  one — without this, a deployment that predates run ownership would keep
 *  serving unscoped reads because the column silently isn't there. */
const ALTER_TABLE_SQL = [
  `alter table corridor_runs add column if not exists owner text;`,
  // Same reasoning as `owner`: a deployment created before refund state existed
  // must pick this up on migrate(), or every resumed run there would still have
  // no record of a refund it already requested.
  `alter table corridor_runs add column if not exists refund_id text;`,
  // Additive columns for deposit address and memo so resume can check Horizon
  // for pre-existing settlement payments.
  `alter table corridor_runs add column if not exists deposit_address text;`,
  `alter table corridor_runs add column if not exists memo text;`,
  `alter table corridor_runs add column if not exists memo_type text;`,
  // JSON of what the settle leg was asked to pay, so a resumed run can re-verify it on-chain.
  `alter table corridor_runs add column if not exists settlement text;`,
  `alter table corridor_runs add column if not exists quote_expires_at bigint;`,
  `alter table corridor_runs add column if not exists quote_firm boolean;`,
  `alter table corridor_runs add column if not exists settlement_amount text;`,
];

export async function migrate(db: Queryable): Promise<void> {
  await db.query(CREATE_TABLE_SQL);
  await db.query(CREATE_RESOLUTIONS_TABLE_SQL);
  for (const sql of ALTER_TABLE_SQL) await db.query(sql);
  // The circuit-breaker table ships from the same entry point on purpose. It is
  // one more `create table if not exists`, so a deployment that has not run
  // migrate() since upgrading would get breaker errors on every payment — the
  // kind of missing-migration failure that is only discovered in production.
  await db.query(CREATE_BREAKERS_TABLE_SQL);
  // Databases that ran migrate() between #366 and this change already have an
  // older `corridor_breakers` (no reset_at, states 'up'/'down'); the create above
  // is a no-op there, so upgrade it in place.
  for (const sql of BREAKERS_MIGRATION_SQL) await db.query(sql);
}

interface Row {
  idempotency_key: string;
  corridor_id: string;
  state: string;
  version: number;
  transaction_id: string | null;
  quote_id: string | null;
  quote_expires_at: number | string | null;
  quote_firm: boolean | null;
  settlement_amount: string | null;
  stellar_tx_hash: string | null;
  deposit_address: string | null;
  memo: string | null;
  memo_type: string | null;
  refund_id: string | null;
  last_error: string | null;
  owner: string | null;
  settlement: string | null;
}

function toRun(r: Row): StoredRun {
  return {
    idempotencyKey: r.idempotency_key,
    corridorId: r.corridor_id,
    state: r.state as CorridorState,
    version: r.version,
    transactionId: r.transaction_id ?? undefined,
    quoteId: r.quote_id ?? undefined,
    quoteExpiresAt: r.quote_expires_at == null ? undefined : Number(r.quote_expires_at),
    quoteFirm: r.quote_firm ?? undefined,
    settlementAmount: r.settlement_amount ?? undefined,
    stellarTxHash: r.stellar_tx_hash ?? undefined,
    depositAddress: r.deposit_address ?? undefined,
    memo: r.memo ?? undefined,
    memoType: (r.memo_type as StoredRun["memoType"]) ?? undefined,
    refundId: r.refund_id ?? undefined,
    lastError: r.last_error ?? undefined,
    owner: r.owner ?? undefined,
    settlement: r.settlement ? JSON.parse(r.settlement) : undefined,
  };
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Atomically claim a key for a new run. `ON CONFLICT DO NOTHING` makes the
   * insert a no-op when the key already exists; `RETURNING` then tells us whether
   * a row was actually written. A `false` return means another worker already
   * owns this key — the caller must NOT proceed to settle. This is the gate that
   * closes the get()-then-insert race where two concurrent callers could both
   * start (and both settle) the same payment.
   */
  async create(run: StoredRun): Promise<boolean> {
    const res = await this.db.query<{ idempotency_key: string }>(
      `insert into corridor_runs
         (idempotency_key, corridor_id, state, version, transaction_id,
          quote_id, quote_expires_at, quote_firm, settlement_amount,
          stellar_tx_hash, deposit_address, memo, memo_type,
          refund_id, last_error, owner, settlement, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       on conflict (idempotency_key) do nothing
       returning idempotency_key`,
      [
        run.idempotencyKey,
        run.corridorId,
        run.state,
        run.version,
        run.transactionId ?? null,
        run.quoteId ?? null,
        run.quoteExpiresAt ?? null,
        run.quoteFirm ?? null,
        run.settlementAmount ?? null,
        run.stellarTxHash ?? null,
        run.depositAddress ?? null,
        run.memo ?? null,
        run.memoType ?? null,
        run.refundId ?? null,
        run.lastError ?? null,
        run.owner ?? null,
        run.settlement ? JSON.stringify(run.settlement) : null,
      ],
    );
    return res.rows.length > 0;
  }

  async get(key: string): Promise<StoredRun | undefined> {
    const res = await this.db.query<Row>(
      `select idempotency_key, corridor_id, state, version, transaction_id,
              quote_id, quote_expires_at, quote_firm, settlement_amount,
              stellar_tx_hash, deposit_address, memo, memo_type,
              refund_id, last_error, owner, settlement
         from corridor_runs where idempotency_key = $1`,
      [key],
    );
    const row = res.rows[0];
    return row ? toRun(row) : undefined;
  }

  async listByState(
    state: CorridorState,
    options: ListRunsOptions = {},
  ): Promise<StoredRun[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const params: unknown[] = [state];
    const corridor = options.corridorId ? "and corridor_id = $2" : "";
    if (options.corridorId) params.push(options.corridorId);
    params.push(limit);
    const limitParam = `$${params.length}`;
    const result = await this.db.query<Row>(
      `select idempotency_key, corridor_id, state, version, transaction_id,
              quote_id, stellar_tx_hash, refund_id, last_error, owner
         from corridor_runs where state = $1 ${corridor}
        order by updated_at desc, idempotency_key asc limit ${limitParam}`,
      params,
    );
    return result.rows.map(toRun);
  }

  async getResolution(key: string): Promise<OutOfBandResolution | undefined> {
    const result = await this.db.query<{
      idempotency_key: string;
      outcome: OutOfBandResolution["outcome"];
      note: string;
      resolved_by: string;
      resolved_at: Date | string;
    }>(
      `select idempotency_key, outcome, note, resolved_by, resolved_at
         from corridor_resolutions where idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row
      ? {
          idempotencyKey: row.idempotency_key,
          outcome: row.outcome,
          note: row.note,
          resolvedBy: row.resolved_by,
          resolvedAt: new Date(row.resolved_at).getTime(),
        }
      : undefined;
  }

  async recordResolution(resolution: OutOfBandResolution): Promise<boolean> {
    const result = await this.db.query<{ idempotency_key: string }>(
      `insert into corridor_resolutions (idempotency_key, outcome, note, resolved_by, resolved_at)
       select $1, $2, $3, $4, to_timestamp($5 / 1000.0)
        where exists (
          select 1 from corridor_runs where idempotency_key = $1 and state = 'held'
        )
       on conflict (idempotency_key) do nothing
       returning idempotency_key`,
      [
        resolution.idempotencyKey,
        resolution.outcome,
        resolution.note,
        resolution.resolvedBy,
        resolution.resolvedAt,
      ],
    );
    return result.rows.length > 0;
  }

  /**
   * Upsert with optimistic concurrency: a write only lands if it carries a
   * strictly higher `version` than what's stored. A stale writer (e.g. a
   * resumed-then-superseded worker) is silently ignored, which is exactly the
   * double-advance protection we want.
   *
   * `owner` is deliberately absent from the `do update set` list: ownership is
   * established once by create() and must be immutable thereafter, or a later
   * write could quietly reassign a run to a different tenant.
   *
   * `refund_id` is coalesced rather than overwritten, for the same reason one
   * step further on: once a refund has been requested, the stored id is the
   * evidence that stops a second request. A writer that lost it (an older
   * in-memory copy of the run, say) must not be able to erase it — a *second*
   * refund id would mean money moved twice.
   */
  async put(run: StoredRun): Promise<void> {
    await this.db.query(
      `insert into corridor_runs
         (idempotency_key, corridor_id, state, version, transaction_id,
          quote_id, quote_expires_at, quote_firm, settlement_amount,
          stellar_tx_hash, deposit_address, memo, memo_type,
          refund_id, last_error, owner, settlement, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       on conflict (idempotency_key) do update set
         state           = excluded.state,
         version         = excluded.version,
         transaction_id  = excluded.transaction_id,
         quote_id        = excluded.quote_id,
         quote_expires_at = excluded.quote_expires_at,
         quote_firm      = excluded.quote_firm,
         settlement_amount = excluded.settlement_amount,
         stellar_tx_hash = excluded.stellar_tx_hash,
         deposit_address = excluded.deposit_address,
         memo            = excluded.memo,
         memo_type       = excluded.memo_type,
         refund_id       = coalesce(corridor_runs.refund_id, excluded.refund_id),
         last_error      = excluded.last_error,
         settlement      = coalesce(corridor_runs.settlement, excluded.settlement),
         updated_at      = now()
       where corridor_runs.version < excluded.version`,
      [
        run.idempotencyKey,
        run.corridorId,
        run.state,
        run.version,
        run.transactionId ?? null,
        run.quoteId ?? null,
        run.quoteExpiresAt ?? null,
        run.quoteFirm ?? null,
        run.settlementAmount ?? null,
        run.stellarTxHash ?? null,
        run.depositAddress ?? null,
        run.memo ?? null,
        run.memoType ?? null,
        run.refundId ?? null,
        run.lastError ?? null,
        run.owner ?? null,
        run.settlement ? JSON.stringify(run.settlement) : null,
      ],
    );
  }
}
