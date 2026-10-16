// The settle leg is the ONLY thing that touches the chain — and it's a native
// Stellar payment, not a smart contract. The engine depends on this port; a real
// implementation wraps @stellar/stellar-sdk to build → sign → submit a payment
// (or pathPaymentStrictSend if routing through the DEX) of the bridge asset to
// the receiving anchor's deposit address, then watches Horizon for confirmation.
//
// Keeping it behind a port means the engine skeleton type-checks and runs without
// pulling the full Stellar SDK, and the real submitter is one swap away.

import type { Corridor } from "@corridor/manifest";
import { fail, ok, type Money, type Outcome } from "@corridor/types";
import type { OpenTransaction, Quote } from "@corridor/adapter-kit";
import { buildSettlementRequest } from "./verbs";

export interface SettlementRef {
  readonly stellarTxHash: string;
  readonly ledger?: number;
  /** Network fee actually charged, in stroops, as Horizon's `fee_charged` reports it. */
  readonly feeCharged?: string;
}

export interface SettlementRequest {
  readonly to: string;
  readonly memo?: string;
  /** How to encode `memo` on-chain. SEP-31 anchors are not all "text": the
   *  Anchor Platform issues base64 `hash` memos, which cannot be text-encoded. */
  readonly memoType?: "text" | "hash" | "id";
  readonly amount: Money;
  readonly corridor: Corridor;
  /** Epoch ms after which a firm quote expires and settlement must not land on-chain. */
  readonly validUntil?: number;
}

export interface RefundRequest {
  /** The settlement we are reversing. */
  readonly original: SettlementRef;
  readonly amount: Money;
  readonly corridor: Corridor;
  readonly reason: string;
}

/**
 * Independent post-settle check that the transaction the submitter reported
 * really contains the payment we asked for (destination, amount, asset, memo).
 * The engine otherwise trusts the submitter's hash and the anchor's `completed`
 * status. Optional: pass it on `EngineDeps.chainVerifier` to turn it on.
 *
 * Return a non-retryable `RECONCILE_MISMATCH` naming the differing field when
 * the chain disagrees with the request.
 */
export type ChainVerifier = (
  ref: SettlementRef,
  req: SettlementRequest,
) => Promise<Outcome<void>>;

export interface SettlementSubmitter {
  /**
   * Check whether a matching settlement payment already exists on-chain before
   * submitting or re-submitting. Returns the existing ref if found, or undefined
   * if no matching payment exists.
   */
  findExisting?(req: SettlementRequest): Promise<Outcome<SettlementRef | undefined>>;
  submit(req: SettlementRequest): Promise<Outcome<SettlementRef>>;
  /**
   * Reverse a previously-submitted settlement (send the bridge asset back).
   * Only called when an on-chain payment actually went out; if it didn't, the
   * engine records the refund without touching the chain.
   */
  refund(req: RefundRequest): Promise<Outcome<SettlementRef>>;
}

export interface WakeSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", cb: () => void): void;
  removeEventListener(type: "abort", cb: () => void): void;
  /** Consume a delivered wake so the next poll sleeps normally again. */
  reset?(): void;
}

export interface ReconcileWaker {
  /** Return an abort signal for this transaction. */
  signal(transactionId: string): WakeSignal;
  /** Signal that this transaction should wake and poll immediately. */
  wake(transactionId: string): void;
}

export class InMemoryWaker implements ReconcileWaker {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly aborted = new Set<string>();

  signal(transactionId: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get aborted() {
        return self.aborted.has(transactionId);
      },
      addEventListener(type: "abort", cb: () => void) {
        if (!self.listeners.has(transactionId)) self.listeners.set(transactionId, new Set());
        self.listeners.get(transactionId)!.add(cb);
      },
      removeEventListener(type: "abort", cb: () => void) {
        self.listeners.get(transactionId)?.delete(cb);
      },
      reset() {
        self.aborted.delete(transactionId);
      },
    };
  }

  wake(transactionId: string) {
    this.aborted.add(transactionId);
    const set = this.listeners.get(transactionId);
    if (set) {
      for (const cb of set) cb();
    }
  }
}

/**
 * The kind of deposit instructions the receiving anchor issued.
 *
 * Today only `"stellar_payment"` is used — send the bridge asset to a Stellar
 * address with an optional memo. Additional kinds (`"claimable_balance"`,
 * `"adapter_settled"`) are reserved for future work (see issue #183).
 */
export type DepositInstructionsKind = "stellar_payment";

/**
 * Context passed to a `SettlementStrategy.settle()` call.
 */
export interface SettlementStrategyContext {
  readonly opened: OpenTransaction;
  readonly quote: Quote;
  readonly corridor: Corridor;
}

/**
 * A pluggable settlement strategy. The engine dispatches to the strategy whose
 * `kind` matches the deposit instructions returned by the receiving anchor.
 *
 * Today only `"stellar_payment"` is supported. When issue #183 lands and
 * `OpenTransaction.instructions.kind` becomes a discriminated union, add a
 * strategy per new kind without changing the engine's core.
 *
 * @example
 * ```ts
 * const custom: SettlementStrategy = {
 *   kind: "stellar_payment",
 *   async settle({ opened, quote, corridor }) {
 *     // ... build and submit the payment
 *   },
 * };
 * ```
 */
export interface SettlementStrategy {
  /** Must match `DepositInstructionsKind`. The engine picks the first strategy
   *  whose `kind` equals the deposit instructions kind on the opened tx. */
  readonly kind: DepositInstructionsKind;
  settle(ctx: SettlementStrategyContext): Promise<Outcome<SettlementRef>>;
}

/**
 * Default `SettlementStrategy` wrapping the existing `SettlementSubmitter`.
 *
 * Behaviour is identical to the previous hard-wired `settle()` verb: it builds a
 * `SettlementRequest` from the opened transaction and delegates to `submitter.submit`.
 * Existing callers that supply only `EngineDeps.submitter` keep working without any
 * changes — the engine derives `[new StellarPaymentStrategy(submitter)]` automatically.
 */
export class StellarPaymentStrategy implements SettlementStrategy {
  readonly kind: DepositInstructionsKind = "stellar_payment";

  constructor(private readonly submitter: SettlementSubmitter) {}

  async settle({
    opened,
    quote,
    corridor,
  }: SettlementStrategyContext): Promise<Outcome<SettlementRef>> {
    const req = buildSettlementRequest(opened, quote, corridor);
    return this.submitter.submit(req);
  }
}

/**
 * Derive the default strategy list when `EngineDeps.strategies` is absent.
 * Wraps the supplied `submitter` in a `StellarPaymentStrategy` so existing
 * callers require no changes.
 */
export function defaultStrategies(
  submitter: SettlementSubmitter,
): readonly SettlementStrategy[] {
  return [new StellarPaymentStrategy(submitter)];
}

/**
 * Default port. Returns a clear, actionable error pointing at the one integration
 * you owe. Replace with a StellarSubmitter built on @stellar/stellar-sdk:
 *
 *   const tx = new TransactionBuilder(source, { fee, networkPassphrase })
 *     .addOperation(Operation.payment({ destination: req.to, asset, amount: req.amount.amount }))
 *     .addMemo(req.memo ? Memo.text(req.memo) : Memo.none())
 *     .setTimeout(req.corridor.fx.quote_ttl_seconds)   // beat the firm-quote expiry
 *     .build();
 *   tx.sign(keypair);
 *   const res = await server.submitTransaction(tx);
 */
export class UnimplementedSubmitter implements SettlementSubmitter {
  async submit(): Promise<Outcome<SettlementRef>> {
    return fail(
      "SETTLEMENT_FAILED",
      "settlement not wired: implement SettlementSubmitter with @stellar/stellar-sdk (native payment to the anchor deposit address)",
    );
  }

  async refund(): Promise<Outcome<SettlementRef>> {
    return fail(
      "REFUND_UNSUPPORTED",
      "refund not wired: implement SettlementSubmitter.refund",
    );
  }
}

/** Test/example submitter: pretends the on-chain payment succeeded. */
export function createMockSubmitter(
  opts: { failSubmit?: boolean; existingRef?: SettlementRef } = {},
): SettlementSubmitter {
  let n = 0;
  const submitted: Array<{ request: SettlementRequest; reference: SettlementRef }> = [];
  const hash = (prefix: string) =>
    `${prefix}${(++n).toString().padStart(64 - prefix.length, "0")}`;
  return {
    async submit(req) {
      if (opts.failSubmit) {
        return fail("SETTLEMENT_FAILED", "mock submit configured to fail", {
          retryable: true,
        });
      }
      const reference = { stellarTxHash: hash("mocktx"), ledger: 1_000_000 + n };
      submitted.push({ request: req, reference });
      return ok<SettlementRef>(reference);
    },
    async findExisting(req) {
      if (opts.existingRef) return ok<SettlementRef | undefined>(opts.existingRef);
      const found = submitted.find(
        ({ request }) =>
          request.to === req.to &&
          request.memo === req.memo &&
          request.memoType === req.memoType &&
          request.amount.asset === req.amount.asset &&
          request.amount.amount === req.amount.amount,
      );
      return ok(found?.reference);
    },
    async refund(req) {
      void req;
      return ok<SettlementRef>({ stellarTxHash: hash("mockrf"), ledger: 1_000_000 + n });
    },
  };
}
