// The orchestrator. execute() runs one payment across one corridor:
//   quote → comply → open → settle → reconcile → complete
// driving the state machine, persisting after each step (so it's resumable), and
// routing failures through recover(). It is corridor-AGNOSTIC: every corridor-
// specific fact arrives via the validated manifest, every anchor-specific fact via
// the injected RouteResolver/adapters. Add a corridor = add a manifest.

import { liveness, hashCorridor, type Corridor, type LivenessState } from "@corridor/manifest";
import {
  compareAmounts,
  fail,
  isSettleableAmount,
  ok,
  type CorridorError,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type { RouteDecision, RouteResolver } from "@corridor/router";
import {
  AdapterQuoteProvider,
  ExternalQuoteProvider,
  toLegacy,
  type ExternalQuoteFn,
  type OpenTransaction,
  type QuoteProvider,
} from "@corridor/adapter-kit";
import { canTransition, isTerminal, type CorridorState } from "./state";
import {
  InMemoryIdempotencyStore,
  hasRequestedRefund,
  hasSettlementRef,
  type IdempotencyStore,
  type StoredRun,
} from "./idempotency";
import {
  settlementId,
  type ChainVerifier,
  type RefundRequest,
  type SettlementRef,
  type SettlementRequest,
  type SettlementStrategy,
  type SettlementSubmitter,
} from "./ports";
import {
  anchorTerminalStatus,
  backoffMs,
  buildSettlementRequest,
  comply,
  open,
  quote,
  recover,
  reconcileUntil,
  settle,
  watchRefund,
  settleQuoteProblem,
} from "./verbs";
import type {
  AnchorAdapter,
  SourceAnchorAdapter,
  TransactionStatus,
} from "@corridor/adapter-kit";
import { defaultStrategies } from "./ports";
import { checkCompatibility } from "./compat";
import {
  noopMetrics,
  silentLogger,
  childLogger,
  scopedAuditSink,
  type AuditEntry,
  type AuditSink,
  type Alerting,
  type Logger,
  type Metrics,
  type RequestScope,
} from "./observability";
import type { CheckResult, GateContext, PreSettleGate } from "./gate";
import {
  BREAKER_METRICS,
  MeteredCorridorHealthStore,
  breakerOutcomeFor,
  recoveredBreakerCause,
  type CorridorHealthStore,
} from "./breaker";

export interface EngineDeps {
  resolver: RouteResolver;
  submitter: SettlementSubmitter;
  gate?: PreSettleGate;
  /**
   * Optional independent check that the settle transaction really paid what
   * was requested. Runs once after `settled` (and again on resume from
   * `settled`), before the run may become `reconciled`. A failure is treated
   * like any post-settle failure: money moved, so it goes to the manifest's
   * `hold` / `refund_sender` path rather than `failed`.
   */
  chainVerifier?: ChainVerifier;
  /**
   * Explicit list of settlement strategies. When omitted, the engine derives
   * `[new StellarPaymentStrategy(deps.submitter)]` so all existing callers
   * keep working with no changes.
   *
   * Provide this when you need to handle settlement kinds beyond
   * `"stellar_payment"` (e.g. after issue #183 lands). The engine dispatches
   * to the first strategy whose `kind` matches the deposit instructions kind
   * returned by the receiving anchor.
   */
  strategies?: readonly SettlementStrategy[];
  idempotency?: IdempotencyStore;
  waker?: import("./ports").ReconcileWaker;
  now?: () => number;
  /** Injectable sleep so tests don't wait on real backoff/poll delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between reconcile polls (ms). Defaults to 2s. Overridden by `recovery.reconcile.poll_seconds` in the manifest. */
  reconcilePollMs?: number;
  /**
   * Consecutive polls with the same status before bailing with
   * `RECONCILE_STALLED`. Defaults to 10. Set to `0` to disable. Overridden by
   * `recovery.reconcile.stall_polls` in the manifest.
   */
  stallThreshold?: number;
  /** Structured logger. Defaults to a silent logger. */
  logger?: Logger;
  /** Append-only audit sink; receives one entry per state transition. */
  audit?: AuditSink;
  /** Best-effort operational alerts. Failures are logged and never alter a run. */
  alerting?: Alerting;
  /** Counter/timing sink. Defaults to a no-op. */
  metrics?: Metrics;
  /** Maximum payment amount while a corridor has no fresh canary proof. Defaults to "10". */
  unprovenMaxAmount?: string;
  /**
   * Per-corridor circuit breaker. Once `recovery.breaker.consecutive_failures`
   * lane-level failures land in a row, new runs on that corridor are refused
   * with `CORRIDOR_HALTED` until someone runs
   * `corridor breaker reset <id> --reason "…"`.
   *
   * Omit it and the breaker is simply absent — the engine is unchanged, so this
   * stays opt-in like every other store. In production this must be the shared
   * `PostgresCorridorHealthStore`, not the in-memory one: a per-replica count
   * lets a peer replica keep taking payments on a lane another has halted.
   */
  health?: CorridorHealthStore;
  /**
   * Explicit opt-in allowing manifest-trusted routes on a public network without
   * on-chain attestation.
   */
  trustManifestWithoutAttestation?: boolean;
  /**
   * Pricing function for corridors with `fx.quote_source: external`. Required
   * for those corridors; the engine never makes a SEP-38 call for them.
   */
  externalQuote?: ExternalQuoteFn;
  /**
   * Optional custom quote provider or factory. Overrides the default provider
   * derived from the corridor manifest and adapter capabilities.
   */
  quoteProvider?:
    QuoteProvider | ((corridor: Corridor, adapter: AnchorAdapter) => QuoteProvider);
  /**
   * Explicit escape hatch skipping pre-settle verification. When true, execute() bypasses gate
   * evaluation while recording `gate.skipped` in the audit log and emitting a warning.
   */
  unsafeSkipPreSettleGate?: boolean;
}

export interface RunResult {
  readonly idempotencyKey: string;
  readonly state: CorridorState;
  readonly transactionId?: string;
  readonly stellarTxHash?: string;
  readonly settlementKind?: "stellar" | "adapter";
  readonly settlementRef?: SettlementRef;
  /** Ordered list of states the run passed through — useful for the example/CLI. */
  readonly trail: readonly CorridorState[];
}

export interface ExecuteOptions {
  /**
   * Opaque tenant id recorded on the run so later reads can be scoped to their
   * creator. Callers must derive this from an already-VALIDATED credential (an
   * authenticated API key), never from the request body — otherwise a client
   * simply claims someone else's tenancy.
   */
  owner?: string;
  /**
   * Explicit opt-in allowing manifest-trusted routes on a public network without
   * on-chain attestation.
   */
  trustManifestWithoutAttestation?: boolean;
  /**
   * Run quote → comply → open → pre-settle gate against the real anchor, then
   * stop before `settling`: `SettlementSubmitter.submit()` (and `findExisting`)
   * are never called. Every gate result is recorded on the audit trail.
   *
   * When the gate passes, the run is persisted as `failed` with
   * `DRY_RUN_COMPLETE` and that error is returned, its `cause` carrying the
   * gate report (`{ dryRun: true, checks }`). A gate refusal ends exactly as it
   * would on a real run. Either way the idempotency key is spent.
   *
   * The receiving anchor is left holding an opened SEP-31 transaction that is
   * never funded; it expires on the anchor's side.
   */
  dryRun?: boolean;
  /**
   * Correlation id for the request that started this run — the HTTP layer's
   * `X-Request-Id`. Stamped on every log line and audit entry the run produces,
   * so a 500 at the edge can be tied back to the lines behind it. The engine
   * never generates one; callers own the id.
   */
  requestId?: string;
  /**
   * W3C `traceparent` of the request that started this run, passed through as a
   * field on the same lines. Full tracing (spans, export) is not the engine's
   * job — this only keeps the ids correlatable until it is.
   */
  traceparent?: string;
}

/** The `cause` of a `DRY_RUN_COMPLETE` error: what the gate said before the run stopped. */
export interface DryRunReport {
  readonly dryRun: true;
  readonly checks: readonly CheckResult[];
}

/**
 * Fold a finished run into the lane's breaker. The run's terminal state and the
 * error that produced it are the only inputs: whether a failure says anything
 * about the LANE (rather than about this one request) is decided by
 * `breakerOutcomeFor`, not here.
 *
 * A lane failure is counted once, when the run RESOLVES (`failed`, `refunded`,
 * `held`) -- never when it merely parks in `refund_pending`, which is still in
 * flight and may yet be resolved either way by the anchor's refund report.
 */
type RecordOutcome = (state: CorridorState, e?: CorridorError) => Promise<void>;

/** The request context to stamp on a run's output, or undefined when there is none. */
function requestScopeOf(opts: ExecuteOptions): RequestScope | undefined {
  const { requestId, traceparent } = opts;
  if (!requestId && !traceparent) return undefined;
  return { ...(requestId && { requestId }), ...(traceparent && { traceparent }) };
}

/**
 * Rebind the injected logger/audit sink to `scope`, leaving every other dep (and
 * dep identity elsewhere) untouched. Scoping happens once per run rather than at
 * each emit site, so nothing added later — a new log line, a new verb — can
 * forget the request id.
 */
function withRequestScope(deps: EngineDeps, scope: RequestScope): EngineDeps {
  return {
    ...deps,
    logger: childLogger(deps.logger ?? silentLogger, scope),
    ...(deps.audit && { audit: scopedAuditSink(deps.audit, scope) }),
  };
}

function makeRecordOutcome(
  deps: EngineDeps,
  corridor: Corridor,
  health: CorridorHealthStore | undefined,
  now: () => number,
): RecordOutcome {
  const breakerOpts = { threshold: corridor.recovery.breaker.consecutive_failures };
  return async (state, e) => {
    if (!health) return;
    const outcome = breakerOutcomeFor(state, e?.code);
    if (outcome === "neutral") return;
    await health.recordOutcome(corridor.id, outcome, now(), {
      ...breakerOpts,
      // Stored verbatim, so it is exactly what the run's own `lastError` shows.
      ...(e && { error: `${e.code}: ${e.message}` }),
    });
  };
}

export async function execute(
  intent: PaymentIntent,
  corridor: Corridor,
  depsIn: EngineDeps,
  opts: ExecuteOptions = {},
): Promise<Outcome<RunResult>> {
  // One request, one scope: when the caller names the request that started this
  // run, every log line and audit entry below inherits that id — including the
  // early refusals, which are exactly the ones an operator has to explain.
  const scope = requestScopeOf(opts);
  const deps = scope ? withRequestScope(depsIn, scope) : depsIn;
  const store = deps.idempotency ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Manifest value wins, then EngineDeps, then the engine default.
  const rc = corridor.recovery.reconcile;
  const pollMs =
    rc?.poll_seconds !== undefined ? rc.poll_seconds * 1000 : (deps.reconcilePollMs ?? 2_000);
  const stallThreshold = rc?.stall_polls ?? deps.stallThreshold ?? 10;
  const externalStallMs = externalStallBudgetMs(corridor);
  const metrics = deps.metrics ?? noopMetrics;
  const startedAt = now();

  // Wrap once, here, so every trip and reset is counted even when the embedding
  // application never met the meter. An already-metered store is left alone so
  // that an app which wired the meter itself does not double-count.
  const health = meteredHealth(deps);
  const recordOutcome = makeRecordOutcome(deps, corridor, health, now);

  // Time a verb call and emit a `corridor.verb.<name>` histogram sample.
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const begin = now();
    const r = await fn();
    metrics.timing(`corridor.verb.${name}`, now() - begin, { corridor: corridor.id });
    return r;
  };

  // --- configuration guard: pre-settle gate is mandatory by default.
  // Fail closed before claiming idempotency key (no run row persisted) unless
  // an explicit opt-out is provided.
  if (!deps.gate && deps.unsafeSkipPreSettleGate !== true) {
    return fail(
      "ENGINE_MISCONFIGURED",
      "pre-settle gate is required; supply deps.gate or explicitly opt out with deps.unsafeSkipPreSettleGate = true",
    );
  }

  // --- input guard: never let a malformed or non-positive amount reach the
  // chain. `isSettleableAmount` and not `isValidAmount`: the latter is a syntax
  // check that accepts a leading minus (subAmounts needs signed values), so it
  // happily passed "-100.00" all the way to the settlement submitter.
  if (!isSettleableAmount(intent.sourceAmount.amount)) {
    return fail(
      "AMOUNT_INVALID",
      `sourceAmount "${intent.sourceAmount.amount}" is not a positive decimal amount`,
    );
  }
  const verificationAt = now();
  const live = liveness(corridor, new Date(verificationAt));
  const unproven = live.state !== "proven";
  const canaryCap = corridor.proof?.canary_max_amount ?? deps.unprovenMaxAmount ?? "10";
  // Per-corridor ceiling. A manifest that declares max_amount caps any single
  // payment on that lane, including on a proven corridor.
  const max = corridor.limits?.max_amount;
  let effectiveCap = unproven ? canaryCap : max;
  if (unproven && max) {
    const compared = compareAmounts(max, canaryCap);
    if (!compared.ok) return compared;
    effectiveCap = compared.value <= 0 ? max : canaryCap;
  }
  await emitVerification(deps, intent, corridor, verificationAt, live.state, effectiveCap);

  if (
    corridor.settlement.network === "public" &&
    (live.state === "unverified" || live.state === "not-runnable")
  ) {
    return fail(
      "CORRIDOR_UNPROVEN",
      `corridor ${corridor.id} is ${live.state} on the public network and cannot accept payments`,
    );
  }

  const min = corridor.limits?.min_amount;
  if (min) {
    const cmp = compareAmounts(intent.sourceAmount.amount, min);
    if (!cmp.ok) return cmp;
    if (cmp.value < 0) {
      return fail(
        "AMOUNT_INVALID",
        `sourceAmount "${intent.sourceAmount.amount}" is below corridor ${corridor.id} min_amount ${min}`,
      );
    }
  }

  if (max) {
    const cmp = compareAmounts(intent.sourceAmount.amount, max);
    if (!cmp.ok) return cmp;
    if (cmp.value > 0) {
      return fail(
        "AMOUNT_INVALID",
        `sourceAmount "${intent.sourceAmount.amount}" exceeds corridor ${corridor.id} max_amount ${max}`,
      );
    }
  }
  if (unproven && effectiveCap) {
    const cmp = compareAmounts(intent.sourceAmount.amount, effectiveCap);
    if (!cmp.ok) return cmp;
    if (cmp.value > 0) {
      return fail(
        "CORRIDOR_UNPROVEN",
        `sourceAmount "${intent.sourceAmount.amount}" exceeds corridor ${corridor.id} unproven canary cap ${effectiveCap}`,
      );
    }
  }

  // --- idempotency gate + crash resume ---------------------------------
  const existing = await store.get(intent.idempotencyKey);
  if (existing) {
    if (existing.state === "completed") {
      return ok(toResult(existing, [existing.state]));
    }
    if (!isTerminal(existing.state)) {
      return resumeRun(
        existing,
        intent,
        corridor,
        deps,
        store,
        now,
        sleep,
        pollMs,
        stallThreshold,
        opts,
        recordOutcome,
      );
    }
    return fail(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey ${intent.idempotencyKey} already in-flight (state=${existing.state})`,
    );
  }

  const run: StoredRun = {
    idempotencyKey: intent.idempotencyKey,
    corridorId: corridor.id,
    manifestHash: hashCorridor(corridor),
    state: "created",
    version: 0,
    owner: opts.owner,
  };
  const trail: CorridorState[] = ["created"];

  // --- circuit breaker: refuse NEW work on a halted lane ----------------
  // Deliberately AFTER the resume path above and BEFORE the idempotency claim.
  //
  // After, because a run that already reached `settled` has money on the chain
  // that this engine still has to reconcile. Blocking its resume would strand
  // that payment behind a breaker whose whole purpose is to stop *new* money —
  // the opposite of what §2 of the runbook asks for. The breaker is a gate on
  // new work, never a gate on recovery.
  //
  // Before the claim, so a refused run leaves no row: nothing to reconcile,
  // nothing to expire, and the caller can retry the identical idempotency key
  // after the reset and get a real attempt.
  if (health) {
    const breaker = await health.get(corridor.id);
    if (breaker?.state === "open") {
      metrics.increment(BREAKER_METRICS.refused, { corridor: corridor.id });
      (deps.logger ?? silentLogger).log("warn", "corridor.halted", {
        corridor: corridor.id,
        consecutiveFailures: breaker.consecutiveFailures,
        trippedAt: breaker.trippedAt,
        lastError: breaker.lastError,
      });
      return fail(
        "CORRIDOR_HALTED",
        `corridor ${corridor.id} is halted after ${breaker.consecutiveFailures} consecutive failures` +
          (breaker.lastError ? ` (last: ${truncate(breaker.lastError, 200)})` : "") +
          `. This is a deliberate stop, not a payment problem: investigate the lane, then reopen it with` +
          ` \`corridor breaker reset ${corridor.id} --reason "…"\`.`,
        { retryable: false },
      );
    }
  }

  // Atomically claim the key before doing any work. `get()` above can't be the
  // gate on its own: two concurrent callers can both see "no existing run" and
  // both proceed to settle. create() is a conditional insert — exactly one
  // caller wins the claim; the loser bails here rather than risk a duplicate
  // on-chain payment. (The put() version guard only stops the row going
  // backwards, not two runs executing.)
  if (!(await store.create(run))) {
    return fail(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey ${intent.idempotencyKey} already claimed by a concurrent run`,
    );
  }

  // --- pick the receiving anchor ---------------------------------------
  // The key is already claimed, so a refusal must still finish the run: left in
  // `created` it would answer every retry with IDEMPOTENCY_CONFLICT forever.
  const routed = await resolveRoute(deps.resolver, intent, corridor);
  if (!routed.ok) {
    return failRun({ run, trail, deps, store, now, recordOutcome }, routed.error);
  }
  const route = routed.value;
  const routeTrust = route.trust;
  const adapter = route.receiving;
  const context = createRunContext({
    run,
    trail,
    corridor,
    deps,
    store,
    now,
    sleep,
    pollMs,
    adapter,
    routeTrust,
    recordOutcome,
  });
  const { advance, die, finishFailure } = context;

  const strategies = deps.strategies ?? defaultStrategies(deps.submitter, adapter);
  const caps = adapter.capabilities();
  const compat = checkCompatibility(corridor, caps, strategies);
  if (!compat.ok) {
    return die({
      code: compat.error.code,
      message: compat.error.message,
      retryable: false,
    });
  }

  if (
    corridor.settlement.network === "public" &&
    route.trust === "manifest" &&
    !deps.trustManifestWithoutAttestation &&
    !opts.trustManifestWithoutAttestation
  ) {
    return die({
      code: "MANIFEST_INVALID",
      message:
        "refusing manifest route trust on public network without explicit { trustManifestWithoutAttestation: true }. Use RegistryRouteResolver for verified routing.",
      retryable: false,
    });
  }

  let provider: QuoteProvider | undefined;
  if (deps.quoteProvider) {
    provider =
      typeof deps.quoteProvider === "function"
        ? deps.quoteProvider(corridor, adapter)
        : deps.quoteProvider;
  } else if (corridor.fx.quote_source === "external") {
    // A non-firm external rate cannot bind the receiving anchor, so when that
    // anchor is the one holding FX risk we refuse unless it prices natively.
    if (
      corridor.fx.who_holds_risk === "receiving_anchor" &&
      !adapter.capabilities().quotes.includes("native")
    ) {
      return die({
        code: "MANIFEST_INVALID",
        message: `corridor ${corridor.id}: fx.quote_source "external" with who_holds_risk "receiving_anchor" requires an adapter that reports firm native quotes; a non-firm external rate cannot bind the receiving anchor`,
        retryable: false,
      });
    }
    if (!deps.externalQuote) {
      return die({
        code: "QUOTE_UNAVAILABLE",
        message: `corridor ${corridor.id} sets fx.quote_source "external" but no EngineDeps.externalQuote was provided`,
        retryable: false,
      });
    }
    provider = new ExternalQuoteProvider(deps.externalQuote, now);
  } else if (corridor.fx.quote_source === "native") {
    if (!adapter.capabilities().quotes.includes("native")) {
      return die({
        code: "MANIFEST_INVALID",
        message: `corridor ${corridor.id}: fx.quote_source "native" requires an adapter that reports native quotes`,
        retryable: false,
      });
    }
    provider = new AdapterQuoteProvider(adapter);
  }

  // --- 1. quote ---------------------------------------------------------
  const q = await timed("quote", () => quote(adapter, intent, corridor, now(), provider));
  if (!q.ok) return die(q.error);
  run.quoteId = q.value.id;
  run.quoteExpiresAt = q.value.expiresAt;
  run.quoteFirm = q.value.firm;
  run.settlementAmount = q.value.sourceAmount.amount;
  {
    const t = await advance("quoted");
    if (!t.ok) return die(t.error);
  }

  // --- 2. comply --------------------------------------------------------
  if (caps.kyc !== "none") {
    const c = await timed("comply", () => comply(adapter, intent, corridor));
    if (!c.ok) return die(c.error);
  }
  {
    const t = await advance("compliant");
    if (!t.ok) return die(t.error);
  }

  // --- 3a. open ---------------------------------------------------------
  const opened = await timed("open", () => open(adapter, intent, q.value, corridor));
  if (!opened.ok) return die(opened.error);
  run.transactionId = opened.value.transactionId;
  const legacy = toLegacy(opened.value);
  run.depositAddress = legacy.depositAddress;
  run.memo = legacy.memo;
  run.memoType = legacy.memoType;
  {
    const t = await advance("opened");
    if (!t.ok) return die(t.error);
  }

  // Keep dry runs value-free: they never open a source deposit.
  if (opts.dryRun && corridor.source.protocol !== "prefunded") {
    return die({
      code: "DRY_RUN_COMPLETE",
      message:
        "dry run stopped before source funding; non-prefunded gate checks require a funded treasury",
      retryable: false,
      cause: { dryRun: true, checks: [] },
    });
  }

  // Source funding precedes the destination balance/gate checks so the
  // treasury is actually funded when those checks inspect its balance.
  if (corridor.source.protocol !== "prefunded") {
    if (!route.sending) {
      return die({
        code: "ENGINE_MISCONFIGURED",
        message: `corridor ${corridor.id} requires a sending adapter for protocol ${corridor.source.protocol}`,
        retryable: false,
      });
    }
    const funding = await advance("funding");
    if (!funding.ok) return die(funding.error);
    const deposit = await route.sending.openDeposit(intent, corridor);
    if (!deposit.ok) return finishFailure(deposit.error);
    run.sourceTransactionId = deposit.value.transactionId;
    run.version += 1;
    await store.put(run);
    const funded = await waitForSourceDeposit(route.sending, run.sourceTransactionId, {
      now,
      sleep,
      deadlineMs: now() + corridor.recovery.timeout_seconds * 1000,
      pollMs,
      stallThreshold,
    });
    if (!funded.ok) return finishFailure(funded.error);
    const markedFunded = await advance("funded");
    if (!markedFunded.ok) return die(markedFunded.error);
  }

  // The whole settle+reconcile phase must finish inside the corridor's timeout.
  const deadlineMs = now() + corridor.recovery.timeout_seconds * 1000;

  // --- 3b/4. settle + reconcile, with recover() retry loop --------------
  let attempt = 0;
  for (;;) {
    if (now() >= deadlineMs) {
      return finishFailure({
        code: "SETTLEMENT_TIMEOUT",
        message: `corridor ${corridor.id} exceeded ${corridor.recovery.timeout_seconds}s`,
        retryable: false,
      });
    }

    // Re-checked on every pass, not just once before the loop: quote() only
    // validates expiresAt before this loop starts, but a retry (backed off
    // between attempts) reuses the SAME q.value on every iteration. Without
    // this, a slow anchor or a couple of retries can settle at a stale firm
    // quote's price with no error. There's no "retry into a fresh quote"
    // step in this loop, so once expired there's nothing safe to retry into.
    if (q.value.firm && q.value.expiresAt <= now()) {
      const expired = {
        code: "QUOTE_EXPIRED",
        message: `quote ${q.value.id} expired during retry`,
        retryable: false,
      } as const;
      if (run.sourceTransactionId) return context.holdAndStop(expired);
      return finishFailure(expired);
    }

    // The same check settle() makes, done here too so a bad quote dies before the run ever reaches
    // "verifying" or "settling" (one implementation: settleQuoteProblem in verbs.ts).
    const settleProblem = settleQuoteProblem(q.value, corridor);
    if (settleProblem) {
      return die({ code: "AMOUNT_INVALID", message: settleProblem, retryable: false });
    }

    let gateChecks: CheckResult[];
    if (deps.gate) {
      const gateCtx: GateContext = {
        intent,
        corridor,
        quote: q.value,
        opened: opened.value,
        now: now(),
        attempt,
      };
      let gateResult;
      try {
        gateResult = await timed("verify", () => deps.gate!.evaluate(gateCtx));
      } catch (e) {
        // Record the attempt at the gate so the audit trail shows where it died.
        await advance("verifying");
        const gateError = {
          code: "SETTLEMENT_FAILED",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
        } as const;
        if (run.sourceTransactionId) return context.holdAndStop(gateError);
        return die(gateError);
      }
      gateChecks = gateResult.results;
      for (const check of gateChecks) {
        metrics.increment("corridor.gate.check", {
          name: check.name,
          passed: String(check.passed),
        });
      }
      {
        const t = await advance("verifying", { checks: gateChecks });
        if (!t.ok) return die(t.error);
      }
      if (!gateResult.passed) {
        const failure = gateChecks.find((r) => !r.passed)!;
        const gateError = {
          code: failure.code ?? "SETTLEMENT_FAILED",
          message: failure.detail,
          retryable: false,
        } as const;
        if (run.sourceTransactionId) return context.holdAndStop(gateError);
        return die(gateError, gateChecks);
      }
    } else {
      const skippedCheck: CheckResult = {
        name: "gate.skipped",
        passed: true,
        detail: "unsafeSkipPreSettleGate",
        durationMs: 0,
      };
      gateChecks = [skippedCheck];
      (deps.logger ?? silentLogger).log(
        "warn",
        "pre-settle gate skipped via unsafeSkipPreSettleGate",
        {
          idempotencyKey: run.idempotencyKey,
          corridor: corridor.id,
          attempt,
        },
      );
      metrics.increment("corridor.gate.check", {
        name: skippedCheck.name,
        passed: "true",
      });
      {
        const t = await advance("verifying", { checks: gateChecks });
        if (!t.ok) return die(t.error);
      }
    }

    // --- dry run: the gate passed; stop before any money can move ---------
    // `die`, not a new terminal state: `failed` already means "nothing was
    // sent", which is exactly true here, and the breaker treats the code as
    // neutral (it is not in LANE_FAILURE_CODES).
    if (opts.dryRun) {
      const report: DryRunReport = { dryRun: true, checks: gateChecks };
      return die(
        {
          code: "DRY_RUN_COMPLETE",
          message: `dry run stopped before settling after ${gateChecks.length} pre-settle check(s) passed; anchor transaction ${opened.value.transactionId} was opened and will not be funded`,
          retryable: false,
          cause: report,
        },
        gateChecks,
      );
    }

    // Funding can take long enough for a firm destination quote to expire.
    // Check again after the gate and immediately before settlement.
    if (q.value.firm && q.value.expiresAt <= now()) {
      const expired = {
        code: "QUOTE_EXPIRED" as const,
        message: `quote ${q.value.id} expired before settlement after source funding`,
        retryable: false,
      };
      if (run.sourceTransactionId) return context.holdAndStop(expired);
      return finishFailure(expired);
    }

    {
      const t = await advance("settling");
      if (!t.ok) return die(t.error);
    }

    const strategies = deps.strategies ?? defaultStrategies(deps.submitter, adapter);
    let s: Outcome<SettlementRef>;
    const instructionsKind = opened.value.instructions?.kind ?? "stellar_payment";
    if (deps.submitter.findExisting && instructionsKind === "stellar_payment") {
      const req = buildSettlementRequest(opened.value, q.value, corridor);
      const existing = await timed("findExisting", () => deps.submitter.findExisting!(req));
      if (!existing.ok) {
        return finishFailure(existing.error);
      }
      if (existing.value) {
        s = ok(existing.value);
      } else {
        s = await timed("settle", () =>
          settle(strategies, opened.value, q.value, corridor, adapter),
        );
      }
    } else {
      s = await timed("settle", () =>
        settle(strategies, opened.value, q.value, corridor, adapter),
      );
    }
    if (!s.ok) {
      const action = recover(corridor, s.error.retryable, attempt);
      if (action.kind === "retry") {
        attempt = action.attempt;
        // `retrying`, not `recovering`: this settle attempt failed BEFORE money
        // moved, so going round again is safe. `recovering` is terminal-bound
        // and cannot re-enter `settling` — see the note in state.ts.
        const back = await advance("retrying");
        if (!back.ok) return die(back.error);
        await sleep(backoffMs(attempt));
        continue;
      }
      return finishFailure(s.error);
    }
    run.settlementKind = s.value.kind;
    run.settlementRef = s.value;
    if (s.value.kind === "stellar") {
      run.stellarTxHash = s.value.stellarTxHash;
    }
    const settleReq = settlementRequestFor(opened.value, q.value, corridor);
    run.settlement = {
      to: settleReq.to,
      memo: settleReq.memo,
      memoType: settleReq.memoType,
      amount: settleReq.amount,
    };
    {
      const t = await advance("settled", {
        quoteFee: q.value.fee,
        networkFee: s.value.kind === "stellar" ? s.value.feeCharged : undefined,
      });
      if (!t.ok) return die(t.error);
    }

    // Verify our own payment on-chain before trusting the anchor's word on it.
    if (s.value.kind === "stellar") {
      const v = await timed("verify", () => verifyOnChain(deps, s.value, settleReq));
      if (!v.ok) return finishFailure(v.error);
    }

    // Poll until the anchor confirms payout or we hit the corridor timeout.
    // reconcileUntil returns a non-retryable error, so we never re-settle here.
    const r = await timed("reconcile", () =>
      reconcileUntil(adapter, opened.value.transactionId, {
        now,
        sleep,
        deadlineMs,
        pollMs,
        stallThreshold,
        wake: deps.waker?.signal(opened.value.transactionId),
        externalStallMs,
        corridorId: corridor.id,
        logger: deps.logger,
        metrics: deps.metrics,
      }),
    );
    if (!r.ok) return finishFailure(r.error);
    {
      const t = await advance("reconciled");
      if (!t.ok) return die(t.error);
    }
    break;
  }

  // --- 5. complete ------------------------------------------------------
  {
    const t = await advance("completed");
    if (!t.ok) return die(t.error);
  }
  // The one outcome that clears a lane's consecutive-failure count.
  await recordOutcome("completed");
  metrics.timing("corridor.duration", now() - startedAt, { corridor: corridor.id });
  return ok(toResult(run, trail));
}

async function waitForSourceDeposit(
  source: SourceAnchorAdapter,
  transactionId: string,
  opts: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    deadlineMs: number;
    pollMs: number;
    stallThreshold: number;
  },
): Promise<Outcome<void>> {
  const result = await reconcileUntil(
    { getTransaction: (id) => source.getDeposit(id) },
    transactionId,
    opts,
  );
  return result.ok ? ok(undefined) : result;
}

async function emitVerification(
  deps: EngineDeps,
  intent: PaymentIntent,
  corridor: Corridor,
  at: number,
  state: LivenessState,
  effectiveCap?: string,
): Promise<void> {
  const detail = { liveness: state, effectiveCap };
  const entry = {
    event: "verifying" as const,
    idempotencyKey: intent.idempotencyKey,
    corridorId: corridor.id,
    at,
    detail,
  };
  (deps.logger ?? silentLogger).log("info", "corridor.verifying", entry);
  await deps.audit?.recordDetail?.(entry);
}

type Err = { ok: false; error: CorridorError };

function settlementRequestFor(
  opened:
    | OpenTransaction
    | { depositAddress?: string; memo?: string; memoType?: "text" | "hash" | "id" },
  q: { sourceAmount: { amount: string } },
  corridor: Corridor,
): SettlementRequest {
  const legacy = "instructions" in opened ? toLegacy(opened) : opened;
  return {
    to: legacy.depositAddress ?? "",
    memo: legacy.memo,
    memoType: legacy.memoType,
    amount: { asset: corridor.settlement.bridge_asset, amount: q.sourceAmount.amount },
    corridor,
  };
}

/** Run the optional chain verifier; a no-op success when none is configured or settlement is non-stellar. */
async function verifyOnChain(
  deps: EngineDeps,
  ref: SettlementRef,
  req: SettlementRequest,
): Promise<Outcome<void>> {
  if (!deps.chainVerifier || ref.kind !== "stellar") return ok(undefined);
  const r = await deps.chainVerifier(ref, req);
  if (r.ok) return r;
  // Never retry: the payment is already on the chain, resubmitting would double it.
  return fail(r.error.code, r.error.message, { retryable: false, cause: r.error.cause });
}

interface AdvanceMeta {
  quoteFee?: Money;
  networkFee?: string;
  amountRefunded?: string;
  amountFee?: string;
  checks?: readonly CheckResult[];
}

interface RunContext {
  advance(to: CorridorState, meta?: AdvanceMeta): Promise<Outcome<void>>;
  die(error: CorridorError, checks?: readonly CheckResult[]): Promise<Err>;
  finishFailure(error: CorridorError): Promise<Err>;
  /**
   * `breakerCause` is what the circuit breaker judges, when it differs from
   * `error`: the refund port refusing, or a refund watch timing out, is a
   * consequence, while the settlement/reconcile failure that put us in recovery
   * is the lane-level signal. See LANE_FAILURE_CODES in breaker.ts.
   */
  holdAndStop(
    error: CorridorError,
    status?: TransactionStatus,
    breakerCause?: CorridorError,
  ): Promise<Err>;
  /** Report a run that resolved outside this context (the resume handler). */
  recordOutcome: RecordOutcome;
}

interface RunContextInit {
  run: StoredRun;
  trail: CorridorState[];
  corridor: Corridor;
  deps: EngineDeps;
  store: IdempotencyStore;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  /** Receiving-anchor adapter, used to watch an anchor-driven refund. */
  adapter: AnchorAdapter;
  routeTrust?: "attested" | "manifest";
  /** Reports a resolved run to the circuit breaker (no-op without `deps.health`). */
  recordOutcome: RecordOutcome;
}

/**
 * The transition + failure-handling closures shared by a fresh run and a resumed
 * one, so both take exactly the same recovery path.
 */
function createRunContext(init: RunContextInit): RunContext {
  const {
    run,
    trail,
    corridor,
    deps,
    store,
    now,
    sleep,
    pollMs,
    adapter,
    routeTrust,
    recordOutcome,
  } = init;

  const advance: RunContext["advance"] = async (to, meta) => {
    if (!canTransition(run.state, to)) {
      return fail("SETTLEMENT_FAILED", `illegal transition ${run.state} -> ${to}`);
    }
    const from = run.state;
    run.state = to;
    run.version += 1;
    trail.push(to);
    await store.put(run);
    await emitTransition(deps, run, from, now(), undefined, routeTrust, meta);
    return ok(undefined);
  };

  const die: RunContext["die"] = (error, checks) => failRun(init, error, checks);

  const holdAndStop: RunContext["holdAndStop"] = async (
    error,
    status,
    breakerCause = error,
  ) => {
    // `refund_pending` inherits `recovering`'s exits (state.ts), so it can be
    // held directly; anything else steps back into `recovering` first.
    if (run.state !== "recovering" && run.state !== "refund_pending") {
      const back = await advance("recovering");
      if (!back.ok) return die(back.error);
    }
    run.lastError = `${error.code}: ${error.message}`;
    const held = await advance("held", refundAudit(status?.refunds));
    if (!held.ok) return die(held.error);
    await recordOutcome("held", breakerCause);
    return { ok: false, error };
  };

  const refundAndStop = async (error: CorridorError): Promise<Err> => {
    if (run.state !== "recovering") {
      const back = await advance("recovering");
      if (!back.ok) return die(back.error);
    }
    // Money moved and the anchor itself reports a terminal failure: it is
    // already refunding (SEP-31 `refunds`), so we wait for its report instead of
    // asking the chain to reverse a payment it cannot reverse.
    if (hasSettlementRef(run) && run.transactionId && anchorTerminalStatus(error)) {
      run.lastError = `${error.code}: ${error.message}`;
      const pending = await advance("refund_pending");
      if (!pending.ok) return die(pending.error);
      const watched = await watchRefund(adapter, run.transactionId, {
        now,
        sleep,
        deadlineMs: now() + corridor.recovery.refund_wait_seconds * 1000,
        pollMs,
        corridorId: corridor.id,
        logger: deps.logger,
        metrics: deps.metrics,
      });
      if (watched.ok) {
        const info = watched.value.refunds;
        if (info && !hasRequestedRefund(run)) {
          const firstPayment = info.payments[0];
          if (firstPayment?.id) run.refundId = firstPayment.id;
        }
        const done = await advance("refunded", refundAudit(info));
        if (!done.ok) return die(done.error);
        await recordOutcome("refunded", error);
        return { ok: false, error };
      }
      // The run is held with the watch outcome in `lastError`; the caller still
      // sees the anchor's own terminal failure that started the recovery.
      const stopped = await holdAndStop(watched.error, statusFrom(watched.error.cause), error);
      return stopped.error === watched.error ? { ok: false, error } : stopped;
    }
    // Only reverse the chain if a payment actually went out. If settlement never
    // succeeded, there is nothing on-chain to undo — the sending anchor returns
    // the sender's funds off-chain — so we just record the refunded state.
    // If settlement was off-chain (adapter-reported), it cannot be reversed on-chain
    // by the submitter: escalate to a manual hold rather than falsely claiming refunded.
    // A refund already requested for this run is not requested again. The
    // stored id is the only evidence a resumed process has that it already
    // asked: without this check a crash between the refund and the next write
    // would send the money back twice.
    if (hasSettlementRef(run)) {
      if (run.settlementKind === "adapter" || run.settlementRef?.kind === "adapter") {
        return holdAndStop(
          {
            code: "REFUND_UNSUPPORTED",
            message:
              "adapter-reported settlement cannot be reversed on-chain; operator review needed",
            retryable: false,
          },
          undefined,
          error,
        );
      }
      if (!hasRequestedRefund(run)) {
        if (!run.settlementAmount) {
          return holdAndStop(
            {
              code: "SETTLEMENT_FAILED",
              message: "cannot refund: stored settlement amount is missing",
              retryable: false,
            },
            undefined,
            error,
          );
        }
        const originalRef: SettlementRef =
          run.settlementRef?.kind === "stellar"
            ? run.settlementRef
            : { kind: "stellar", stellarTxHash: run.stellarTxHash! };
        const req: RefundRequest = {
          original: originalRef,
          amount: {
            asset: corridor.settlement.bridge_asset,
            amount: run.settlementAmount,
          },
          corridor,
          reason: `${error.code}: ${error.message}`,
        };
        const refund = await deps.submitter.refund(req);
        // Couldn't reverse the chain payment — escalate to a manual hold.
        // `error`, not `refund.error`, is what the breaker judges: the refund port
        // refusing is a design invariant, while `error` is the reconcile/settlement
        // outage that put us here.
        if (!refund.ok) return holdAndStop(refund.error, undefined, error);
        // Recorded before the state advance that persists it, so the very next
        // write carries the id. Set once and never rewritten — see the coalesce
        // in PostgresIdempotencyStore.put.
        run.refundId = settlementId(refund.value);
      }
    }
    run.lastError = `${error.code}: ${error.message}`;
    const refunded = await advance("refunded");
    if (!refunded.ok) return die(refunded.error);
    await recordOutcome("refunded", error);
    return { ok: false, error };
  };

  // Terminal failure handling: reverse any on-chain settlement (refund), park for
  // manual intervention (hold), or give up — per the manifest's recovery policy.
  const finishFailure: RunContext["finishFailure"] = async (error) => {
    if (corridor.recovery.rollback === "refund_sender") return refundAndStop(error);
    if (corridor.recovery.rollback === "hold") return holdAndStop(error);
    return die(error);
  };

  return { advance, die, finishFailure, holdAndStop, recordOutcome };
}

/**
 * Move a run to `failed`, persist it and audit the transition: the body of
 * `die`. Standalone so a run whose route was refused, which has no adapter and
 * so no run context, takes exactly the same path.
 */
async function failRun(
  init: Pick<
    RunContextInit,
    "run" | "trail" | "deps" | "store" | "now" | "routeTrust" | "recordOutcome"
  >,
  error: CorridorError,
  checks?: readonly CheckResult[],
): Promise<Err> {
  const { run, trail, deps, store, now, routeTrust, recordOutcome } = init;
  if (!canTransition(run.state, "failed")) return { ok: false, error };
  const from = run.state;
  run.lastError = `${error.code}: ${error.message}`;
  run.state = "failed";
  run.version += 1;
  trail.push("failed");
  await store.put(run);
  await emitTransition(
    deps,
    run,
    from,
    now(),
    run.lastError,
    routeTrust,
    checks ? { checks } : undefined,
  );
  await recordOutcome("failed", error);
  return { ok: false, error };
}

/**
 * Ask the resolver for a route, turning a throw into ROUTE_REFUSED. Resolvers
 * fail closed by throwing (`UnattestedAnchorError`), and a third-party one may
 * throw for any reason; either way the engine must still own the run's state.
 * Not retryable: the same payment would be refused the same way.
 */
async function resolveRoute(
  resolver: RouteResolver,
  intent: PaymentIntent,
  corridor: Corridor,
): Promise<Outcome<RouteDecision>> {
  try {
    return ok(await resolver.resolve(intent, corridor));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return fail("ROUTE_REFUSED", `route resolver refused corridor ${corridor.id}: ${reason}`, {
      retryable: false,
      cause,
    });
  }
}

function toResult(run: StoredRun, trail: readonly CorridorState[]): RunResult {
  return {
    idempotencyKey: run.idempotencyKey,
    state: run.state,
    transactionId: run.transactionId,
    stellarTxHash: run.stellarTxHash,
    settlementKind: run.settlementKind,
    settlementRef: run.settlementRef,
    trail,
  };
}

function isTransactionStatus(value: unknown): value is TransactionStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "string" &&
    typeof (value as { settled?: unknown }).settled === "boolean"
  );
}

function statusFrom(value: unknown): TransactionStatus | undefined {
  return isTransactionStatus(value) ? value : undefined;
}

function refundAudit(
  info: TransactionStatus["refunds"],
): { amountRefunded?: string; amountFee?: string } | undefined {
  if (!info) return undefined;
  return {
    amountRefunded: info.amountRefunded.amount,
    amountFee: info.amountFee.amount,
  };
}

/** Log + audit a single transition. `run` must already be at its new state. */
async function emitTransition(
  deps: EngineDeps,
  run: StoredRun,
  from: CorridorState,
  at: number,
  error?: string,
  routeTrust?: "attested" | "manifest",
  meta?: {
    quoteFee?: Money;
    networkFee?: string;
    amountRefunded?: string;
    amountFee?: string;
    checks?: readonly CheckResult[];
  },
): Promise<void> {
  const entry: AuditEntry = {
    idempotencyKey: run.idempotencyKey,
    corridorId: run.corridorId,
    from,
    to: run.state,
    version: run.version,
    at,
    ...(error && { error }),
    ...(routeTrust && { routeTrust }),
    ...(meta?.quoteFee && { quoteFee: meta.quoteFee }),
    ...(meta?.networkFee && { networkFee: meta.networkFee }),
    ...(meta?.amountRefunded !== undefined && { amountRefunded: meta.amountRefunded }),
    ...(meta?.amountFee !== undefined && { amountFee: meta.amountFee }),
    // A copy, so a caller mutating its array afterwards cannot change what was recorded.
    ...(meta?.checks && meta.checks.length > 0 && { checks: [...meta.checks] }),
  };
  const logger = deps.logger ?? silentLogger;
  for (const c of meta?.checks ?? []) {
    // Only the check's own fields: `detail` is PII-free by contract (see
    // CheckResult) and nothing about the sender or recipient is added here.
    logger.log(c.passed ? "info" : "warn", "corridor.gate.check", {
      idempotencyKey: run.idempotencyKey,
      corridorId: run.corridorId,
      check: c.name,
      passed: c.passed,
      ...(c.code && { code: c.code }),
      detail: c.detail,
      durationMs: c.durationMs,
    });
  }
  // The per-check lines carry the results; keep the transition line flat.
  const { checks: _checks, ...transition } = entry;
  logger.log(error ? "error" : "info", "corridor.transition", transition);
  const metrics = deps.metrics ?? noopMetrics;
  metrics.increment("corridor.transition", { to: run.state, corridor: run.corridorId });
  if (isTerminal(run.state)) {
    metrics.increment("corridor.terminal", { state: run.state, corridor: run.corridorId });
  }
  await deps.audit?.record(entry);
  if (run.state === "held" || run.state === "refund_pending") {
    try {
      await deps.alerting?.raise({
        kind: run.state,
        corridorId: run.corridorId,
        idempotencyKey: run.idempotencyKey,
        stellarTxHash: run.stellarTxHash,
        lastError: run.lastError ?? error,
        at,
      });
    } catch (alertError) {
      (deps.logger ?? silentLogger).log("warn", "corridor.alert_failed", {
        corridorId: run.corridorId,
        idempotencyKey: run.idempotencyKey,
        kind: run.state,
        error: alertError instanceof Error ? alertError.message : String(alertError),
      });
    }
  }
}

/**
 * Resume a persisted run only when its prior settlement can be proved or safely
 * excluded. An ambiguous `settling` miss remains an operator conflict.
 */
async function resumeRun(
  existing: StoredRun,
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
  store: IdempotencyStore,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  stallThreshold: number,
  opts: ExecuteOptions,
  recordOutcome: RecordOutcome,
): Promise<Outcome<RunResult>> {
  const run: StoredRun = { ...existing };
  const trail: CorridorState[] = [run.state];
  const conflict = (detail: string) =>
    fail(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey ${run.idempotencyKey} cannot resume state=${run.state}: ${detail}`,
    );

  const routed = await resolveRoute(deps.resolver, intent, corridor);
  if (!routed.ok) {
    // A run that stopped before opening a receiving transaction moved no money
    // and would be failed as RESUME_STALE below anyway, so fail it now. Any
    // later state may have money on the chain or in flight (a `settled` run
    // still has to reconcile): leave the stored row untouched and resumable.
    if (run.state === "created" || run.state === "quoted" || run.state === "compliant") {
      return failRun({ run, trail, deps, store, now, recordOutcome }, routed.error);
    }
    return routed;
  }
  const route = routed.value;
  const context = createRunContext({
    run,
    trail,
    corridor,
    deps,
    store,
    now,
    sleep,
    pollMs,
    adapter: route.receiving,
    routeTrust: route.trust,
    recordOutcome,
  });

  // --- manifest pinning: fail closed if corridor configuration changed ---
  // A run records the stable hash of the manifest it started with. If the manifest
  // was edited after the run opened, resuming before settlement would continue
  // under rules it was never quoted or opened with (new asset issuer, new limits,
  // new recovery policy, different anchor endpoint).
  //
  // If the run has not settled, fail closed with MANIFEST_CHANGED without moving money.
  // If it already settled, the money is already on-chain, so continue reconcile
  // only (never re-settle) and log a warning.
  // Legacy rows without a manifestHash are treated as legacy (allowed to resume).
  const currentHash = hashCorridor(corridor);
  const hashMismatch = run.manifestHash !== undefined && run.manifestHash !== currentHash;

  if (hashMismatch) {
    const hasSettled = run.state === "settled" || run.state === "reconciled";
    if (!hasSettled) {
      return context.die({
        code: "MANIFEST_CHANGED",
        message: `corridor manifest changed since run opened (${run.manifestHash} !== ${currentHash}); refusing to resume un-settled run`,
        retryable: false,
      });
    }
    (deps.logger ?? silentLogger).log("warn", "corridor.manifest.changed", {
      idempotencyKey: run.idempotencyKey,
      corridorId: corridor.id,
      recordedManifestHash: run.manifestHash,
      currentManifestHash: currentHash,
      message: "manifest changed after settlement; resuming reconcile only",
    });
  }

  if (run.state === "created" || run.state === "quoted" || run.state === "compliant") {
    return context.die({
      code: "IDEMPOTENCY_CONFLICT",
      message: `RESUME_STALE: run stopped in ${run.state} before opening a receiving transaction; retry with a new idempotency key`,
      retryable: false,
    });
  }

  if (run.state === "funding") {
    if (!route.sending) return conflict("source adapter is unavailable");
    if (!run.sourceTransactionId) {
      // The adapter contract requires idempotency by the run key. This covers
      // a crash after the anchor accepted openDeposit but before we persisted
      // the returned transaction id.
      const deposit = await route.sending.openDeposit(intent, corridor);
      if (!deposit.ok) return context.finishFailure(deposit.error);
      run.sourceTransactionId = deposit.value.transactionId;
      run.version += 1;
      await store.put(run);
    }
    const funded = await waitForSourceDeposit(route.sending, run.sourceTransactionId, {
      now,
      sleep,
      deadlineMs: now() + corridor.recovery.timeout_seconds * 1000,
      pollMs,
      stallThreshold,
    });
    if (!funded.ok) return context.finishFailure(funded.error);
    const advanced = await context.advance("funded");
    if (!advanced.ok) return advanced;
  }

  if (run.state === "funded" && deps.gate) {
    // `funded` is before the destination gate. The persisted row does not
    // contain the full quote/open objects needed to safely reconstruct its
    // context, so never settle through a gate that cannot be re-evaluated.
    return conflict(
      "pre-settle gate cannot be re-evaluated on resume; operator review needed",
    );
  }

  if (
    run.state === "opened" ||
    run.state === "funded" ||
    run.state === "retrying" ||
    run.state === "verifying" ||
    run.state === "settling"
  ) {
    if (
      !run.transactionId ||
      !run.depositAddress ||
      !run.settlementAmount ||
      run.quoteExpiresAt === undefined ||
      run.quoteFirm === undefined
    ) {
      return conflict("persisted quote/open data is incomplete");
    }
    if (run.state === "funded" && run.quoteFirm && run.quoteExpiresAt <= now()) {
      return context.holdAndStop({
        code: "QUOTE_EXPIRED",
        message: `stored quote ${run.quoteId ?? "(unknown)"} expired during source funding`,
        retryable: false,
      });
    }
    if (!deps.submitter.findExisting) {
      return conflict("settlement submitter does not support findExisting");
    }
    const request: SettlementRequest = {
      to: run.depositAddress,
      memo: run.memo,
      memoType: run.memoType,
      amount: { asset: corridor.settlement.bridge_asset, amount: run.settlementAmount },
      corridor,
    };
    const found = await deps.submitter.findExisting(request);
    if (!found.ok) return found;

    // Walk the legal path up to `settling` (opened/retrying -> verifying ->
    // settling), as a fresh run would: the table in state.ts stays the guard.
    const enterSettling = async (): Promise<Outcome<void>> => {
      if (run.state === "funded") {
        const verifying = await context.advance("verifying");
        if (!verifying.ok) return verifying;
      }
      if (run.state === "opened" || run.state === "retrying") {
        const verifying = await context.advance("verifying");
        if (!verifying.ok) return verifying;
      }
      if (run.state === "verifying") return context.advance("settling");
      return ok(undefined);
    };

    let ref: SettlementRef | undefined;
    if (found.value) {
      if (corridor.source.protocol !== "prefunded" && !run.sourceTransactionId) {
        return conflict("an existing settlement has no recorded source deposit reference");
      }
      // A payment matching this exact request already exists: money moved
      // before the crash, so do not submit again.
      const entered = await enterSettling();
      if (!entered.ok) return context.die(entered.error);
      ref = found.value;
    } else if (run.state === "settling") {
      return conflict(
        "Horizon found no matching payment, but settlement may still be in flight",
      );
    } else {
      if (run.quoteFirm && run.quoteExpiresAt <= now()) {
        return context.die({
          code: "QUOTE_EXPIRED",
          message: `stored quote ${run.quoteId ?? "(unknown)"} expired before resumed settlement`,
          retryable: false,
        });
      }
      if (
        corridor.settlement.network === "public" &&
        route.trust === "manifest" &&
        !deps.trustManifestWithoutAttestation &&
        !opts.trustManifestWithoutAttestation
      ) {
        return context.die({
          code: "MANIFEST_INVALID",
          message: "refusing manifest route trust on public network without explicit opt-in",
          retryable: false,
        });
      }
      if (deps.gate) {
        // The gate needs the live quote and opened transaction, which a resumed
        // run no longer holds; never submit past a gate that cannot be re-run.
        return conflict(
          "pre-settle gate cannot be re-evaluated on resume; operator review needed",
        );
      }
      if (route.receiving.capabilities().kyc !== "none") {
        const compliance = await comply(route.receiving, intent, corridor);
        if (!compliance.ok) return context.die(compliance.error);
      }
      if (corridor.source.protocol !== "prefunded" && !run.sourceTransactionId) {
        if (!route.sending) return conflict("source adapter is unavailable");
        if (run.state !== "opened") return conflict("cannot safely enter source funding");
        const funding = await context.advance("funding");
        if (!funding.ok) return context.die(funding.error);
        const deposit = await route.sending.openDeposit(intent, corridor);
        if (!deposit.ok) return context.finishFailure(deposit.error);
        run.sourceTransactionId = deposit.value.transactionId;
        run.version += 1;
        await store.put(run);
        const funded = await waitForSourceDeposit(route.sending, run.sourceTransactionId, {
          now,
          sleep,
          deadlineMs: now() + corridor.recovery.timeout_seconds * 1000,
          pollMs,
          stallThreshold,
        });
        if (!funded.ok) return context.finishFailure(funded.error);
        const markedFunded = await context.advance("funded");
        if (!markedFunded.ok) return context.die(markedFunded.error);
      }
      if (run.quoteFirm && run.quoteExpiresAt <= now()) {
        if (run.sourceTransactionId) {
          return context.holdAndStop({
            code: "QUOTE_EXPIRED",
            message: `stored quote ${run.quoteId ?? "(unknown)"} expired before settlement`,
            retryable: false,
          });
        }
        return context.finishFailure({
          code: "QUOTE_EXPIRED",
          message: `stored quote ${run.quoteId ?? "(unknown)"} expired before settlement`,
          retryable: false,
        });
      }
      const entered = await enterSettling();
      if (!entered.ok) return context.die(entered.error);
      const submitted = await deps.submitter.submit(request);
      if (!submitted.ok) return context.finishFailure(submitted.error);
      ref = submitted.value;
    }
    run.settlementKind = ref.kind;
    run.settlementRef = ref;
    if (ref.kind === "stellar") {
      run.stellarTxHash = ref.stellarTxHash;
    }
    run.settlement = {
      to: request.to,
      memo: request.memo,
      memoType: request.memoType,
      amount: request.amount,
    };
    const settled = await context.advance("settled", {
      networkFee: ref.kind === "stellar" ? ref.feeCharged : undefined,
    });
    if (!settled.ok) return context.die(settled.error);
  }

  if (run.state === "settled") {
    if (!run.transactionId) return conflict("settled run has no transactionId");
    if (!hasSettlementRef(run)) return conflict("settled run has no settlement reference");
    if (
      deps.chainVerifier &&
      (run.settlementKind === "stellar" || (!run.settlementKind && run.stellarTxHash))
    ) {
      const saved = run.settlement;
      const ref =
        run.settlementRef ??
        (run.stellarTxHash
          ? { kind: "stellar" as const, stellarTxHash: run.stellarTxHash }
          : undefined);
      if (!saved || !ref || ref.kind !== "stellar") {
        // Written before the request was recorded: nothing to compare against.
        (deps.logger ?? silentLogger).log("warn", "corridor.verify.skipped", {
          idempotencyKey: run.idempotencyKey,
          reason: "run has no recorded settlement request",
        });
      } else {
        const v = await verifyOnChain(deps, ref, { ...saved, corridor });
        if (!v.ok) {
          // Money moved and the chain disagrees: park for a human, do not fail.
          const held = await context.holdAndStop(v.error);
          return held;
        }
      }
    }
    const reconciled = await reconcileUntil(route.receiving, run.transactionId, {
      now,
      sleep,
      deadlineMs: now() + corridor.recovery.timeout_seconds * 1000,
      pollMs,
      stallThreshold,
      wake: deps.waker?.signal(run.transactionId),
      externalStallMs: externalStallBudgetMs(corridor),
      corridorId: corridor.id,
      logger: deps.logger,
      metrics: deps.metrics,
    });
    if (!reconciled.ok) return context.finishFailure(reconciled.error);
    const advanced = await context.advance("reconciled");
    if (!advanced.ok) return advanced;
  }

  if (run.state === "reconciled") {
    const done = await context.advance("completed");
    if (!done.ok) return done;
    await recordOutcome("completed");
    return ok(toResult(run, trail));
  }

  if (run.state === "recovering" || run.state === "refund_pending") {
    if (!run.transactionId) return conflict("refund recovery has no receiving transactionId");
    const refundedError = fail(
      "RECONCILE_MISMATCH",
      `receiving transaction ${run.transactionId} was refunded`,
    );
    // What the breaker judges. The failure that sent this run into recovery is
    // not in memory after a restart, but its `lastError` was persisted, so read
    // the real cause back before anything below clears it. Falls back to the
    // refunded-reconcile error when there is nothing usable to read.
    const breakerCause = recoveredBreakerCause(run.lastError, refundedError.error);
    // A refund this run already requested is the evidence that the money is
    // on its way back; never request or wait for a second one.
    if (hasRequestedRefund(run)) {
      const refunded = await context.advance("refunded");
      if (!refunded.ok) return refunded;
      await recordOutcome("refunded", breakerCause);
      return refundedError;
    }
    if (run.state === "recovering") {
      const pending = await context.advance("refund_pending");
      if (!pending.ok) return pending;
    }
    const watched = await watchRefund(route.receiving, run.transactionId, {
      now,
      sleep,
      deadlineMs: now() + corridor.recovery.refund_wait_seconds * 1000,
      pollMs,
      corridorId: corridor.id,
      logger: deps.logger,
      metrics: deps.metrics,
    });
    if (watched.ok) {
      const info = watched.value.refunds;
      if (info) {
        const firstPayment = info.payments[0];
        if (firstPayment?.id) run.refundId = firstPayment.id;
      }
      run.lastError = undefined;
      const refunded = await context.advance("refunded", refundAudit(info));
      if (!refunded.ok) return refunded;
      await recordOutcome("refunded", breakerCause);
      return refundedError;
    }
    // The refund report this run was waiting on never came; the breaker still
    // judges the original failure (`breakerCause`), not the watch timeout.
    return context.holdAndStop(watched.error, statusFrom(watched.error.cause), breakerCause);
  }

  return conflict("state is not supported by the resume handler");
}

function externalStallBudgetMs(corridor: Corridor): number {
  return (
    Math.min(
      corridor.recovery.reconcile.external_stall_seconds,
      corridor.recovery.timeout_seconds,
    ) * 1000
  );
}

/** Wrap `deps.health` so breaker events reach `deps.metrics` exactly once. */
function meteredHealth(deps: EngineDeps): CorridorHealthStore | undefined {
  if (!deps.health) return undefined;
  // Already wrapped by the application: return it untouched rather than
  // double-counting every trip and reset.
  if (deps.health instanceof MeteredCorridorHealthStore) return deps.health;
  return new MeteredCorridorHealthStore(deps.health, deps.metrics ?? noopMetrics);
}

/** Keep a stored `lastError` readable in a one-line refusal message. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
