// @corridor/adapter-kit — the seam between the engine and any anchor.
//
// The engine knows ONLY this interface. It never knows whether the thing on the
// other side is Anclap, Bitso, a testnet reference server, or a bespoke OTC desk.
// Standards-compliant anchors are served by one generic adapter (@corridor/sep31);
// bespoke integrations implement this same interface and (in the real product)
// could be implemented separately; no private implementation is included here.

import type { Corridor } from "@corridor/manifest";
import {
  applyPrice,
  fail,
  ok,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";

/** A SEP-38 quote. `firm` quotes carry an id + expiry and bind the deliverer to a rate. */
export interface Quote {
  readonly id: string;
  /** Dest units per 1 source unit. */
  readonly price: string;
  /** Epoch ms after which a firm quote is no longer honoured. */
  readonly expiresAt: number;
  readonly sourceAmount: Money;
  readonly destAmount: Money;
  readonly fee?: Money;
  readonly firm: boolean;
}

export interface KycResult {
  readonly status: "accepted" | "pending" | "rejected";
  readonly customerId?: string;
}

/** Returned by the receiving anchor's SEP-31 POST /transactions — where to send the bridge asset. */
export interface OpenTransaction {
  readonly transactionId: string;
  readonly depositAddress: string;
  readonly memo?: string;
  /**
   * How to encode `memo` on the settlement transaction. SEP-31 anchors return
   * this alongside the memo and it is NOT always "text" — the Anchor Platform
   * reference server issues base64 `hash` memos, which are 32 bytes and blow
   * past the 28-byte text limit if encoded as text. Defaults to "text" only when
   * the anchor says nothing.
   */
  readonly memoType?: "text" | "hash" | "id";
}

/**
 * One entry of SEP-31's `refunds.payments[]` — a single movement of money back,
 * which may be one of several making up a refund.
 */
export interface RefundPayment {
  /** Stellar transaction hash, or the anchor's own external payment id. */
  readonly id: string;
  /** `stellar` for an on-chain refund, `external` for an off-chain one. */
  readonly idType?: string;
  readonly amount: Money;
  /** What the anchor kept out of this payment. */
  readonly fee: Money;
}

/**
 * What a receiving anchor reports about a refund, from the `refunds` object on
 * the SEP-31 transaction record.
 *
 * This is *news*, not a request: over SEP-31 the sending side cannot ask for a
 * refund, it can only learn one happened (see `Sep31Adapter.requestRefund`).
 * Without this, a refund was visible only as the status flipping to `refunded`
 * — correct, but it left "how much came back" unanswerable, and a partial
 * refund indistinguishable from a full one.
 *
 * Amounts are `Money`, never numbers: the amount that came back is compared
 * against the amount that went out, and doing that in float64 is exactly the
 * bug the string-based money rule exists to prevent.
 */
export interface RefundInfo {
  /** Total returned to the sender, before the anchor's refund fee. */
  readonly amountRefunded: Money;
  /** Total the anchor kept for processing the refund. */
  readonly amountFee: Money;
  /** The individual payments making up the refund; may be empty. */
  readonly payments: readonly RefundPayment[];
  /**
   * Whether the whole payment came back.
   *
   * `unknown` when the anchor did not report an amount to compare against, or
   * reported one that could not be parsed — the caller is told it does not
   * know, rather than being handed a guess. Decided with `compareAmounts`, not
   * string equality: "100" and "100.00" are the same amount of money.
   */
  readonly completeness: "full" | "partial" | "unknown";
}

export interface TransactionStatus {
  /** The raw status string reported by the anchor (e.g. a SEP-31 status). */
  readonly status: string;
  /** The subsystem currently responsible for making progress on this status. */
  readonly phase?: "anchor" | "external";
  /** The payout is confirmed complete — the engine may finish. */
  readonly settled: boolean;
  /**
   * The transaction has reached a terminal NON-success state at the anchor
   * (e.g. SEP-31 `error` / `expired` / `refunded`). When set, the engine stops
   * polling immediately and routes to its recovery policy instead of waiting out
   * the corridor timeout. Absent/false means "not settled yet, keep polling".
   */
  readonly terminalFailure?: boolean;
  /**
   * In flight, but blocked on input from outside the engine rather than on the
   * anchor doing its work (SEP-31 `incomplete`, `pending_customer_info_update`,
   * `pending_transaction_info_update`). Polling continues either way — the
   * distinction is operational: a run that times out here timed out waiting on
   * a human, not on a slow anchor. Optional and purely informational; absent
   * means "not known to be blocked".
   */
  readonly awaitingInput?: boolean;
  /**
   * Refund detail, when the anchor reported any.
   *
   * Carried on the status rather than fetched separately because it arrives on
   * the same record the poll already reads: a second call would be a second
   * chance for the two to disagree. Absent whenever the anchor omits `refunds`
   * (the happy path) or reports one that cannot be trusted — never a
   * zero-filled placeholder, which would read as "refunded nothing" rather
   * than "said nothing".
   */
  readonly refunds?: RefundInfo;
  /**
   * The anchor's own record of what it expects to receive, read back off the
   * transaction (SEP-31 `amount_in` / `amount_in_asset`, `stellar_account_id`,
   * `stellar_memo`, `stellar_memo_type`).
   *
   * These exist so a caller can cross-check the opened transaction against the
   * payment it is about to submit before any money moves. Each is independent
   * and optional: absent whenever the anchor omits it or reports something that
   * cannot be read — never a guess. An adapter that cannot see them leaves them
   * all undefined.
   */
  readonly amountIn?: Money;
  readonly depositAddress?: string;
  readonly memo?: string;
  readonly memoType?: "text" | "hash" | "id";
}

/**
 * Reference returned when a refund request is accepted for processing.
 *
 * A refund is *requested* here and *reported* on `TransactionStatus.refunds`:
 * the request is the sender's side of the conversation, the report is the
 * anchor's. They are separate types because a request can be accepted and still
 * move no money yet — `status: "pending"` is the normal outcome, and the amounts
 * only become knowable later, on the transaction record the poll already reads.
 */
export interface RefundRef {
  readonly transactionId: string;
  readonly status: "pending" | "refunded" | "rejected";
  readonly refundId?: string;
  readonly message?: string;
}

/**
 * SHIM for #187 (minimal, to be reconciled with that issue's PR).
 * What an adapter supports, discoverable up front instead of by failing.
 * `settlement` is `readonly string[]` here because `DepositInstructions` (the
 * type #187 names) does not exist in this tree yet.
 */
export interface AdapterCapabilities {
  readonly protocol: string;
  readonly quotes: readonly ("sep38_firm" | "sep38_indicative" | "native" | "none")[];
  readonly kyc: "sep12" | "sep6_fields" | "bespoke" | "none";
  readonly settlement: readonly string[];
  readonly refunds: "request" | "report_only" | "none";
  readonly callbacks: boolean;
}

/**
 * SHIM for #189 (interface only, to be reconciled with that issue's PR).
 * A source of quotes, independent of the receiving adapter.
 */
export interface QuoteProvider {
  readonly source: "sep38" | "native" | "external";
  quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>>;
}

/** What the operator's pricing feed returns for an external quote. */
export interface ExternalQuote {
  /** Dest units per 1 source unit. */
  readonly price: string;
  /** Overrides the amount derived from `price` x source amount. */
  readonly destAmount?: Money;
  /** Epoch ms. Defaults to now + `fx.quote_ttl_seconds`. */
  readonly expiresAt?: number;
}

/** Operator-injected pricing function for `fx.quote_source: external`. */
export type ExternalQuoteFn = (
  intent: PaymentIntent,
  corridor: Corridor,
) => Promise<Outcome<ExternalQuote>>;

/**
 * Quote provider for `fx.quote_source: external`. The rate comes from an
 * operator-injected function; the returned Quote is always `firm: false`
 * because nobody at the receiving anchor has committed to it.
 */
export class ExternalQuoteProvider implements QuoteProvider {
  readonly source = "external" as const;
  private counter = 0;

  constructor(
    private readonly fn: ExternalQuoteFn,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    let r: Outcome<ExternalQuote>;
    try {
      r = await this.fn(intent, corridor);
    } catch (e) {
      return fail(
        "QUOTE_UNAVAILABLE",
        `external quote provider threw: ${e instanceof Error ? e.message : String(e)}`,
        { retryable: true },
      );
    }
    if (!r.ok) return r;
    const { price, destAmount, expiresAt } = r.value;
    const derived = applyPrice(intent.sourceAmount.amount, price);
    if (!derived.ok || !/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) {
      return fail(
        "QUOTE_UNAVAILABLE",
        `external quote price "${price}" is not a positive decimal`,
      );
    }
    return ok<Quote>({
      id: `ext_${this.now()}_${++this.counter}`,
      price,
      expiresAt: expiresAt ?? this.now() + corridor.fx.quote_ttl_seconds * 1000,
      sourceAmount: intent.sourceAmount,
      destAmount: destAmount ?? { asset: corridor.dest.asset, amount: derived.value },
      firm: false,
    });
  }
}

export interface AnchorAdapter {
  readonly name: string;
  /** Up-front description of what this adapter supports (see #187). */
  capabilities(): AdapterCapabilities;
  /** SEP-38: request an FX quote for this intent on this corridor. */
  requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>>;
  /** SEP-10 auth + SEP-12 KYC handoff. Verify once; pass identity through. */
  ensureCompliance(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<KycResult>>;
  /** SEP-31: open the transaction on the receiving anchor; get deposit instructions. */
  openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>>;
  /** Poll transaction status for reconciliation. */
  getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>>;
  /**
   * Request a refund from the receiving anchor.
   *
   * Refunds are anchor-driven operations, NOT unilateral on-chain reversals.
   * Standard SEP-31 anchors do not expose a sender-initiated refund endpoint
   * (the adapter returns REFUND_UNSUPPORTED), but bespoke anchor integrations
   * or proprietary OTC desks may implement this method to request an anchor-side
   * refund.
   */
  requestRefund(
    transactionId: string,
    amount: Money,
    reason: string,
  ): Promise<Outcome<RefundRef>>;
}

// --- Conformance ---------------------------------------------------------
// Any adapter — generic or bespoke — should pass the same probes before you
// trust it in a corridor. This is intentionally minimal; grow it as you learn
// which anchor behaviours actually break in production.

export interface ConformanceProbe {
  readonly name: string;
  run(): Promise<boolean>;
}

export function conformanceSuite(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
): ConformanceProbe[] {
  return [
    {
      name: "quote returns a future expiry",
      run: async () => {
        const q = await adapter.requestQuote(intent, corridor);
        return q.ok && q.value.expiresAt > Date.now();
      },
    },
    {
      name: "compliance resolves to a known status",
      run: async () => {
        const c = await adapter.ensureCompliance(intent, corridor);
        return c.ok && ["accepted", "pending", "rejected"].includes(c.value.status);
      },
    },
  ];
}

// --- Mock adapter --------------------------------------------------------
// A configurable in-memory anchor for tests and the runnable example. Lets you
// simulate the unhappy paths (expired quote, rejected KYC) without a network.

export interface MockAdapterOptions {
  name?: string;
  kyc?: KycResult["status"];
  /** Make the quote already-expired to exercise the QUOTE_EXPIRED path. */
  expireQuoteImmediately?: boolean;
  price?: string;
  settled?: boolean;
  /** Make getTransaction report a terminal anchor failure (error/expired/refunded). */
  terminalFailure?: boolean;
  /**
   * Which branch `requestRefund` takes, so a test can pick a refund outcome
   * without assembling a `RefundRef`:
   * - `"complete"` — the anchor accepted the refund and it is already done
   * - `"pending"`  — accepted, but the money has not moved yet (the default,
   *   and the honest common case: a refund is asynchronous at the anchor)
   * - `"rejected"` — the anchor declined it
   *
   * Omitted, `requestRefund` reports `"pending"`, so existing tests are
   * unaffected. `refundResult` overrides this when a test needs an exact
   * payload or a failure `Outcome`.
   */
  refund?: "complete" | "pending" | "rejected";
  /** Custom refund handler or result for mock testing. Overrides `refund`. */
  refundResult?: Outcome<RefundRef>;
  /** Refund detail for getTransaction to report, on the `refunds` field. */
  refundStatus?: RefundInfo;
  /** Override individual fields of the reported `capabilities()`. */
  capabilities?: Partial<AdapterCapabilities>;
}

export function createMockAdapter(opts: MockAdapterOptions = {}): AnchorAdapter {
  const name = opts.name ?? "mock-anchor";
  const price = opts.price ?? "1.00";
  let counter = 0;
  // What each opened transaction was told to expect, so getTransaction can
  // report it back the way a real anchor's record would.
  const opened = new Map<
    string,
    Pick<TransactionStatus, "amountIn" | "depositAddress" | "memo" | "memoType">
  >();
  return {
    name,
    capabilities() {
      return {
        protocol: "mock",
        quotes: ["sep38_firm"],
        kyc: "sep12",
        settlement: ["stellar_payment"],
        refunds: "request",
        callbacks: false,
        ...opts.capabilities,
      };
    },
    async requestQuote(intent) {
      const now = Date.now();
      return ok<Quote>({
        id: `q_${++counter}`,
        price,
        expiresAt: opts.expireQuoteImmediately ? now - 1 : now + 60_000,
        sourceAmount: intent.sourceAmount,
        destAmount: { asset: "iso4217:MOCK", amount: intent.sourceAmount.amount },
        firm: true,
      });
    },
    async ensureCompliance() {
      return ok<KycResult>({ status: opts.kyc ?? "accepted", customerId: "cust_mock" });
    },
    async openTransaction(_intent, quote) {
      const tx: OpenTransaction = {
        transactionId: `tx_${++counter}`,
        depositAddress: "GMOCK000000000000000000000000000000000000000000000000",
        memo: "mock-memo",
      };
      opened.set(tx.transactionId, {
        amountIn: quote.sourceAmount,
        depositAddress: tx.depositAddress,
        memo: tx.memo,
        memoType: tx.memoType,
      });
      return ok(tx);
    },
    async getTransaction(transactionId) {
      const expected = opened.get(transactionId);
      if (opts.terminalFailure) {
        return ok<TransactionStatus>({
          status: "error",
          settled: false,
          terminalFailure: true,
          refunds: opts.refundStatus,
          ...expected,
        });
      }
      return ok<TransactionStatus>({
        status: opts.settled === false ? "pending_receiver" : "completed",
        settled: opts.settled !== false,
        refunds: opts.refundStatus,
        ...expected,
      });
    },
    async requestRefund(transactionId, amount, reason) {
      if (opts.refundResult) return opts.refundResult;
      // "complete" maps to the port's `refunded`: the mock chooses a branch, it
      // does not model an anchor — the wire vocabulary stays on RefundRef.
      const status = opts.refund === "complete" ? "refunded" : (opts.refund ?? "pending");
      return ok<RefundRef>({
        transactionId,
        status,
        message: `Refund requested for ${amount.amount} ${amount.asset}: ${reason}`,
      });
    },
  };
}
