// The five verbs. Each is a small, testable function over the AnchorAdapter /
// SettlementSubmitter ports. run.ts sequences them and drives the state machine.
// In a larger codebase each of these becomes its own folder; one file is the
// right size while there's a single corridor exercising them.

import type { Corridor } from "@corridor/manifest";
import {
  fail,
  ok,
  type Outcome,
  type PaymentIntent,
  isSettleableAmount,
  STROOP_SCALE,
} from "@corridor/types";
import {
  toLegacy,
  type AnchorAdapter,
  type QuoteProvider,
  type KycResult,
  type OpenTransaction,
  type Quote,
  type TransactionStatus,
} from "@corridor/adapter-kit";
import {
  needsPathPayment,
  type DepositInstructionsKind,
  type SettlementRef,
  type SettlementRequest,
  type SettlementStrategy,
} from "./ports";
import type { Logger, Metrics } from "./observability";

// 1. QUOTE — SEP-38. Get a price and verify the firm-quote window hasn't already
//    closed. who_holds_risk in the manifest records who eats slippage if it does.
export async function quote(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
  now: number,
  provider?: QuoteProvider,
): Promise<Outcome<Quote>> {
  const q = provider
    ? await provider.quote(intent, corridor)
    : await adapter.requestQuote(intent, corridor);
  if (!q.ok) return q;
  if (q.value.firm && q.value.expiresAt <= now) {
    return fail("QUOTE_EXPIRED", `quote ${q.value.id} expired before use`, {
      retryable: true,
    });
  }
  return q;
}

// 2. COMPLY — SEP-10 auth + SEP-12 KYC handoff. Reject hard on rejection.
export async function comply(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
): Promise<Outcome<KycResult>> {
  const c = await adapter.ensureCompliance(intent, corridor);
  if (!c.ok) return c;
  if (c.value.status === "rejected") {
    return fail("KYC_REJECTED", "receiving anchor rejected the customer");
  }
  if (c.value.status === "pending") {
    return fail("KYC_REQUIRED", "KYC pending at receiving anchor", { retryable: true });
  }
  return c;
}

// 3a. OPEN — SEP-31 POST /transactions. Get the deposit address + memo.
export async function open(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  q: Quote,
  corridor: Corridor,
): Promise<Outcome<OpenTransaction>> {
  return adapter.openTransaction(intent, q, corridor);
}

/**
 * The exact settlement request `settle()` submits, factored out (#148) so the
 * `anchor.tx.match` gate check verifies the very request that will be built —
 * not a parallel reconstruction that could drift from it.
 */
export function buildSettlementRequest(
  opened: OpenTransaction,
  q: Quote,
  corridor: Corridor,
): SettlementRequest {
  const legacy = toLegacy(opened);
  return {
    to: legacy.depositAddress ?? "",
    memo: legacy.memo,
    memoType: legacy.memoType,
    amount: { asset: corridor.settlement.bridge_asset, amount: q.sourceAmount.amount },
    corridor,
    validUntil: q.firm ? q.expiresAt : undefined,
  };
}

/**
 * Why a quote must NOT be settled as-is, or null when it can be. `Quote.sourceAmount.asset` is the intent's
 * asset, while the on-chain leg pays the corridor's bridge asset: that relabel is only legitimate when the two
 * are the same asset, and the amount has to be exactly representable at 7 decimal places (stroops).
 */
export function settleQuoteProblem(q: Quote, corridor: Corridor): string | null {
  const bridge = corridor.settlement.bridge_asset;
  const sellAsset = q.sourceAmount.asset;
  const isMatch =
    sellAsset === bridge ||
    sellAsset === `stellar:${bridge}:${corridor.settlement.asset_issuer}` ||
    (bridge.toUpperCase() === "XLM" &&
      (sellAsset === "native" || sellAsset === "stellar:native"));
  if (!isMatch) {
    return `quote source asset "${sellAsset}" does not match settlement bridge asset "${bridge}"`;
  }
  if (!isSettleableAmount(q.sourceAmount.amount, STROOP_SCALE)) {
    return `settle amount "${q.sourceAmount.amount}" is not a valid settleable amount at ${STROOP_SCALE} decimal places`;
  }
  return null;
}

// 3b. SETTLE — the native on-chain payment of the bridge asset to the anchor.
//     Dispatches to the first strategy whose `kind` matches the deposit
//     instructions kind on the opened transaction (#183).
//
//     Unknown kind → non-retryable SETTLEMENT_FAILED so no money moves on an
//     unhandled path.
export async function settle(
  strategies: readonly SettlementStrategy[],
  opened: OpenTransaction,
  q: Quote,
  corridor: Corridor,
  adapter?: AnchorAdapter,
): Promise<Outcome<SettlementRef>> {
  // Refuse before anything is submitted: never relabel an asset or round an amount silently.
  const problem = settleQuoteProblem(q, corridor);
  if (problem) return fail("AMOUNT_INVALID", problem);

  const kind: DepositInstructionsKind =
    opened.instructions?.kind ??
    (opened as { kind?: DepositInstructionsKind }).kind ??
    "stellar_payment";
  const ctx = { opened, quote: q, corridor, adapter };
  const strategy = strategies.find((s) => s.kind === kind && (s.matches?.(ctx) ?? true));
  if (!strategy) {
    const { bridge_asset, receive_asset } = corridor.settlement;
    return fail(
      "SETTLEMENT_FAILED",
      strategies.some((s) => s.kind === kind)
        ? `every "${kind}" settlement strategy declined this corridor` +
            (needsPathPayment(corridor)
              ? ` (anchor receives ${receive_asset}, not bridge asset ${bridge_asset}) — add a path-payment strategy such as StellarPathPaymentStrategy to EngineDeps.strategies`
              : "")
        : `no settlement strategy registered for kind "${kind}" — add a SettlementStrategy with kind="${kind}" to EngineDeps.strategies`,
      { retryable: false },
    );
  }
  return strategy.settle(ctx);
}

// 4. RECONCILE — match the on-chain leg against the anchor's view of the payout.
//    A single status check (kept for tests / direct use).
export async function reconcile(
  adapter: AnchorAdapter,
  transactionId: string,
): Promise<Outcome<TransactionStatus>> {
  const s = await adapter.getTransaction(transactionId);
  if (!s.ok) return s;
  if (!s.value.settled) {
    return fail(
      "RECONCILE_MISMATCH",
      `tx ${transactionId} not settled (status=${s.value.status})`,
      { retryable: true },
    );
  }
  return s;
}

export interface PollOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Absolute epoch-ms after which we stop polling and time out. */
  deadlineMs: number;
  /** Delay between polls. */
  pollMs: number;
  /**
   * Number of consecutive polls returning the same status before we conclude
   * the anchor is stuck rather than legitimately slow. External phases use
   * `externalStallMs` instead. Once crossed,
   * `reconcileUntil` returns a non-retryable `RECONCILE_STALLED` carrying the
   * stuck status and the consecutive count.
   *
   * Omitted or `0` disables stall detection at this layer: `reconcileUntil`
   * reads `opts.stallThreshold ?? 0` (legacy behaviour).
   *
   * **Default here:** none (disabled). `execute()` in `run.ts` applies
   * `deps.stallThreshold ?? 10` and passes it down, so the production default
   * is `10`. With a typical `pollMs` of 2 s that is ≈ 20 s — well below the
   * corridor timeout but long enough that a legitimately slow anchor
   * transitioning through intermediate states won't be misdiagnosed.
   */
  stallThreshold?: number;
  /** Signal to cut the sleep short and poll immediately. */
  wake?: {
    readonly aborted: boolean;
    addEventListener(type: "abort", cb: () => void): void;
    removeEventListener(type: "abort", cb: () => void): void;
    reset?(): void;
  };
  /** Maximum elapsed time in an external phase before declaring a stall. */
  externalStallMs?: number;
  /** Corridor ID for metric tagging. Optional. */
  corridorId?: string;
  /** Logger for per-poll debug logs. Optional. */
  logger?: Logger;
  /** Metrics sink for per-poll counter. Optional. */
  metrics?: Metrics;
}

// 4'. RECONCILE (production) — poll the anchor until the payout settles or the
//     corridor's timeout elapses. Returns a NON-retryable error on timeout so the
//     engine routes straight to refund/hold instead of re-sending the payment.
//
//     Stall detection: when `stallThreshold` is set and the anchor returns the
//     same status for that many consecutive polls, we bail early with
//     `RECONCILE_STALLED` — the anchor is stuck, not slow. This lets the engine
//     recover (refund/hold) long before the corridor deadline expires.
export async function reconcileUntil(
  adapter: Pick<AnchorAdapter, "getTransaction">,
  transactionId: string,
  opts: PollOptions,
): Promise<Outcome<TransactionStatus>> {
  let firstStatus: string | undefined;
  let lastStatus = "unknown";
  let sameCount = 0;
  // Omitted or 0 disables stall detection at this layer; execute() applies the
  // production default of 10 one level up (run.ts) and passes it down.
  const threshold = opts.stallThreshold ?? 0;
  const externalStallMs = opts.externalStallMs ?? 6 * 60 * 60 * 1000;
  let poll = 0;
  const startedAt = opts.now();
  let lastAwaitingInput = false;
  let lastPhase: TransactionStatus["phase"];
  let externalStartedAt: number | undefined;
  let nextPollMs = opts.pollMs;
  for (;;) {
    poll += 1;
    const s = await adapter.getTransaction(transactionId);
    const rawStatus = s.ok ? s.value.status : "error";
    const elapsedMs = opts.now() - startedAt;

    opts.logger?.log("debug", "corridor.reconcile.poll", {
      transactionId,
      status: rawStatus,
      poll,
      elapsedMs,
    });

    opts.metrics?.increment("corridor.reconcile.poll", {
      ...(opts.corridorId ? { corridor: opts.corridorId } : {}),
      status: rawStatus,
    });

    // Recorded before the settled/terminal returns so `firstStatus` sees the
    // very first thing the anchor said, which is what makes an identical
    // first/last pair readable as a stalled observer.
    if (s.ok) {
      if (firstStatus === undefined) firstStatus = s.value.status;
      const statusChanged = s.value.status !== lastStatus;
      // A status identical to the previous poll's is what a stuck observer
      // looks like; any change resets the run of sameness.
      sameCount = s.value.status === lastStatus ? sameCount + 1 : 0;
      lastStatus = s.value.status;
      lastAwaitingInput = s.value.awaitingInput === true;
      lastPhase = s.value.phase;
      if (lastPhase === "external") {
        if (externalStartedAt === undefined) externalStartedAt = opts.now();
        if (statusChanged) nextPollMs = opts.pollMs;
      } else {
        externalStartedAt = undefined;
        nextPollMs = opts.pollMs;
      }
    }
    if (s.ok && s.value.settled) return s;
    // A terminal non-success at the anchor (error/expired/refunded): stop polling
    // now and let the engine recover, rather than waiting out the timeout. Non-
    // retryable so we never re-settle a payment that already terminally failed.
    if (s.ok && s.value.terminalFailure) {
      return fail(
        "RECONCILE_MISMATCH",
        `tx ${transactionId} terminally failed at anchor (status=${s.value.status})`,
        // The full terminal status rides along so the engine can read `status`
        // and `refunds` without a second poll. See `anchorTerminalStatus`.
        { retryable: false, cause: s.value },
      );
    }
    if (
      lastPhase === "external" &&
      externalStartedAt !== undefined &&
      opts.now() - externalStartedAt >= externalStallMs
    ) {
      const externalElapsedMs = opts.now() - externalStartedAt;
      return fail(
        "RECONCILE_STALLED",
        `tx ${transactionId} exhausted external stall budget at status=${lastStatus} ` +
          `(elapsed=${externalElapsedMs}ms, budget=${externalStallMs}ms)`,
        { retryable: false },
      );
    }
    if (lastPhase !== "external" && threshold > 0 && sameCount >= threshold) {
      return fail(
        "RECONCILE_STALLED",
        `tx ${transactionId} exhausted poll stall budget at status=${lastStatus} ` +
          `for ${sameCount} consecutive polls (budget=${threshold} polls)`,
        { retryable: false },
      );
    }
    if (opts.now() >= opts.deadlineMs) {
      // On a transient anchor error, surface it; otherwise it's a settle timeout.
      if (!s.ok) return s;
      // Whether the last status was blocked on someone's input decides who the
      // operator chases: a slow anchor, or the party that still owes the anchor
      // information. Both time out identically; only the message differs.
      const blocked = lastAwaitingInput ? ", awaiting input from another party" : "";
      return fail(
        "SETTLEMENT_TIMEOUT",
        `tx ${transactionId} did not settle before timeout (polls=${poll}, elapsed=${elapsedMs}ms, first status=${firstStatus ?? "unknown"}, last status=${lastStatus}${blocked})`,
        { retryable: false },
      );
    }
    const delay =
      lastPhase === "external"
        ? Math.min(nextPollMs, Math.max(opts.pollMs, 60_000))
        : opts.pollMs;
    if (opts.wake) {
      if (opts.wake.aborted) {
        // Wake already delivered: poll now, then consume it so we don't spin.
        opts.wake.reset?.();
        continue;
      }
      await new Promise<void>((resolve) => {
        let done = false;
        const complete = () => {
          if (done) return;
          done = true;
          opts.wake?.removeEventListener("abort", complete);
          resolve();
        };
        opts.wake?.addEventListener("abort", complete);
        opts.sleep(delay).then(complete).catch(complete);
      });
      opts.wake.reset?.();
    } else {
      await opts.sleep(delay);
    }
    nextPollMs =
      lastPhase === "external"
        ? Math.min(delay * 2, Math.max(opts.pollMs, 60_000))
        : opts.pollMs;
  }
}

export interface RefundPollOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Absolute epoch-ms after which the anchor refund wait is held. */
  deadlineMs: number;
  pollMs: number;
  corridorId?: string;
  logger?: Logger;
  metrics?: Metrics;
}

/**
 * Watch the receiving anchor's transaction record for the refund it owns.
 * SEP-31 reports refunds asynchronously on the transaction; the sending side
 * must not attempt a second, unilateral reversal while that report is pending.
 */
export async function watchRefund(
  adapter: AnchorAdapter,
  transactionId: string,
  opts: RefundPollOptions,
): Promise<Outcome<TransactionStatus>> {
  let poll = 0;
  const startedAt = opts.now();
  for (;;) {
    poll += 1;
    const result = await adapter.getTransaction(transactionId);
    const status = result.ok ? result.value.status : "error";
    const elapsedMs = opts.now() - startedAt;
    opts.logger?.log("debug", "corridor.refund.poll", {
      transactionId,
      status,
      poll,
      elapsedMs,
    });
    opts.metrics?.increment("corridor.refund.poll", {
      ...(opts.corridorId ? { corridor: opts.corridorId } : {}),
      status,
    });

    // SEP-31 reports the refund on the transaction record: either as a
    // `refunded` status or alongside a terminal failure (`error`/`expired`).
    if (
      result.ok &&
      result.value.refunds &&
      (result.value.status === "refunded" || result.value.terminalFailure === true)
    ) {
      const refund = result.value.refunds;
      if (refund.completeness === "full") return result;
      return fail("RECONCILE_MISMATCH", refundMessage(transactionId, refund), {
        retryable: false,
        cause: result.value,
      });
    }
    if (opts.now() >= opts.deadlineMs) {
      return fail(
        "SETTLEMENT_TIMEOUT",
        `refund for tx ${transactionId} was not fully reported before timeout (polls=${poll}, elapsed=${elapsedMs}ms)`,
        { retryable: false, cause: result.ok ? result.value : result.error },
      );
    }
    await opts.sleep(opts.pollMs);
  }
}

function refundMessage(
  transactionId: string,
  refund: NonNullable<TransactionStatus["refunds"]>,
): string {
  return `refund for tx ${transactionId} is ${refund.completeness}: amountRefunded=${refund.amountRefunded.amount} ${refund.amountRefunded.asset}, amountFee=${refund.amountFee.amount} ${refund.amountFee.asset}`;
}

/**
 * The anchor's terminal `TransactionStatus`, when `reconcileUntil` failed because
 * the anchor reported a terminal non-success state (carried on the error's
 * `cause`). Undefined for every other failure (timeout, stall, transport).
 */
export function anchorTerminalStatus(e: { cause?: unknown }): TransactionStatus | undefined {
  const c = e.cause as Partial<TransactionStatus> | undefined;
  return c &&
    typeof c === "object" &&
    c.terminalFailure === true &&
    typeof c.status === "string"
    ? (c as TransactionStatus)
    : undefined;
}

/** Exponential backoff with a cap, used between settlement retries. */
export function backoffMs(attempt: number, baseMs = 250, capMs = 5_000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, capMs);
}

// 5. RECOVER — decide what to do with a failed step, per the manifest policy.
export type RecoveryAction =
  | { kind: "retry"; attempt: number }
  | { kind: "refund" }
  | { kind: "hold" }
  | { kind: "give_up" };

export function recover(
  corridor: Corridor,
  retryable: boolean,
  attempt: number,
): RecoveryAction {
  if (retryable && attempt < corridor.recovery.max_retries) {
    return { kind: "retry", attempt: attempt + 1 };
  }
  switch (corridor.recovery.rollback) {
    case "refund_sender":
      return { kind: "refund" };
    case "hold":
      return { kind: "hold" };
    case "manual":
    default:
      return { kind: "give_up" };
  }
}

export { ok };
