// @corridor/adapter-kit — the seam between the engine and any anchor.
//
// The engine knows ONLY this interface. It never knows whether the thing on the
// other side is Anclap, Bitso, a testnet reference server, or a bespoke OTC desk.
// Standards-compliant anchors are served by one generic adapter (@corridor/sep31);
// bespoke integrations implement this same interface and (in the real product)
// could be implemented separately; no private implementation is included here.

import type { ComplianceMethod, Corridor } from "@corridor/manifest";
import {
  applyPrice,
  compareAmounts,
  fail,
  isValidAmount,
  ok,
  subAmounts,
  type Money,
  type Outcome,
  type PaymentIntent,
  type SettlementRef,
  settlementId,
} from "@corridor/types";

export { type SettlementRef, settlementId };
export { Sep10Client, jwtExpiryMs, type Sep10Signer } from "./sep10";
export { Sep12ComplianceCheck, type Sep12ComplianceCheckOptions } from "./sep12";
export type { ComplianceMethod };

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

/**
 * Deposit instructions returned by an anchor describing where or how to settle funds.
 * Discriminated union supporting on-chain Stellar payments, claimable balance funding,
 * and off-chain / adapter-settled transactions (#183).
 */
export type DepositInstructions =
  | {
      readonly kind: "stellar_payment";
      readonly to: string;
      readonly memo?: string;
      readonly memoType?: "text" | "hash" | "id";
      readonly asset?: string;
    }
  | {
      readonly kind: "claimable_balance";
      readonly claimant: string;
      readonly asset?: string;
      readonly predicateSeconds?: number;
    }
  | {
      readonly kind: "adapter_settled";
      readonly reference?: string;
    };

/**
 * Extract legacy flat address and memo fields from an OpenTransaction.
 * Retained for backward compatibility during transition to instructions union.
 */
export function toLegacy(tx: OpenTransaction): {
  readonly depositAddress?: string;
  readonly memo?: string;
  readonly memoType?: "text" | "hash" | "id";
} {
  if (tx.instructions && tx.instructions.kind === "stellar_payment") {
    return {
      depositAddress: tx.instructions.to,
      memo: tx.instructions.memo,
      memoType: tx.instructions.memoType,
    };
  }
  return {
    depositAddress: tx.depositAddress,
    memo: tx.memo,
    memoType: tx.memoType,
  };
}

/** Returned by the receiving anchor's SEP-31 POST /transactions — where to send the bridge asset. */
export interface OpenTransaction {
  readonly transactionId: string;
  readonly instructions: DepositInstructions;
  readonly amountIn?: Money;
  /**
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly depositAddress?: string;
  /**
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly memo?: string;
  /**
   * How to encode `memo` on the settlement transaction.
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
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

/** The `refunds` object as SEP-6 / SEP-31 puts it on the wire — every field untrusted. */
export interface RawRefunds {
  amount_refunded?: unknown;
  amount_fee?: unknown;
  payments?: unknown;
}

/**
 * Parse SEP-6 / SEP-31's `refunds` object off a transaction record.
 *
 * Everything is optional and untrusted: anchors omit `refunds` entirely on the
 * happy path, amounts arrive as strings, and a malformed field must never turn
 * a poll into an error — the status classification is what the engine acts on
 * and it is decided independently of this.
 *
 * Returns undefined rather than a zero-filled object when the refund cannot be
 * read: "refunded nothing" and "said nothing" are different facts, and the
 * engine must not be able to confuse them.
 *
 * @param settledAmount the amount that went out (`amount_in`), used to tell a
 * partial refund from a full one. Compared with `compareAmounts` — "100" and
 * "100.00" are the same amount of money and string equality says otherwise.
 */
export function parseRefunds(
  refunds: unknown,
  asset: string,
  settledAmount?: string,
): RefundInfo | undefined {
  if (!refunds || typeof refunds !== "object" || Array.isArray(refunds)) return undefined;
  const raw = refunds as RawRefunds;

  const parseAmt = (v: unknown): string | undefined => {
    return typeof v === "string" && isValidAmount(v.trim()) ? v.trim() : undefined;
  };

  const amountRefunded = parseAmt(raw.amount_refunded);
  if (amountRefunded === undefined) return undefined;

  const amountFee = parseAmt(raw.amount_fee) ?? "0";

  const payments: RefundPayment[] = [];
  if (Array.isArray(raw.payments)) {
    for (const entry of raw.payments) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const p = entry as { id?: unknown; id_type?: unknown; amount?: unknown; fee?: unknown };
      const amount = parseAmt(p.amount);
      if (typeof p.id !== "string" || !p.id || amount === undefined) continue;
      payments.push({
        id: p.id,
        ...(typeof p.id_type === "string" && p.id_type ? { idType: p.id_type } : {}),
        amount: { asset, amount },
        fee: { asset, amount: parseAmt(p.fee) ?? "0" },
      });
    }
  }

  const settled = settledAmount !== undefined ? parseAmt(settledAmount) : undefined;
  let completeness: RefundInfo["completeness"] = "unknown";
  if (settled !== undefined) {
    const cmp = compareAmounts(amountRefunded, settled);
    if (cmp.ok) completeness = cmp.value < 0 ? "partial" : "full";
  }

  return {
    amountRefunded: { asset, amount: amountRefunded },
    amountFee: { asset, amount: amountFee },
    payments,
    completeness,
  };
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
 * What an adapter supports, discoverable up front instead of by failing.
 * Exposes supported quote styles, KYC mechanism, settlement kinds, refunds and callbacks.
 */
export interface AdapterCapabilities {
  readonly protocol: string;
  readonly quotes: readonly ("sep38_firm" | "sep38_indicative" | "native" | "none")[];
  /** Same vocabulary as the manifest's `compliance.method`. */
  readonly kyc: ComplianceMethod;
  readonly settlement: readonly DepositInstructions["kind"][];
  readonly refunds: "request" | "report_only" | "none";
  readonly callbacks: boolean;
}

/**
 * A source of quotes, independent of the receiving adapter.
 */
export interface QuoteProvider {
  readonly source: "sep38" | "native" | "external";
  quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>>;
}

/**
 * Convert the corridor's bridge asset into the SEP-38 Asset Identification Format:
 * `stellar:native` for XLM, `stellar:CODE:ISSUER` for everything else. Anchors
 * reject issuer-less Stellar asset ids ("sell_asset not found").
 */
export function sep38SellAsset(corridor: Corridor): string {
  const code = corridor.settlement.bridge_asset;
  return code.toUpperCase() === "XLM"
    ? "stellar:native"
    : `stellar:${code}:${corridor.settlement.asset_issuer}`;
}

export const QUOTE_TOLERANCE = "0.001";

export interface Sep38QuoteProviderOptions {
  /**
   * The protocol context passed in SEP-38 POST /quote `context` field (e.g. "sep31", "sep6").
   * Defaults to "sep31".
   */
  readonly context?: string;
  /**
   * Optional custom fetch implementation (e.g. for mock testing).
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional name used in error messages (defaults to destination anchor name or "SEP-38").
   */
  readonly name?: string;
  /**
   * Explicit quote server URL or resolver function.
   * If omitted, falls back to `corridor.dest.endpoints.quote_server`.
   */
  readonly quoteServer?: string | ((corridor: Corridor) => string | undefined);
  /**
   * Supplier for bearer auth token (e.g. from SEP-10).
   */
  readonly authToken?: (corridor: Corridor) => Promise<Outcome<string | undefined>>;
}

/**
 * SEP-38 `total_price` is sell units per buy unit INCLUDING fees, so
 * `total_price x buy_amount` must land on `sell_amount` (within `QUOTE_TOLERANCE`).
 * Returns a description of the inconsistency, or undefined when the numbers agree or
 * the anchor did not send a usable `total_price`. Shared by every adapter that reads a
 * firm SEP-38 quote (SEP-31, SEP-6), so they cannot drift apart.
 */
export function totalPriceProblem(q: {
  quoteId: string;
  totalPrice: string | undefined;
  buyAmount: string;
  sellAmount: string;
}): string | undefined {
  const { quoteId, totalPrice, buyAmount, sellAmount } = q;
  if (!totalPrice || !isValidAmount(totalPrice) || !isValidAmount(buyAmount)) return undefined;
  const impliedSell = applyPrice(buyAmount, totalPrice);
  if (!impliedSell.ok) return undefined;
  const drift = subAmounts(impliedSell.value, sellAmount);
  const tolerance = applyPrice(sellAmount, QUOTE_TOLERANCE);
  if (!drift.ok || !tolerance.ok) return undefined;
  const abs = drift.value.startsWith("-") ? drift.value.slice(1) : drift.value;
  const within = compareAmounts(abs, tolerance.value);
  if (!within.ok || within.value <= 0) return undefined;
  return (
    `quote ${quoteId} is internally inconsistent — ` +
    `total_price ${totalPrice} × buy_amount ${buyAmount} = ` +
    `${impliedSell.value}, but sell_amount is ${sellAmount}`
  );
}

/**
 * Quote provider for `fx.quote_source: sep38`. Interacts with an anchor's SEP-38
 * quote server to obtain firm conversion rates with fees and expiration.
 */
export class Sep38QuoteProvider implements QuoteProvider {
  readonly source = "sep38" as const;

  constructor(private readonly opts: Sep38QuoteProviderOptions = {}) {}

  async quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const name = this.opts.name ?? corridor.dest.name ?? "SEP-38";
    const endpoints = corridor.dest.endpoints as Record<string, unknown>;
    const server =
      typeof this.opts.quoteServer === "function"
        ? this.opts.quoteServer(corridor)
        : (this.opts.quoteServer ??
          (typeof endpoints.quote_server === "string" ? endpoints.quote_server : undefined));
    if (!server) {
      return fail("QUOTE_UNAVAILABLE", `${name}: anchor exposes no SEP-38 quote server`);
    }

    let authHeader: Record<string, string> = {};
    if (this.opts.authToken) {
      const auth = await this.opts.authToken(corridor);
      if (!auth.ok) return auth;
      if (auth.value) {
        authHeader = { authorization: `Bearer ${auth.value}` };
      }
    }

    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const context = this.opts.context ?? "sep31";
      const sellAsset = sep38SellAsset(corridor);
      const buyAsset = corridor.dest.asset;

      const res = await fetchImpl(`${server}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({
          context,
          sell_asset: sellAsset,
          buy_asset: buyAsset,
          sell_amount: intent.sourceAmount.amount,
        }),
      });

      if (!res.ok) {
        return fail("QUOTE_UNAVAILABLE", `${name}: quote HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }

      const j = (await res.json()) as {
        id: string;
        price: string;
        total_price?: string;
        expires_at: string;
        sell_amount: string;
        buy_amount: string;
        fee?: { total: string; asset: string };
      };

      const sellAmount = j.sell_amount ?? intent.sourceAmount.amount;
      if (!isValidAmount(sellAmount)) {
        return fail(
          "QUOTE_UNAVAILABLE",
          `${name}: quote sell_amount "${sellAmount}" is malformed`,
        );
      }

      const inconsistent = totalPriceProblem({
        quoteId: j.id,
        totalPrice: j.total_price,
        buyAmount: j.buy_amount,
        sellAmount,
      });
      if (inconsistent) return fail("QUOTE_UNAVAILABLE", `${name}: ${inconsistent}`);

      let fee: Money | undefined;
      if (j.fee) {
        if (j.fee.asset !== sellAsset) {
          return fail(
            "QUOTE_UNAVAILABLE",
            `${name}: quote fee asset "${j.fee.asset}" does not match sell asset "${sellAsset}"`,
          );
        }
        if (isValidAmount(j.fee.total)) {
          fee = { asset: intent.sourceAmount.asset, amount: j.fee.total };
        }
      }

      return ok<Quote>({
        id: j.id,
        price: j.price,
        expiresAt: Date.parse(j.expires_at),
        sourceAmount: { asset: intent.sourceAmount.asset, amount: sellAmount },
        destAmount: { asset: buyAsset, amount: j.buy_amount },
        ...(fee && { fee }),
        firm: true,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${name}: quote request failed`, {
        retryable: true,
        cause,
      });
    }
  }
}

/**
 * Wraps an adapter's native quote handling into the `QuoteProvider` interface.
 */
export class AdapterQuoteProvider implements QuoteProvider {
  readonly source = "native" as const;

  constructor(private readonly adapter: AnchorAdapter) {}

  async quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    return this.adapter.requestQuote(intent, corridor);
  }
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
   * For off-chain / adapter-settled transactions (#186): confirm that settlement
   * moved off-chain and obtain a SettlementRef with the adapter's reference.
   */
  confirmSettlement?(transactionId: string): Promise<Outcome<SettlementRef>>;
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

/**
 * Adapter for the source anchor's deposit/on-ramp transaction.
 * `openDeposit` must be idempotent on `intent.idempotencyKey`, so a crash
 * after the source accepts the deposit but before its id is stored is safe to
 * resume.
 */
export interface SourceAnchorAdapter {
  openDeposit(
    intent: PaymentIntent,
    corridor: Corridor,
  ): Promise<Outcome<{ transactionId: string }>>;
  getDeposit(transactionId: string): Promise<Outcome<TransactionStatus>>;
}

/** Configurable source adapter for engine tests. */
export function createMockSourceAdapter(
  opts: { settled?: boolean } = {},
): SourceAnchorAdapter {
  let counter = 0;
  const deposits = new Map<string, boolean>();
  const byKey = new Map<string, string>();
  return {
    async openDeposit(intent) {
      const existing = byKey.get(intent.idempotencyKey);
      if (existing) return ok({ transactionId: existing });
      const transactionId = `source-deposit-${++counter}`;
      deposits.set(transactionId, opts.settled ?? true);
      byKey.set(intent.idempotencyKey, transactionId);
      return ok({ transactionId });
    },
    async getDeposit(transactionId) {
      const settled = deposits.get(transactionId);
      if (settled === undefined)
        return fail("ANCHOR_UNAVAILABLE", `unknown source deposit ${transactionId}`);
      return ok({ status: settled ? "completed" : "pending_sender", settled });
    },
  };
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
  /** Custom confirmSettlement handler or result for mock testing. */
  confirmSettlementResult?: Outcome<SettlementRef>;
  /** Deposit instructions for openTransaction to report. */
  instructions?: DepositInstructions;
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
      const defaultSettlement: readonly DepositInstructions["kind"][] = opts.instructions?.kind
        ? [opts.instructions.kind]
        : ["stellar_payment"];
      return {
        protocol: "mock",
        quotes: ["sep38_firm"],
        kyc: "sep12",
        settlement: defaultSettlement,
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
      const instructions: DepositInstructions = opts.instructions ?? {
        kind: "stellar_payment",
        to: "GMOCK000000000000000000000000000000000000000000000000",
        memo: "mock-memo",
      };
      const tx: OpenTransaction = {
        transactionId: `tx_${++counter}`,
        instructions,
        amountIn: quote.sourceAmount,
        depositAddress: instructions.kind === "stellar_payment" ? instructions.to : undefined,
        memo: instructions.kind === "stellar_payment" ? instructions.memo : undefined,
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
    async confirmSettlement(transactionId) {
      if (opts.confirmSettlementResult) return opts.confirmSettlementResult;
      return ok<SettlementRef>({
        kind: "adapter",
        reference: `adapter_ref_${transactionId}`,
        reportedAt: Date.now(),
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

export * from "./conformance";
