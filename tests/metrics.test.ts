import { describe, expect, it } from "vitest";
// @ts-expect-error This JavaScript parser package does not publish TypeScript declarations.
import parsePrometheusTextFormat from "parse-prometheus-text-format";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  BREAKER_METRICS,
  InMemoryCorridorHealthStore,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  MeteredCorridorHealthStore,
  PostgresCorridorHealthStore,
  PrometheusMetrics,
  createMockSubmitter,
  execute,
  type CorridorHealthStore,
  type EngineDeps,
  type QueryResult,
  type Queryable,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  return buildCorridor("test");
}

/** `breaker` sets the halt threshold; 1 makes a single failure trip the lane. */
function buildCorridor(id: string, breaker?: number): Corridor {
  const r = parseCorridor({
    id,
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
    recovery: breaker === undefined ? {} : { breaker: { consecutive_failures: breaker } },
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
  idempotencyKey: "m1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function deps(
  metrics: InMemoryMetrics,
  adapterOpts = {},
  extra: { health?: CorridorHealthStore; failSubmit?: boolean } = {},
): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter({ failSubmit: extra.failSubmit }),
    idempotency: new InMemoryIdempotencyStore(),
    metrics,
    health: extra.health,
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
  };
}

describe("metrics", () => {
  it("records per-verb timings, transition counters, and a completed terminal", async () => {
    const m = new InMemoryMetrics();
    const r = await execute(intent, corridor(), deps(m));
    expect(r.ok).toBe(true);

    const timingNames = m.timings.map((t) => t.name);
    for (const verb of ["quote", "comply", "open", "settle", "reconcile"]) {
      expect(timingNames).toContain(`corridor.verb.${verb}`);
    }
    expect(timingNames).toContain("corridor.duration");

    // 8 transitions counted
    expect(m.counters.filter((c) => c.name === "corridor.transition")).toHaveLength(8);
    const terminal = m.counters.find((c) => c.name === "corridor.terminal");
    expect(terminal?.tags?.state).toBe("completed");
  });

  it("records gate timing and check counter metrics when gate is evaluated", async () => {
    const m = new InMemoryMetrics();
    const d = deps(m);
    d.gate = {
      async evaluate() {
        return {
          passed: true,
          results: [
            {
              name: "chain.balance",
              passed: true,
              detail: "sufficient",
              durationMs: 1,
            },
          ],
        };
      },
    };
    const r = await execute(intent, corridor(), d);
    expect(r.ok).toBe(true);

    const timingNames = m.timings.map((t) => t.name);
    expect(timingNames).toContain("corridor.verb.verify");

    const gateChecks = m.counters.filter((c) => c.name === "corridor.gate.check");
    expect(gateChecks).toHaveLength(1);
    expect(gateChecks[0].tags).toEqual({ name: "chain.balance", passed: "true" });
  });

  it("counts a failed terminal when a verb fails", async () => {
    const m = new InMemoryMetrics();
    const r = await execute(intent, corridor(), deps(m, { kyc: "rejected" }));
    expect(r.ok).toBe(false);
    const terminal = m.counters.find((c) => c.name === "corridor.terminal");
    expect(terminal?.tags?.state).toBe("failed");
  });
});

describe("PrometheusMetrics", () => {
  it("emits parser-readable counter and histogram families with HELP metadata", async () => {
    const m = new PrometheusMetrics();
    m.registerHelp("corridor.terminal", "Number of payments reaching a terminal state.");
    const r = await execute(intent, corridor(), deps(m as unknown as InMemoryMetrics));
    expect(r.ok).toBe(true);
    const parsed = parsePrometheusTextFormat(m.render()) as {
      name: string;
      type: string;
      help: string;
      metrics: Array<{
        value?: string;
        count?: string;
        sum?: string;
        buckets?: Record<string, string>;
        labels?: Record<string, string>;
      }>;
    }[];
    const counter = parsed.find((family) => family.name === "corridor_terminal");
    expect(counter).toMatchObject({
      type: "COUNTER",
      help: "Number of payments reaching a terminal state.",
    });
    expect(counter?.metrics.some((sample) => sample.labels?.state === "completed")).toBe(true);

    const histogram = parsed.find((family) => family.name === "corridor_verb_quote_seconds");
    expect(histogram).toMatchObject({
      type: "HISTOGRAM",
      help: "Duration of corridor_verb_quote operations in seconds.",
    });
    // The parser only surfaces _count/_sum for unlabelled series, so check the
    // labelled ones in the raw exposition.
    const text = m.render();
    expect(text).toMatch(/^corridor_verb_quote_seconds_count\{[^}]*\} 1$/m);
    expect(text).toMatch(/^corridor_verb_quote_seconds_sum\{[^}]*\} \S+$/m);
    expect(histogram?.metrics[0].buckets?.["+Inf"]).toBe("1");
  });

  it("aggregates repeated timing samples and emits cumulative buckets in seconds", () => {
    const m = new PrometheusMetrics({ buckets: [0.01, 0.025, 0.05] });
    m.increment("corridor.transition", { to: "settled" });
    m.increment("corridor.transition", { to: "settled" });
    m.timing("corridor.verb.settle", 10);
    m.timing("corridor.verb.settle", 30);
    const parsed = parsePrometheusTextFormat(m.render()) as {
      name: string;
      type: string;
      metrics: Array<{
        value?: string;
        count?: string;
        sum?: string;
        buckets?: Record<string, string>;
      }>;
    }[];
    expect(
      parsed.find((family) => family.name === "corridor_transition")?.metrics[0].value,
    ).toBe("2");
    const histogram = parsed.find((family) => family.name === "corridor_verb_settle_seconds");
    expect(histogram?.metrics[0]).toMatchObject({
      count: "2",
      sum: "0.04",
      buckets: { "0.01": "1", "0.025": "1", "0.05": "2", "+Inf": "2" },
    });
    const counts = Object.entries(histogram?.metrics[0].buckets ?? {})
      .filter(([bound]) => bound !== "+Inf")
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, count]) => Number(count));
    expect(counts.every((count, index) => index === 0 || count >= counts[index - 1])).toBe(
      true,
    );
  });

  it("escapes quotes, backslashes and newlines in label values for a real parser", () => {
    const m = new PrometheusMetrics();
    const labelValue = 'a"b\\c\nx';
    m.increment("e", { msg: labelValue });
    const parsed = parsePrometheusTextFormat(m.render()) as {
      name: string;
      metrics: Array<{ labels?: Record<string, string> }>;
    }[];
    expect(parsed.find((family) => family.name === "e")?.metrics[0].labels?.msg).toBe(
      labelValue,
    );
  });

  it("rejects invalid histogram bucket configurations", () => {
    expect(() => new PrometheusMetrics({ buckets: [0.1, 0.1] })).toThrow(
      /strictly increasing/,
    );
    expect(() => new PrometheusMetrics({ buckets: [0, 1] })).toThrow(/strictly increasing/);
  });
});

// The three series an alert can be built on. Each is a counter labelled by
// corridor, so `increase(corridor_breaker_tripped[15m]) > 0` is a page and
// `corridor_breaker_refused` shows how much traffic the halt turned away.
describe("circuit-breaker metrics", () => {
  it("renders tripped, refused and reset in Prometheus exposition format", async () => {
    const m = new PrometheusMetrics();
    const health = new MeteredCorridorHealthStore(new InMemoryCorridorHealthStore(), m);
    // Threshold 1: one settlement failure trips, the next run is refused.
    const c = buildCorridor("test", 1);
    // A fresh idempotency store per run — these are three different payments,
    // and reusing one would collide on the idempotency key instead.
    const run = (key: string) =>
      execute({ ...intent, idempotencyKey: key }, c, {
        ...deps(m as unknown as InMemoryMetrics, {}, { health, failSubmit: true }),
        idempotency: new InMemoryIdempotencyStore(),
      });

    const first = await run("b1");
    expect(first.ok).toBe(false);
    const second = await run("b2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CORRIDOR_HALTED");
    await health.reset("test", "ezedike", "anchor restored");

    const text = m.render();
    // Dots sanitise to underscores and the corridor becomes a label, exactly as
    // for every other series the engine emits.
    expect(text).toContain(`# TYPE ${sanitize(BREAKER_METRICS.tripped)} counter`);
    expect(text).toContain(`# TYPE ${sanitize(BREAKER_METRICS.refused)} counter`);
    expect(text).toContain(`# TYPE ${sanitize(BREAKER_METRICS.reset)} counter`);
    expect(text).toContain('corridor_breaker_tripped{corridor="test"} 1');
    expect(text).toContain('corridor_breaker_refused{corridor="test"} 1');
    expect(text).toContain('corridor_breaker_reset{corridor="test"} 1');
  });

  it("counts one trip per halt, not one per failure on the halted lane", async () => {
    const m = new InMemoryMetrics();
    const health = new InMemoryCorridorHealthStore();
    const c = buildCorridor("test", 2);
    const run = (key: string) =>
      execute({ ...intent, idempotencyKey: key }, c, {
        ...deps(m, {}, { health, failSubmit: true }),
        idempotency: new InMemoryIdempotencyStore(),
      });

    await run("t1"); // count 1
    await run("t2"); // count 2 -> trips
    await run("t3"); // refused
    await run("t4"); // refused
    const tripped = m.counters.filter((c) => c.name === BREAKER_METRICS.tripped);
    const refused = m.counters.filter((c) => c.name === BREAKER_METRICS.refused);
    // A counter that fired on every failure while halted would be useless in an
    // alert: it would fire forever on a lane nobody has fixed.
    expect(tripped).toHaveLength(1);
    expect(refused).toHaveLength(2);
    expect(tripped[0].tags).toEqual({ corridor: "test" });
  });

  it("emits no breaker series at all when no health store is wired", async () => {
    // Opt-in: a deployment that has not adopted the breaker must not grow a
    // permanently-zero series that looks like something is being measured.
    const m = new PrometheusMetrics();
    const r = await execute(intent, corridor(), deps(m as unknown as InMemoryMetrics));
    expect(r.ok).toBe(true);
    expect(m.render()).not.toContain("corridor_breaker_");
  });

  it("does not double-count when the application already wrapped the store", async () => {
    const m = new InMemoryMetrics();
    const health = new MeteredCorridorHealthStore(new InMemoryCorridorHealthStore(), m);
    const d: EngineDeps = {
      ...deps(m, {}, { health, failSubmit: true }),
      idempotency: new InMemoryIdempotencyStore(),
    };
    await execute(intent, buildCorridor("test", 1), d);
    expect(m.counters.filter((c) => c.name === BREAKER_METRICS.tripped)).toHaveLength(1);
  });

  it("counts a reset made through a Postgres store the same way", async () => {
    // The reset the CLI performs is a `reset()` on whatever store the deployment
    // uses; the meter must not care which one it is, or the counter would be
    // silently missing in exactly the deployments that reset most often.
    const m = new PrometheusMetrics();
    const pg = new PostgresCorridorHealthStore(stubDb());
    const health = new MeteredCorridorHealthStore(pg, m);
    await health.reset("ng-cn", "ezedike", "anchor restored", 1000);
    expect(m.render()).toContain('corridor_breaker_reset{corridor="ng-cn"} 1');
  });

  it("counts the trip when a Postgres lane trips on its first failure", async () => {
    // End of the chain the insert-path bug cut. The metered store increments
    // `tripped` only when `justTripped` matches, which needs `tripped_at` on
    // the row; a lane created by the INSERT branch used to come back `open`
    // with a null trip time, so with `consecutive_failures: 1` the counter
    // that the whole alert is built on stayed at zero for exactly the lanes
    // that trip on contact. The in-memory store stamped it, so nothing else
    // noticed.
    const m = new PrometheusMetrics();
    const health = new MeteredCorridorHealthStore(
      new PostgresCorridorHealthStore(fakeBreakerDb()),
      m,
    );
    const c = buildCorridor("test", 1);
    const r = await execute({ ...intent, idempotencyKey: "pg-trip" }, c, {
      ...deps(
        m as unknown as InMemoryMetrics,
        {},
        {
          health,
          failSubmit: true,
        },
      ),
      idempotency: new InMemoryIdempotencyStore(),
    });
    expect(r.ok).toBe(false);
    expect(m.render()).toContain('corridor_breaker_tripped{corridor="test"} 1');

    // And the lane is actually refusing the next run, which is the other half
    // of the operator promise.
    const second = await execute({ ...intent, idempotencyKey: "pg-trip-2" }, c, {
      ...deps(
        m as unknown as InMemoryMetrics,
        {},
        {
          health,
          failSubmit: true,
        },
      ),
      idempotency: new InMemoryIdempotencyStore(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CORRIDOR_HALTED");
    expect(m.render()).toContain('corridor_breaker_refused{corridor="test"} 1');
  });
});

/**
 * A `Queryable` that applies the store's upsert for real, including the part
 * that a stub cannot fake: a column missing from the INSERT list is absent, not
 * null, and so takes the table default. `tripped_at` defaults to NULL, which is
 * how the first-failure trip lost its timestamp.
 */
function fakeBreakerDb(): Queryable {
  interface Row {
    corridor_id: string;
    consecutive_failures: number;
    state: string;
    tripped_at: Date | null;
    last_error: string | null;
    reset_by: string | null;
    reset_reason: string | null;
    reset_at: Date | null;
    updated_at: Date;
  }
  const table = new Map<string, Row>();
  return {
    async query<R = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<R>> {
      // The gate reads the lane through `get()` before every run, so a fake
      // that only models upserts answers the wrong question and the second run
      // is quietly accepted.
      if (/^\s*select\b/i.test(text)) {
        const rows = text.includes("order by")
          ? [...table.values()]
          : [table.get(params[0] as string)].filter((r): r is Row => r !== undefined);
        return { rows: rows as R[] };
      }

      const current = table.get(params[0] as string);
      if (text.includes("reset_by = excluded.reset_by")) {
        const next: Row = {
          corridor_id: params[0] as string,
          consecutive_failures: 0,
          state: "closed",
          tripped_at: null,
          last_error: null,
          reset_by: params[1] as string,
          reset_reason: params[2] as string,
          reset_at: new Date(params[3] as number),
          updated_at: new Date(params[3] as number),
        };
        table.set(next.corridor_id, next);
        return { rows: [next as R] };
      }
      const failure = params[1] as boolean;
      const at = params[2] as number;
      const threshold = params[3] as number;
      const insertCols = /insert into corridor_breakers\s*\(([\s\S]*?)\)\s*values/i.exec(
        text,
      )?.[1];
      // `pg` hands a `timestamptz` back as a Date; `toMs` parses strings and
      // calls `getTime()` on Dates, so returning a raw epoch number here would
      // make every trip time NaN and hide the very thing under test.
      const next: Row = {
        corridor_id: params[0] as string,
        consecutive_failures: failure ? (current?.consecutive_failures ?? 0) + 1 : 0,
        state: "closed",
        tripped_at: current?.tripped_at ?? null,
        last_error: failure ? ((params[4] as string) ?? null) : (current?.last_error ?? null),
        reset_by: current?.reset_by ?? null,
        reset_reason: current?.reset_reason ?? null,
        reset_at: current?.reset_at ?? null,
        updated_at: new Date(at),
      };
      if (failure && next.consecutive_failures >= threshold) {
        next.state = "open";
        if (current?.state !== "open" && (current || insertCols?.includes("tripped_at"))) {
          next.tripped_at = new Date(at);
        }
      }
      table.set(next.corridor_id, next);
      return { rows: [next as R] };
    },
  };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Minimal Queryable: the metered store is what's under test, not the SQL. */
function stubDb(): Queryable {
  return {
    async query<R = Record<string, unknown>>(): Promise<QueryResult<R>> {
      return {
        rows: [
          {
            corridor_id: "ng-cn",
            consecutive_failures: 0,
            state: "closed",
            tripped_at: null,
            last_error: null,
            reset_by: "ezedike",
            reset_reason: "anchor restored",
            reset_at: new Date(1000),
            updated_at: new Date(1000),
          },
        ] as R[],
      };
    },
  };
}
