// Chaos tests: inject a failure at every step and assert no money moves unless
// the gate passed.
//
// The engine's central safety property is that `SettlementSubmitter.submit()`
// (the ONLY thing that touches the chain) runs only after every pre-settle gate
// check has passed, and at most once per idempotency key — even across a crash
// and resume. `state.ts` guards re-entry structurally and
// `tests/state-properties.test.ts` walks the graph, but neither proves the
// property end-to-end while a step is misbehaving. This suite does: for every
// step and every failure kind it drives `execute()` with mocks and asserts the
// invariants documented in `docs/operations.md`.
//
// Money safety is measured as SUCCESSFUL settlements (a submit that returns an
// on-chain ref), not raw submit() calls: a retryable settle failure legitimately
// re-invokes submit() (a retry must re-verify through `verifying` first) as long
// as nothing ever moved, so the invariant that matters is `moneyMoved <= 1` and,
// for any step BEFORE settle, that `submit()` was never reached at all.
//
// No cell sleeps for real. The reconcile deadline and the firm-quote window are
// driven by an injected fake clock (`deps.now`/`deps.sleep`): a "timeout" cell
// advances that clock past the relevant window and lets the engine's own guard
// decide the outcome — exactly the mechanism run.ts uses.

import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import type {
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  TransactionStatus,
} from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import type { RouteDecision, RouteResolver } from "@corridor/router";
import {
  TERMINAL,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
  isTerminal,
} from "@corridor/engine";
import type {
  CheckResult,
  CorridorState,
  EngineDeps,
  GateContext,
  PreSettleGate,
  RunResult,
  SettlementSubmitter,
} from "@corridor/engine";
import { fail, ok } from "@corridor/types";
import type { CorridorErrorCode, Outcome, PaymentIntent } from "@corridor/types";

/** A real-ish epoch so `liveness()` sees the proof as fresh; the clock lives here. */
const BASE = 1_700_000_000_000;
/** Firm-quote TTL window; `quote_ttl_seconds` in the fixture matches. */
const QUOTE_TTL_MS = 60_000;
/** Jump that clears the firm-quote window so the engine's expiry guard fires. */
const PAST_QUOTE_MS = QUOTE_TTL_MS + 60_000;
const DEPOSIT = "GCHAOS0000000000000000000000000000000000000000000000000";
const MEMO = "chaos-memo";
const AMOUNT = "100.00";

// The standard SEP-31 pre-settle checks (see packages/sep31, packages/stellar,
// packages/engine quoteWindow). Chaos injects one named check at a time.
const GATE_CHECKS = [
  "quote.window",
  "sep31.info.asset",
  "sep31.amount.range",
  "anchor.tx.match",
  "sep12.receiver",
  "chain.balance",
  "chain.destination",
] as const;

type GateCheckName = (typeof GATE_CHECKS)[number];
type AdapterStep = "quote" | "comply" | "open" | "reconcile";
/** A chaos "step" is either an engine verb, the route resolver, or one gate check. */
type Step = "resolve" | AdapterStep | "settle" | "gate.evaluate" | GateCheckName;
type Kind = "throw" | "retryable" | "non_retryable" | "timeout";
type Policy = "refund_sender" | "hold" | "manual";

const isGateCheck = (step: Step): step is GateCheckName =>
  (GATE_CHECKS as readonly string[]).includes(step);

// --- fake clock -----------------------------------------------------------

interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Move the clock forward out-of-band, standing in for a step that took too long. */
  jump(ms: number): void;
}

function makeClock(): Clock {
  let t = BASE;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    jump: (ms: number) => {
      t += ms;
    },
  };
}

// --- fixtures -------------------------------------------------------------

function corridorFor(policy: Policy, opts: { reconcileStallOff?: boolean } = {}): Corridor {
  const recovery: Record<string, unknown> = {
    // Two retries keep the settle-retryable cell small while still proving the
    // retry loop re-verifies (and re-fails) without ever moving money.
    max_retries: 2,
    // Generous so only the fake clock can trip a guard; the reconcile-timeout
    // cell overrides this with a 1s deadline.
    timeout_seconds: 600,
    rollback: policy,
  };
  if (opts.reconcileStallOff) {
    // Disable poll-count stall detection so a stuck anchor reaches the deadline
    // and reports SETTLEMENT_TIMEOUT rather than RECONCILE_STALLED.
    recovery.reconcile = { stall_polls: 0 };
  }
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
    fx: {
      path: ["ARS", "USDC", "ARS"],
      who_holds_risk: "receiving_anchor",
      quote_ttl_seconds: 60,
    },
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
  if (!r.ok) throw new Error(`chaos corridor invalid: ${r.error.message}`);
  return r.value;
}

function intentFor(key: string): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: AMOUNT },
  };
}

// --- chaos anchor adapter -------------------------------------------------

type AdapterFault = { kind: Kind; code: CorridorErrorCode };

interface ChaosAdapter extends AnchorAdapter {
  readonly txPolls: number;
}

/**
 * Wraps the mock anchor and injects a failure at exactly one named verb, so a
 * single run exercises one (step, kind) cell while every other step behaves.
 * `requestQuote` mints its expiry from the injected clock, which is what lets a
 * clock jump trip either the quote verb or the loop-top re-check in run.ts.
 */
function makeChaosAdapter(
  clock: Clock,
  faultStep?: AdapterStep,
  fault?: AdapterFault,
): ChaosAdapter {
  const base = createMockAdapter();
  const quoteOk = (): Quote => ({
    id: "q_chaos",
    price: "1.00",
    expiresAt: clock.now() + QUOTE_TTL_MS,
    sourceAmount: { asset: "USDC", amount: AMOUNT },
    destAmount: { asset: "iso4217:ARS", amount: AMOUNT },
    firm: true,
  });
  const openedOk = (): OpenTransaction => ({
    transactionId: "tx_chaos",
    instructions: { kind: "stellar_payment", to: DEPOSIT, memo: MEMO, memoType: "text" },
    depositAddress: DEPOSIT,
    memo: MEMO,
    memoType: "text",
  });
  let txPolls = 0;

  // Only the named verb fails; every other step behaves. Without the `step`
  // match, a reconcile fault would also break quote/comply/open (the earliest
  // verb short-circuits those runs, which is why the pre-settle cells pass by
  // accident) and money would never reach submit.
  const applyFault = (
    step: AdapterStep,
    outcome: () => Promise<Outcome<unknown>>,
  ): Promise<Outcome<unknown>> => {
    if (step !== faultStep || !fault) return outcome();
    switch (fault.kind) {
      case "throw":
        throw new Error(`chaos: ${faultStep} threw`);
      case "retryable":
        return Promise.resolve(
          fail(fault.code, `chaos: ${faultStep} retryable`, { retryable: true }),
        );
      case "non_retryable":
        return Promise.resolve(
          fail(fault.code, `chaos: ${faultStep} non-retryable`, { retryable: false }),
        );
      case "timeout":
        // The step itself succeeds, but the clock moves past the firm-quote
        // window; the engine's own guard catches it at the next checkpoint.
        clock.jump(PAST_QUOTE_MS);
        return outcome();
    }
  };

  return {
    name: "chaos-anchor",
    get txPolls() {
      return txPolls;
    },
    capabilities: base.capabilities.bind(base),
    requestQuote: async () => {
      const made = quoteOk();
      if (faultStep === "quote" && fault?.kind === "timeout") {
        // The quote verb only re-checks expiry for FIRM quotes, so minting a
        // late quote that is still fresh would silently pass. Expire it against
        // the post-jump clock so `quote()` reports QUOTE_EXPIRED — the engine's
        // real response to a quote leg that took too long.
        clock.jump(PAST_QUOTE_MS);
        return fail("QUOTE_EXPIRED", "chaos: quote expired before use", { retryable: true });
      }
      const result = await applyFault("quote", async () => ok(made));
      return result as Outcome<Quote>;
    },
    ensureCompliance: async () => {
      const result = await applyFault("comply", async () =>
        ok<KycResult>({ status: "accepted" }),
      );
      return result as Outcome<KycResult>;
    },
    openTransaction: async () => {
      const result = await applyFault("open", async () => ok(openedOk()));
      return result as Outcome<OpenTransaction>;
    },
    getTransaction: async (): Promise<Outcome<TransactionStatus>> => {
      txPolls += 1;
      const stuck: TransactionStatus = {
        status: "pending_receiver",
        settled: false,
        terminalFailure: false,
      };
      if (faultStep === "reconcile" && fault) {
        switch (fault.kind) {
          case "throw":
            throw new Error("chaos: reconcile threw");
          case "retryable":
            return fail("ANCHOR_UNAVAILABLE", "chaos: anchor read retryable", {
              retryable: true,
            });
          case "non_retryable":
            return fail("RECONCILE_MISMATCH", "chaos: anchor read mismatch", {
              retryable: false,
            });
          case "timeout":
            return ok(stuck);
        }
      }
      return ok({ status: "completed", settled: true, terminalFailure: false });
    },
    requestRefund: base.requestRefund.bind(base),
  };
}

// --- chaos pre-settle gate ------------------------------------------------

interface ChaosGate extends PreSettleGate {
  readonly evaluations: boolean[];
  evaluateThrows: boolean;
}

/**
 * Models the standard gate: every check runs and the whole evaluation fails
 * closed if any single check refuses, throws, or exceeds its window — the exact
 * contract of `CompositeGate` (a throwing/hanging check is recorded as a failing
 * result rather than rejecting the evaluation; `tests/gate.test.ts` pins the
 * real-timer variant, here we drive the engine's reaction deterministically).
 */
function makeChaosGate(target: GateCheckName | undefined, kind: Kind | undefined): ChaosGate {
  const evaluations: boolean[] = [];
  const gate = {
    evaluations,
    evaluateThrows: false,
    async evaluate(ctx: GateContext) {
      if (gate.evaluateThrows) throw new Error("chaos: gate evaluate threw");
      void ctx;
      const results: CheckResult[] = GATE_CHECKS.map((name) => {
        if (name !== target) {
          return { name, passed: true, detail: "ok", durationMs: 1 };
        }
        if (kind === "throw" || kind === "timeout") {
          return {
            name,
            passed: false,
            code: "SETTLEMENT_FAILED",
            detail: `chaos: ${name} ${kind === "throw" ? "threw" : "exceeded its window"}`,
            durationMs: 1,
          };
        }
        return {
          name,
          passed: false,
          code: "PRESETTLE_INSUFFICIENT_FUNDS",
          detail: `chaos: ${name} refused`,
          durationMs: 1,
        };
      });
      evaluations.push(results.every((r) => r.passed));
      return { passed: results.every((r) => r.passed), results };
    },
  };
  return gate;
}

// --- counting / faulting submitter ----------------------------------------

interface ChaosSubmitter extends SettlementSubmitter {
  submitAttempts: number;
  moneyMoved: number;
  lastSubmitGatePassed: boolean | undefined;
}

/**
 * Wraps a real mock submitter so findExisting/refund keep their actual
 * semantics, but counts SUCCESSFUL settlements (money) separately from raw
 * submit() calls, and can fail the settle leg on demand. `lastSubmitGatePassed`
 * snapshots the gate verdict at the instant of each submit so a money move can
 * never be attributed to a run whose gate had not passed.
 */
function makeChaosSubmitter(
  clock: Clock,
  gate: ChaosGate,
  fault?: { kind: Kind },
): ChaosSubmitter {
  const base = createMockSubmitter();
  const sub: ChaosSubmitter = {
    submitAttempts: 0,
    moneyMoved: 0,
    lastSubmitGatePassed: undefined,
    async findExisting(req) {
      return base.findExisting!(req);
    },
    async submit(req) {
      sub.submitAttempts += 1;
      sub.lastSubmitGatePassed = gate.evaluations[gate.evaluations.length - 1];
      if (fault?.kind === "throw") throw new Error("chaos: settle threw");
      if (fault?.kind === "non_retryable")
        return fail("SETTLEMENT_FAILED", "chaos: settle hard-fail", { retryable: false });
      if (fault?.kind === "retryable")
        return fail("SETTLEMENT_FAILED", "chaos: settle transient", { retryable: true });
      if (fault?.kind === "timeout") {
        // A slow settle: it burns past the firm-quote window AND fails retryably,
        // so the retry loop's loop-top expiry guard stops any second attempt
        // before money ever moves (the same stale-rate protection engine.test.ts
        // pins for a quote that expires mid-retry).
        clock.jump(PAST_QUOTE_MS);
        return fail("SETTLEMENT_FAILED", "chaos: settle timed out", { retryable: true });
      }
      const r = await base.submit(req);
      if (r.ok) sub.moneyMoved += 1;
      return r;
    },
    async refund(req) {
      return base.refund(req);
    },
  };
  return sub;
}

// --- chaos route resolver -------------------------------------------------

function makeChaosResolver(clock: Clock, adapter: AnchorAdapter, kind?: Kind): RouteResolver {
  const inner = new StaticRouteResolver(() => adapter, {
    trustManifestWithoutAttestation: true,
  });
  const chaos: RouteResolver = {
    async resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
      if (kind === "throw") throw new Error("chaos: route resolve threw");
      return inner.resolve(intent, corridor);
    },
  };
  void clock;
  return chaos;
}

// --- expectation model ----------------------------------------------------

interface Expected {
  /** execute() rejects because a step threw and the verb does not catch it. */
  rejects: boolean;
  /** For rejecting cells: the (non-terminal) state the persisted row is left in. */
  persisted?: CorridorState;
  /** For clean cells: the terminal state `docs/operations.md` prescribes. */
  terminal?: CorridorState;
  money: 0 | 1;
  /** submit() must never have been reached (any step before settle). */
  noSubmit: boolean;
  code?: CorridorErrorCode;
  note?: string;
}

/** Where a run that reaches the recovery policy (`finishFailure`) lands. */
function recoveryTerminal(policy: Policy): CorridorState {
  if (policy === "refund_sender") return "refunded";
  if (policy === "hold") return "held";
  return "failed";
}

function expectedFor(step: Step, kind: Kind, policy: Policy): Expected {
  // A resolver throw is caught by execute() (#257): the claimed row is failed
  // with ROUTE_REFUSED rather than left in `created`.
  if (step === "resolve" && kind === "throw") {
    return {
      rejects: false,
      terminal: "failed",
      money: 0,
      noSubmit: true,
      code: "ROUTE_REFUSED",
      note: "route resolve throws before any verb runs",
    };
  }
  // Pre-settle adapter throws are NOT caught by the verbs: execute() rejects and
  // the row is left non-terminal with the key already claimed. Documented below.
  if (step === "quote") {
    if (kind === "throw")
      return { rejects: true, persisted: "created", money: 0, noSubmit: true };
    if (kind === "retryable")
      return {
        rejects: false,
        terminal: "failed",
        money: 0,
        noSubmit: true,
        code: "QUOTE_UNAVAILABLE",
      };
    if (kind === "non_retryable")
      return {
        rejects: false,
        terminal: "failed",
        money: 0,
        noSubmit: true,
        code: "QUOTE_UNAVAILABLE",
      };
    // timeout: quote() re-checks firm expiry and reports QUOTE_EXPIRED (die).
    return {
      rejects: false,
      terminal: "failed",
      money: 0,
      noSubmit: true,
      code: "QUOTE_EXPIRED",
    };
  }
  if (step === "comply") {
    if (kind === "throw")
      return { rejects: true, persisted: "quoted", money: 0, noSubmit: true };
    if (kind === "retryable")
      return {
        rejects: false,
        terminal: "failed",
        money: 0,
        noSubmit: true,
        code: "KYC_REQUIRED",
      };
    if (kind === "non_retryable")
      return {
        rejects: false,
        terminal: "failed",
        money: 0,
        noSubmit: true,
        code: "KYC_REJECTED",
      };
    // timeout: caught by the loop-top firm-expiry guard AFTER open -> recovery.
    return {
      rejects: false,
      terminal: recoveryTerminal(policy),
      money: 0,
      noSubmit: true,
      code: "QUOTE_EXPIRED",
    };
  }
  if (step === "open") {
    if (kind === "throw")
      return { rejects: true, persisted: "compliant", money: 0, noSubmit: true };
    if (kind === "retryable")
      return {
        rejects: false,
        terminal: "failed",
        money: 0,
        noSubmit: true,
        code: "ANCHOR_UNAVAILABLE",
      };
    if (kind === "non_retryable")
      return {
        rejects: false,
        terminal: "failed",
        money: 0,
        noSubmit: true,
        code: "ANCHOR_UNAVAILABLE",
      };
    return {
      rejects: false,
      terminal: recoveryTerminal(policy),
      money: 0,
      noSubmit: true,
      code: "QUOTE_EXPIRED",
    };
  }
  if (isGateCheck(step) || step === "gate.evaluate") {
    // The gate is fail-closed and always evaluated before `settling`, so every
    // gate failure is a `die` -> `failed` with no money and no submit.
    const code: CorridorErrorCode =
      step === "gate.evaluate" || kind === "throw" || kind === "timeout"
        ? "SETTLEMENT_FAILED"
        : "PRESETTLE_INSUFFICIENT_FUNDS";
    return { rejects: false, terminal: "failed", money: 0, noSubmit: true, code };
  }
  if (step === "settle") {
    if (kind === "throw") {
      // Gate PASSED, submit() invoked once, but it threw before returning a ref:
      // money did not move, and the row is left in the ambiguous `settling`.
      return { rejects: true, persisted: "settling", money: 0, noSubmit: false };
    }
    if (kind === "retryable")
      return {
        rejects: false,
        terminal: recoveryTerminal(policy),
        money: 0,
        noSubmit: false,
        code: "SETTLEMENT_FAILED",
      };
    if (kind === "timeout")
      return {
        rejects: false,
        terminal: recoveryTerminal(policy),
        money: 0,
        noSubmit: false,
        code: "QUOTE_EXPIRED",
      };
    return {
      rejects: false,
      terminal: recoveryTerminal(policy),
      money: 0,
      noSubmit: false,
      code: "SETTLEMENT_FAILED",
    };
  }
  // step === "reconcile": submit already moved money exactly once; the failure is
  // post-settle and must never re-submit.
  if (kind === "throw") {
    return { rejects: true, persisted: "settled", money: 1, noSubmit: false };
  }
  const code: CorridorErrorCode =
    kind === "retryable"
      ? "ANCHOR_UNAVAILABLE"
      : kind === "timeout"
        ? "SETTLEMENT_TIMEOUT"
        : "RECONCILE_MISMATCH";
  return {
    rejects: false,
    terminal: recoveryTerminal(policy),
    money: 1,
    noSubmit: false,
    code,
  };
}

// --- cell construction + runner -------------------------------------------

interface Cell {
  step: Step;
  kind: Kind;
  policy: Policy;
  expect: Expected;
}

function runCell(cell: Cell): {
  outcome: Outcome<RunResult> | null;
  threw: unknown;
  store: InMemoryIdempotencyStore;
  audit: InMemoryAuditLog;
  adapter: ChaosAdapter;
  gate: ChaosGate;
  submitter: ChaosSubmitter;
} {
  const clock = makeClock();
  const reconcileCell = cell.step === "reconcile";
  const reconcileTimeout = reconcileCell && cell.kind === "timeout";
  const reconcileFailure =
    reconcileCell && (cell.kind === "retryable" || cell.kind === "non_retryable");

  const adapterFaultStep: AdapterStep | undefined = (
    ["quote", "comply", "open", "reconcile"] as const
  ).includes(cell.step as AdapterStep)
    ? (cell.step as AdapterStep)
    : undefined;
  const adapterFaultCode: CorridorErrorCode | undefined = !adapterFaultStep
    ? undefined
    : adapterFaultStep === "quote"
      ? "QUOTE_UNAVAILABLE"
      : adapterFaultStep === "comply"
        ? cell.kind === "retryable"
          ? "KYC_REQUIRED"
          : "KYC_REJECTED"
        : "ANCHOR_UNAVAILABLE";
  const adapter = makeChaosAdapter(
    clock,
    adapterFaultStep,
    adapterFaultStep ? { kind: cell.kind, code: adapterFaultCode! } : undefined,
  );

  const gateTarget = isGateCheck(cell.step) ? cell.step : undefined;
  const gate = makeChaosGate(gateTarget, gateTarget ? cell.kind : undefined);
  if (cell.step === "gate.evaluate") gate.evaluateThrows = true;

  const settleFault = cell.step === "settle" ? { kind: cell.kind } : undefined;
  const submitter = makeChaosSubmitter(clock, gate, settleFault);

  const resolver = makeChaosResolver(
    clock,
    adapter,
    cell.step === "resolve" ? cell.kind : undefined,
  );

  // A reconcile deadline must be small enough that the fake clock reaches it in a
  // bounded number of polls; every other cell keeps the generous 600s window.
  const baseCorridor = corridorFor(cell.policy, { reconcileStallOff: reconcileCell });
  const corridor: Corridor =
    reconcileTimeout || reconcileFailure
      ? {
          ...baseCorridor,
          recovery: { ...baseCorridor.recovery, timeout_seconds: 1 },
        }
      : baseCorridor;

  const store = new InMemoryIdempotencyStore();
  const audit = new InMemoryAuditLog();
  const deps: EngineDeps = {
    resolver,
    submitter,
    gate,
    idempotency: store,
    audit,
    trustManifestWithoutAttestation: true,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    reconcilePollMs: 100,
  };

  let outcome: Outcome<RunResult> | null = null;
  let threw: unknown = null;
  try {
    outcome = execute(
      intentFor(`chaos-${cell.step}-${cell.kind}-${cell.policy}`),
      corridor,
      deps,
    ) as never;
  } catch (e) {
    threw = e;
  }
  // execute() is async; the synchronous throw path (resolver) is captured above,
  // and the awaited rejection is captured by the runner. This function returns
  // the still-pending promise via `outcome`; the caller awaits it inside try/catch.
  return { outcome, threw, store, audit, adapter, gate, submitter };
}

async function runCellAwaited(cell: Cell) {
  const built = runCell(cell);
  let outcome: Outcome<RunResult> | null = null;
  let threw: unknown = built.threw;
  if (!threw && built.outcome) {
    try {
      outcome = await built.outcome;
    } catch (e) {
      threw = e;
    }
  }
  return { ...built, outcome, threw };
}

function assertSafetyInvariants(
  cell: Cell,
  h: Awaited<ReturnType<typeof runCellAwaited>>,
): void {
  const { audit, gate, submitter, outcome, threw } = h;

  // Invariant 1: money moves at most once per idempotency key, ever.
  expect(
    submitter.moneyMoved,
    `money moved for ${cell.step}/${cell.kind}`,
  ).toBeLessThanOrEqual(1);

  if (cell.expect.noSubmit) {
    // A step before settle failed: submit() must never have been reached.
    expect(submitter.submitAttempts, `submit reached for ${cell.step}/${cell.kind}`).toBe(0);
  }

  // moneyMoved is 0 whenever no successful submit happened, 1 once money left.
  expect(submitter.moneyMoved).toBe(cell.expect.money);

  if (cell.expect.money === 1) {
    // Invariant 2 (the safety property): money moved => the gate ran, the last
    // evaluation fully passed, and `verifying` preceded `settling` in the trail.
    expect(gate.evaluations.length, "money moved with no gate evaluation").toBeGreaterThan(0);
    expect(
      gate.evaluations[gate.evaluations.length - 1],
      "money moved past a failed gate",
    ).toBe(true);
    expect(submitter.lastSubmitGatePassed).toBe(true);
    const trail = audit.entries.map((e) => e.to);
    expect(trail.indexOf("verifying")).toBeGreaterThanOrEqual(0);
    expect(trail.indexOf("settling")).toBeGreaterThan(trail.indexOf("verifying"));
    // Exactly one settlement, so `settled` appears once and no second submit.
    expect(trail.filter((s) => s === "settled")).toHaveLength(1);
  }

  if (cell.expect.rejects) {
    // A raw throw out of a verb aborts execute() and leaves a non-terminal row:
    // the money never moves, but the state machine never reaches a terminal
    // state either. This is real engine behaviour (adapter-verb throws are not
    // caught by run.ts) and this suite documents it rather than papering over it.
    expect(threw, `${cell.step}/${cell.kind} was expected to reject`).toBeInstanceOf(Error);
    expect(outcome).toBeNull();
  } else {
    expect(threw).toBeNull();
    expect(outcome).not.toBeNull();
    if (outcome && !outcome.ok) expect(outcome.error.code).toBe(cell.expect.code);
  }
}

function intentKey(cell: Cell): string {
  return `chaos-${cell.step}-${cell.kind}-${cell.policy}`;
}

async function assertTerminalOrDocumented(cell: Cell): Promise<void> {
  const h = await runCellAwaited(cell);
  assertSafetyInvariants(cell, h);
  const key = intentKey(cell);
  const stored = await h.store.get(key);
  if (cell.expect.rejects) {
    // Documented engine behaviour, NOT papered over: an uncaught throw leaves the
    // run mid-flight rather than in a terminal state.
    expect(stored?.state).toBe(cell.expect.persisted);
    expect(isTerminal(stored!.state)).toBe(false);
  } else {
    const expected = cell.expect.terminal!;
    expect(TERMINAL.has(expected)).toBe(true);
    expect(stored?.state).toBe(expected);
    // The RunResult state and the audit trail must agree with the store.
    const terminalFromAudit = h.audit.entries
      .map((e) => e.to)
      .filter((s) => TERMINAL.has(s))
      .pop();
    expect(terminalFromAudit).toBe(expected);
  }
}

// --- build the matrix -----------------------------------------------------

interface CellDef {
  step: Step;
  kinds: Kind[];
  /** Whether the rollback policy changes the outcome for this step (post-open). */
  policySensitive: boolean;
}

const POLICIES: Policy[] = ["refund_sender", "hold", "manual"];
const ALL_KINDS: Kind[] = ["throw", "retryable", "non_retryable", "timeout"];

const CELL_DEFS: CellDef[] = [
  { step: "resolve", kinds: ["throw"], policySensitive: false },
  { step: "quote", kinds: ALL_KINDS, policySensitive: false },
  { step: "comply", kinds: ["throw", "retryable", "non_retryable"], policySensitive: false },
  { step: "comply", kinds: ["timeout"], policySensitive: true },
  { step: "open", kinds: ["throw", "retryable", "non_retryable"], policySensitive: false },
  { step: "open", kinds: ["timeout"], policySensitive: true },
  { step: "gate.evaluate", kinds: ["throw"], policySensitive: false },
  { step: "settle", kinds: ["throw"], policySensitive: false },
  { step: "settle", kinds: ["retryable", "non_retryable", "timeout"], policySensitive: true },
  { step: "reconcile", kinds: ["throw"], policySensitive: false },
  {
    step: "reconcile",
    kinds: ["retryable", "non_retryable", "timeout"],
    policySensitive: true,
  },
];

function buildMatrix(): Cell[] {
  const cells: Cell[] = [];
  const push = (step: Step, kind: Kind, policySensitive: boolean) => {
    for (const policy of policySensitive ? POLICIES : [POLICIES[0] as Policy]) {
      cells.push({ step, kind, policy, expect: expectedFor(step, kind, policy) });
    }
  };
  for (const def of CELL_DEFS) {
    for (const kind of def.kinds) push(def.step, kind, def.policySensitive);
  }
  for (const check of GATE_CHECKS) {
    for (const kind of ALL_KINDS) push(check, kind, false);
  }
  return cells;
}

const MATRIX = buildMatrix();

describe("chaos: step x failure-kind matrix", () => {
  it("covers every step x kind combination (with policy sweep where it matters)", () => {
    // Guard the matrix itself: a new kind/step must land in a named it(), not
    // silently reduce coverage.
    const steps = new Set(MATRIX.map((c) => c.step));
    expect(steps.has("resolve")).toBe(true);
    expect(steps.has("quote")).toBe(true);
    expect(steps.has("comply")).toBe(true);
    expect(steps.has("open")).toBe(true);
    expect(steps.has("settle")).toBe(true);
    expect(steps.has("reconcile")).toBe(true);
    expect(steps.has("gate.evaluate")).toBe(true);
    for (const check of GATE_CHECKS) expect(steps.has(check)).toBe(true);
    for (const c of MATRIX) expect(ALL_KINDS).toContain(c.kind);
    expect(MATRIX.length).toBeGreaterThanOrEqual(60);
  });

  for (const cell of MATRIX) {
    const label = `[${cell.step} x ${cell.kind}] policy=${cell.policy}`;
    if (cell.step === "resolve" && cell.kind !== "throw") continue;
    it(`${label} -> no money unless gate passed; terminal ${cell.expect.rejects ? `stays ${cell.expect.persisted}` : cell.expect.terminal}`, async () => {
      await assertTerminalOrDocumented(cell);
    });
  }

  // Documented non-applicable cells: the RouteResolver returns a RouteDecision,
  // never an Outcome, and no deadline exists before quote — so a failed-or
  // -timed-out route resolves has no distinct engine path. Assert the money
  // invariant still holds when only a throw can reach it.
  it("resolve x retryable/non_retryable/timeout: no failure-Outcome path exists", async () => {
    for (const kind of ["retryable", "non_retryable", "timeout"] as Kind[]) {
      const cell: Cell = {
        step: "resolve",
        kind,
        policy: "refund_sender",
        expect: expectedFor("resolve", "throw", "refund_sender"),
      };
      // resolve() can only throw; with a resolver that resolves normally the run
      // must still move money at most once and only past a passed gate.
      const h = await runCellAwaited({ ...cell, kind: "retryable" });
      expect(h.submitter.moneyMoved).toBeLessThanOrEqual(1);
      if (h.submitter.moneyMoved === 1) expect(h.gate.evaluations.at(-1)).toBe(true);
    }
  });
});

// --- crash + resume: at most one money move per key -----------------------

function resumeDeps(store: InMemoryIdempotencyStore, submitter: ChaosSubmitter): EngineDeps {
  const clock = makeClock();
  const cleanAdapter = makeChaosAdapter(clock);
  const gate = makeChaosGate(undefined, undefined);
  return {
    resolver: new StaticRouteResolver(() => cleanAdapter, {
      trustManifestWithoutAttestation: true,
    }),
    submitter,
    gate,
    idempotency: store,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    reconcilePollMs: 100,
    trustManifestWithoutAttestation: true,
  };
}

describe("chaos: crash + resume never re-moves money", () => {
  it("resume after a pre-settle failure conflicts and never submits", async () => {
    const cell: Cell = {
      step: "quote",
      kind: "non_retryable",
      policy: "refund_sender",
      expect: expectedFor("quote", "non_retryable", "refund_sender"),
    };
    const first = await runCellAwaited(cell);
    assertSafetyInvariants(cell, first);
    expect(first.submitter.submitAttempts).toBe(0);
    expect((await first.store.get(intentKey(cell)))?.state).toBe("failed");

    // Simulated crash: re-enter execute() with the SAME key against the SAME
    // store/submitter. The failed run is terminal, so the gate rejects a second
    // attempt outright rather than re-settling.
    const sharedSubmitter = first.submitter;
    const again = await execute(
      intentKeyCell(cell),
      corridorFor("refund_sender"),
      resumeDeps(first.store, sharedSubmitter),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(sharedSubmitter.submitAttempts).toBe(0);
    expect(sharedSubmitter.moneyMoved).toBe(0);
  });

  it("resume from an ambiguous 'settling' row conflicts and never re-submits", async () => {
    // The dangerous window: money may or may not have gone out. run.ts refuses to
    // guess, so no second submit is possible (docs §"Crash mid-flight").
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "crash-settling",
      corridorId: "test",
      state: "settling",
      version: 5,
      transactionId: "tx_chaos",
      quoteId: "q_chaos",
      quoteExpiresAt: BASE + QUOTE_TTL_MS,
      quoteFirm: true,
      settlementAmount: AMOUNT,
      depositAddress: DEPOSIT,
      memo: MEMO,
      memoType: "text",
    });
    const submitter = makeChaosSubmitter(makeClock(), makeChaosGate(undefined, undefined));
    const r = await execute(
      intentFor("crash-settling"),
      corridorFor("refund_sender"),
      resumeDeps(store, submitter),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(submitter.submitAttempts).toBe(0);
    expect(submitter.moneyMoved).toBe(0);
  });

  it("resume past the gate with an un-rerunnable gate conflicts and never submits", async () => {
    // A run crashed after `open` but before settle. A resumed process cannot
    // re-evaluate the pre-settle gate (the live quote/opened are gone), so the
    // engine must refuse rather than submit past a gate it cannot re-check.
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "crash-opened",
      corridorId: "test",
      state: "opened",
      version: 4,
      transactionId: "tx_chaos",
      quoteId: "q_chaos",
      quoteExpiresAt: BASE + QUOTE_TTL_MS,
      quoteFirm: true,
      settlementAmount: AMOUNT,
      depositAddress: DEPOSIT,
      memo: MEMO,
      memoType: "text",
    });
    const submitter = makeChaosSubmitter(makeClock(), makeChaosGate(undefined, undefined));
    const r = await execute(
      intentFor("crash-opened"),
      corridorFor("refund_sender"),
      resumeDeps(store, submitter),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(submitter.submitAttempts).toBe(0);
    expect(submitter.moneyMoved).toBe(0);
  });

  it("money moved once, crashed before reconcile: resume completes without re-submitting", async () => {
    // The end-to-end proof of the safety property across a crash.
    const cell: Cell = {
      step: "reconcile",
      kind: "throw",
      policy: "refund_sender",
      expect: expectedFor("reconcile", "throw", "refund_sender"),
    };
    const first = await runCellAwaited(cell);
    assertSafetyInvariants(cell, first);
    // Post-settle throw: money already left (exactly once), row parked in `settled`.
    expect(first.submitter.moneyMoved).toBe(1);
    expect(first.submitter.submitAttempts).toBe(1);
    expect((await first.store.get(intentKey(cell)))?.state).toBe("settled");

    // Same key, same submitter/store: resume reconciles and completes, and never
    // touches the settle leg again.
    const again = await execute(
      intentKeyCell(cell),
      corridorFor("refund_sender"),
      resumeDeps(first.store, first.submitter),
    );
    expect(again.ok).toBe(true);
    expect(first.submitter.moneyMoved).toBe(1);
    expect(first.submitter.submitAttempts).toBe(1);
    expect((await first.store.get(intentKey(cell)))?.state).toBe("completed");

    // A third call reads the completed run idempotently — still one money move.
    const third = await execute(
      intentKeyCell(cell),
      corridorFor("refund_sender"),
      resumeDeps(first.store, first.submitter),
    );
    expect(third.ok).toBe(true);
    expect(first.submitter.moneyMoved).toBe(1);
    expect(first.submitter.submitAttempts).toBe(1);
  });
});

function intentKeyCell(cell: Cell): PaymentIntent {
  return intentFor(intentKey(cell));
}
