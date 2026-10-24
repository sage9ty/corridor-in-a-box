import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryAlerting,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  childLogger,
  createMockSubmitter,
  execute,
  reconcileUntil,
  scopedAuditSink,
  type CheckResult,
  type EngineDeps,
  type Logger,
  type LogFields,
  type PreSettleGate,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(recovery: Record<string, unknown> = {}): Corridor {
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
    recovery,
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
  idempotencyKey: "obs-1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

describe("audit trail", () => {
  it("records one immutable entry per state transition, in order", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      now: () => 1700000000000,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(true);

    // created -> quoted -> compliant -> opened -> verifying -> settling -> settled
    //   -> reconciled -> completed = 8 transitions
    expect(audit.entries.map((e) => e.to)).toEqual([
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "reconciled",
      "completed",
    ]);
    expect(audit.entries[0]).toMatchObject({
      idempotencyKey: "obs-1",
      corridorId: "test",
      from: "created",
      to: "quoted",
      at: 1700000000000,
      routeTrust: "manifest",
    });
    // versions are monotonic
    const versions = audit.entries.map((e) => e.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it("records the error on a failing transition", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ kyc: "rejected" }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(false);
    const failed = audit.entries.find((e) => e.to === "failed");
    expect(failed?.error).toContain("KYC_REJECTED");
  });
});

const heldCorridor = () =>
  corridor({ max_retries: 0, timeout_seconds: 3600, rollback: "hold" });

describe("operational alerts", () => {
  it("raises one alert when a run enters held", async () => {
    const alerting = new InMemoryAlerting();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      alerting,
      now: () => 1000,
      sleep: async () => {},
      reconcilePollMs: 1,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const result = await execute(
      { ...intent, idempotencyKey: "held-alert" },
      heldCorridor(),
      deps,
    );

    expect(result.ok).toBe(false);
    expect(alerting.alerts).toHaveLength(1);
    expect(alerting.alerts[0]).toMatchObject({
      kind: "held",
      corridorId: "test",
      idempotencyKey: "held-alert",
      at: expect.any(Number),
    });
  });

  it("does not re-alert when a run already held is resumed with the same key", async () => {
    const alerting = new InMemoryAlerting();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      alerting,
      now: () => 1000,
      sleep: async () => {},
      reconcilePollMs: 1,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const held = { ...intent, idempotencyKey: "held-resume" };
    await execute(held, heldCorridor(), deps);
    expect(await deps.idempotency?.get("held-resume")).toMatchObject({ state: "held" });
    expect(alerting.alerts.filter((a) => a.kind === "held")).toHaveLength(1);

    const resumed = await execute(held, heldCorridor(), deps);
    expect(resumed.ok).toBe(false);
    expect(alerting.alerts.filter((a) => a.kind === "held")).toHaveLength(1);
    expect(alerting.alerts).toHaveLength(1);
  });

  it("keeps the run outcome when the alert sink throws", async () => {
    const logs: { level: string; msg: string }[] = [];
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      alerting: {
        raise: () => {
          throw new Error("webhook unavailable");
        },
      },
      logger: { log: (level, msg) => logs.push({ level, msg }) },
      now: () => 1000,
      sleep: async () => {},
      reconcilePollMs: 1,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const result = await execute(
      { ...intent, idempotencyKey: "held-alert-fails" },
      heldCorridor(),
      deps,
    );

    expect(result.ok).toBe(false);
    expect(await deps.idempotency?.get("held-alert-fails")).toMatchObject({ state: "held" });
    expect(logs).toContainEqual({ level: "warn", msg: "corridor.alert_failed" });
  });
});

describe("reconcile polling observability", () => {
  it("emits a debug log and metric increment on every poll", async () => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      log(level: string, msg: string, fields?: Record<string, unknown>) {
        logs.push({ level, msg, fields });
      },
    };
    const metrics = new InMemoryMetrics();

    // Adapter returns pending twice before settled
    let pollCount = 0;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async (_id: string) => {
        pollCount += 1;
        if (pollCount < 3) {
          return {
            ok: true as const,
            value: {
              status: "pending_sender",
              settled: false,
              terminalFailure: false,
            },
          };
        }
        return {
          ok: true as const,
          value: {
            status: "success",
            settled: true,
            terminalFailure: false,
          },
        };
      },
    };

    let clock = 1000;
    const r = await reconcileUntil(adapter, "tx-123", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      deadlineMs: 50000,
      pollMs: 1000,
      corridorId: "test-corridor",
      logger,
      metrics,
    });

    expect(r.ok).toBe(true);
    expect(pollCount).toBe(3);

    // Exactly 3 logs emitted, all debug level
    const pollLogs = logs.filter((l) => l.msg === "corridor.reconcile.poll");
    expect(pollLogs).toHaveLength(3);
    expect(pollLogs.every((l) => l.level === "debug")).toBe(true);

    expect(pollLogs[0].fields).toEqual({
      transactionId: "tx-123",
      status: "pending_sender",
      poll: 1,
      elapsedMs: 0,
    });
    expect(pollLogs[1].fields).toEqual({
      transactionId: "tx-123",
      status: "pending_sender",
      poll: 2,
      elapsedMs: 1000,
    });
    expect(pollLogs[2].fields).toEqual({
      transactionId: "tx-123",
      status: "success",
      poll: 3,
      elapsedMs: 2000,
    });

    // Exactly 3 metric increments tagged with corridor and status
    const pollCounters = metrics.counters.filter((c) => c.name === "corridor.reconcile.poll");
    expect(pollCounters).toHaveLength(3);
    expect(pollCounters[0].tags).toEqual({
      corridor: "test-corridor",
      status: "pending_sender",
    });
    expect(pollCounters[1].tags).toEqual({
      corridor: "test-corridor",
      status: "pending_sender",
    });
    expect(pollCounters[2].tags).toEqual({ corridor: "test-corridor", status: "success" });
  });

  it("remains silent and does not throw when no logger or metrics are provided", async () => {
    const adapter = createMockAdapter();
    const r = await reconcileUntil(adapter, "tx-999", {
      now: () => 100,
      sleep: async () => {},
      deadlineMs: 500,
      pollMs: 50,
    });
    expect(r.ok).toBe(true);
  });

  it("passes logger and metrics through engine.execute during reconcile", async () => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      log(level: string, msg: string, fields?: Record<string, unknown>) {
        logs.push({ level, msg, fields });
      },
    };
    const metrics = new InMemoryMetrics();

    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      logger,
      metrics,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(true);

    const pollLogs = logs.filter((l) => l.msg === "corridor.reconcile.poll");
    expect(pollLogs.length).toBeGreaterThanOrEqual(1);
    expect(pollLogs[0].level).toBe("debug");
    expect(pollLogs[0].fields?.transactionId).toBeDefined();

    const pollMetrics = metrics.counters.filter((c) => c.name === "corridor.reconcile.poll");
    expect(pollMetrics.length).toBeGreaterThanOrEqual(1);
    expect(pollMetrics[0].tags?.corridor).toBe("test");
  });
});

// The gate runs inside execute(), so these assert through a real run: the gate's
// results land on the transition into `verifying` (and on `failed` when it refuses).
describe("pre-settle gate results in the audit trail", () => {
  const passing: CheckResult = {
    name: "chain.balance",
    passed: true,
    detail: "GSENDER holds 250.00 USDC, needs 100.00",
    durationMs: 12,
  };
  const failing: CheckResult = {
    name: "sep31.info.asset",
    passed: false,
    code: "SETTLEMENT_FAILED",
    detail: "anchor /info does not list USDC:GISSUER",
    durationMs: 40,
  };
  const capture = () => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    return {
      logs,
      logger: {
        log(level: string, msg: string, fields?: Record<string, unknown>) {
          logs.push({ level, msg, fields });
        },
      },
    };
  };
  const gateOf = (results: CheckResult[]): PreSettleGate => ({
    evaluate: async () => ({ passed: results.every((r) => r.passed), results }),
  });
  const depsWith = (over: Partial<EngineDeps>): EngineDeps => ({
    resolver: new StaticRouteResolver(() => createMockAdapter(), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    trustManifestWithoutAttestation: true,
    ...over,
  });

  it("records one result per configured check and logs each at info when they pass", async () => {
    const audit = new InMemoryAuditLog();
    const { logs, logger } = capture();
    const checks = [passing, { ...passing, name: "stellar.toml.hash", detail: "match" }];

    const r = await execute(
      { ...intent, idempotencyKey: "obs-gate-pass" },
      corridor(),
      depsWith({ audit, logger, gate: gateOf(checks) }),
    );
    expect(r.ok).toBe(true);

    const entry = audit.entries.find((e) => e.to === "verifying")!;
    expect(entry.checks).toHaveLength(checks.length);
    expect(entry.checks).toEqual(checks);

    const gateLogs = logs.filter((l) => l.msg === "corridor.gate.check");
    expect(gateLogs.map((l) => l.level)).toEqual(["info", "info"]);
  });

  it("records failed checks with passed:false, code and detail when the gate refuses", async () => {
    const audit = new InMemoryAuditLog();
    const { logs, logger } = capture();

    const r = await execute(
      { ...intent, idempotencyKey: "obs-gate-fail" },
      corridor(),
      depsWith({ audit, logger, gate: gateOf([passing, failing]) }),
    );
    expect(r.ok).toBe(false);

    const entry = audit.entries.find((e) => e.to === "failed")!;
    expect(entry.error).toContain("SETTLEMENT_FAILED");
    expect(entry.checks).toHaveLength(2);
    expect(entry.checks?.find((c) => !c.passed)).toEqual({
      name: "sep31.info.asset",
      passed: false,
      code: "SETTLEMENT_FAILED",
      detail: "anchor /info does not list USDC:GISSUER",
      durationMs: 40,
    });

    // info for the pass, warn for the failure — one line each (the first two lines
    // come from the transition into `verifying`; the refusal re-logs them on `failed`).
    const gateLogs = logs.filter((l) => l.msg === "corridor.gate.check");
    expect(gateLogs.slice(0, 2).map((l) => [l.level, l.fields?.check])).toEqual([
      ["info", "chain.balance"],
      ["warn", "sep31.info.asset"],
    ]);
    expect(gateLogs[1]!.fields).toMatchObject({
      idempotencyKey: "obs-gate-fail",
      passed: false,
      code: "SETTLEMENT_FAILED",
      detail: "anchor /info does not list USDC:GISSUER",
    });
    // The transition lines stay flat; the results live on the per-check lines.
    const transitions = logs.filter((l) => l.msg === "corridor.transition");
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) expect(t.fields).not.toHaveProperty("checks");
  });

  it("does not snapshot a caller's later mutation of the checks array", async () => {
    const audit = new InMemoryAuditLog();
    const checks = [passing];
    const r = await execute(
      { ...intent, idempotencyKey: "obs-gate-copy" },
      corridor(),
      depsWith({ audit, gate: gateOf(checks) }),
    );
    expect(r.ok).toBe(true);
    checks.push(failing);
    expect(audit.entries.find((e) => e.to === "verifying")!.checks).toHaveLength(1);
  });

  it("leaves checks off every transition that is not into verifying or failed-by-gate", async () => {
    const audit = new InMemoryAuditLog();
    const r = await execute(
      { ...intent, idempotencyKey: "obs-nochecks" },
      corridor(),
      depsWith({ audit, gate: gateOf([passing]) }),
    );
    expect(r.ok).toBe(true);
    const withChecks = audit.entries.filter((e) => "checks" in e).map((e) => e.to);
    expect(withChecks).toEqual(["verifying"]);
  });
});

// --- request scoping -------------------------------------------------------
// The id exists so a caller's 500 can be traced into the trail. That only works
// if NOTHING escapes it: the scope is applied to the sinks once, at the top of
// execute(), so a line or an entry cannot be added later without it.
describe("request scope in logs and audit", () => {
  const capture = () => {
    const lines: { level: string; msg: string; fields?: LogFields }[] = [];
    const logger: Logger = {
      log: (level, msg, fields) => {
        lines.push({ level, msg, fields });
      },
    };
    return { lines, logger };
  };

  const depsWith = (over: Partial<EngineDeps>): EngineDeps => ({
    resolver: new StaticRouteResolver(() => createMockAdapter(), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
    ...over,
  });

  it("stamps requestId on every transition entry, detail and log line of a run", async () => {
    const audit = new InMemoryAuditLog();
    const { lines, logger } = capture();
    const r = await execute(
      { ...intent, idempotencyKey: "obs-rid" },
      corridor(),
      depsWith({ audit, logger }),
      {
        requestId: "req-42",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      },
    );
    expect(r.ok).toBe(true);

    expect(audit.entries.length).toBeGreaterThan(0);
    for (const e of audit.entries) expect(e.requestId).toBe("req-42");
    for (const d of audit.details) expect(d.requestId).toBe("req-42");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.fields?.requestId).toBe("req-42");
    // traceparent rides along on the same lines, without replacing the id.
    for (const l of lines) {
      expect(l.fields?.traceparent).toBe(
        "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      );
    }
  });

  it("stamps requestId on the audit detail written before the idempotency claim", async () => {
    // `corridor.verifying` is emitted ahead of the run row existing, so it is the
    // one line a per-entry stamp at the transition site would have missed.
    const audit = new InMemoryAuditLog();
    const { lines, logger } = capture();
    await execute(
      { ...intent, idempotencyKey: "obs-rid-verify" },
      corridor(),
      depsWith({ audit, logger }),
      { requestId: "req-43" },
    );
    const verifying = lines.find((l) => l.msg === "corridor.verifying");
    expect(verifying?.fields?.requestId).toBe("req-43");
    expect(audit.details[0]?.requestId).toBe("req-43");
  });

  it("leaves the fields off entirely when the caller named no request", async () => {
    const audit = new InMemoryAuditLog();
    const { lines, logger } = capture();
    const r = await execute(
      { ...intent, idempotencyKey: "obs-norid" },
      corridor(),
      depsWith({ audit, logger }),
    );
    expect(r.ok).toBe(true);
    for (const e of audit.entries) expect(e).not.toHaveProperty("requestId");
    for (const l of lines) expect(l.fields).not.toHaveProperty("requestId");
  });

  it("childLogger folds the scope under each line's own fields", () => {
    const seen: LogFields[] = [];
    const base: Logger = { log: (_l, _m, fields) => seen.push(fields ?? {}) };
    childLogger(base, { requestId: "a", corridorId: "scope" }).log("info", "x", {
      requestId: "b",
    });
    expect(seen).toEqual([{ requestId: "b", corridorId: "scope" }]);
  });

  it("childLogger uses the sink's own child() when it has one", () => {
    const scoped: LogFields[] = [];
    const sink: Logger = {
      log: (_l, _m, fields) => scoped.push(fields ?? {}),
      child: (fields) => ({
        log: (_l2, _m2, line) => scoped.push({ child: true, ...fields, ...line }),
      }),
    };
    childLogger(sink, { requestId: "r" }).log("info", "x");
    expect(scoped).toEqual([{ child: true, requestId: "r" }]);
  });

  it("scopedAuditSink stamps entries and details, and the caller's field wins", () => {
    const recorded: unknown[] = [];
    const sink = scopedAuditSink(
      {
        record: (e) => {
          recorded.push(e);
        },
        recordDetail: (d) => {
          recorded.push(d);
        },
      },
      {
        requestId: "req-9",
        traceparent: "00-aaaabbbbccccddddeeeeffff00001111-0123456789abcdef-01",
      },
    );
    sink.record({
      idempotencyKey: "k",
      corridorId: "c",
      from: "created",
      to: "quoted",
      version: 1,
      at: 0,
      requestId: "mine",
    });
    sink.recordDetail!({
      event: "verifying",
      idempotencyKey: "k",
      corridorId: "c",
      at: 0,
      detail: { liveness: "unverified" },
    });
    expect(recorded[0]).toMatchObject({ requestId: "mine" });
    expect(recorded[1]).toMatchObject({
      event: "verifying",
      requestId: "req-9",
      traceparent: "00-aaaabbbbccccddddeeeeffff00001111-0123456789abcdef-01",
    });
  });
});
