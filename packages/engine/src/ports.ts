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
import {
  type AnchorAdapter,
  type DepositInstructions,
  type OpenTransaction,
  type Quote,
  type SettlementRef,
  settlementId,
} from "@corridor/adapter-kit";
import { buildSettlementRequest } from "./verbs";

export { type SettlementRef, settlementId };

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
 * Sourced directly from DepositInstructions in @corridor/adapter-kit (#183).
 * `"stellar_payment"` sends the bridge asset to a Stellar address with an optional memo;
 * `"claimable_balance"` creates an on-chain claimable balance for the recipient.
 */
export type DepositInstructionsKind = DepositInstructions["kind"];

/**
 * Context passed to a `SettlementStrategy.settle()` call.
 */
export interface SettlementStrategyContext {
  readonly opened: OpenTransaction;
  readonly quote: Quote;
  readonly corridor: Corridor;
  readonly adapter?: AnchorAdapter;
}

/**
 * A pluggable settlement strategy. The engine dispatches to the strategy whose
 * `kind` matches the deposit instructions returned by the receiving anchor.
 *
 * Supported kinds: `"stellar_payment"`, `"adapter_settled"`.
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
  /** Optional second filter after `kind`: return false to leave this settlement
   *  to another strategy of the same kind (e.g. a plain payment declining a
   *  corridor whose anchor receives a different asset). Omitted = accept all. */
  matches?(ctx: SettlementStrategyContext): boolean;
  settle(ctx: SettlementStrategyContext): Promise<Outcome<SettlementRef>>;
}

/**
 * True when the corridor's anchor receives a different on-chain asset than the
 * bridge asset we hold (`settlement.receive_asset`), so a plain payment would
 * deliver the wrong asset and the settle leg must path-pay through the DEX.
 */
export function needsPathPayment(corridor: Corridor): boolean {
  const { bridge_asset, asset_issuer, receive_asset, receive_asset_issuer } =
    corridor.settlement;
  if (receive_asset === undefined) return false;
  const bridgeIsXlm = bridge_asset.toUpperCase() === "XLM";
  const receiveIsXlm = receive_asset.toUpperCase() === "XLM";
  if (bridgeIsXlm || receiveIsXlm) return bridgeIsXlm !== receiveIsXlm;
  return receive_asset !== bridge_asset || receive_asset_issuer !== asset_issuer;
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

  /** A plain payment delivers the bridge asset, so it declines a corridor whose
   *  anchor receives something else — that is a path payment's job. */
  matches({ corridor }: SettlementStrategyContext): boolean {
    return !needsPathPayment(corridor);
  }

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
 * SettlementStrategy for off-chain / adapter-settled transactions (#186).
 * Dispatches to `adapter.confirmSettlement(transactionId)` when implemented.
 * When the adapter does not implement `confirmSettlement`, accepts pre-declared
 * `instructions.reference` on `adapter_settled` deposit instructions as proof of
 * settlement (for anchors where the opened transaction itself confirms pre-funding).
 */
export class AdapterSettledStrategy implements SettlementStrategy {
  readonly kind: DepositInstructionsKind = "adapter_settled";

  constructor(private readonly adapter?: AnchorAdapter) {}

  async settle(ctx: SettlementStrategyContext): Promise<Outcome<SettlementRef>> {
    const adapter = this.adapter ?? ctx.adapter;
    if (!adapter) {
      return fail(
        "SETTLEMENT_FAILED",
        "no AnchorAdapter available for adapter_settled strategy",
        { retryable: false },
      );
    }
    if (!adapter.confirmSettlement) {
      if (
        ctx.opened.instructions.kind === "adapter_settled" &&
        ctx.opened.instructions.reference
      ) {
        return ok<SettlementRef>({
          kind: "adapter",
          reference: ctx.opened.instructions.reference,
          reportedAt: Date.now(),
        });
      }
      return fail(
        "SETTLEMENT_FAILED",
        `adapter "${adapter.name}" does not implement confirmSettlement`,
        { retryable: false },
      );
    }
    return adapter.confirmSettlement(ctx.opened.transactionId);
  }
}

/**
 * Derive the default strategy list when `EngineDeps.strategies` is absent.
 * Wraps the supplied `submitter` in a `StellarPaymentStrategy` and includes
 * an `AdapterSettledStrategy` for off-chain settlements.
 */
export function defaultStrategies(
  submitter: SettlementSubmitter,
  adapter?: AnchorAdapter,
): readonly SettlementStrategy[] {
  return [new StellarPaymentStrategy(submitter), new AdapterSettledStrategy(adapter)];
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
  opts: { failSubmit?: boolean; failRefund?: boolean; existingRef?: SettlementRef } = {},
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
      const reference: SettlementRef = {
        kind: "stellar",
        stellarTxHash: hash("mocktx"),
        ledger: 1_000_000 + n,
      };
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
      if (opts.failRefund) {
        return fail("REFUND_UNSUPPORTED", "mock refund configured to fail", {
          retryable: false,
        });
      }
      return ok<SettlementRef>({
        kind: "stellar",
        stellarTxHash: hash("mockrf"),
        ledger: 1_000_000 + n,
      });
    },
  };
}
