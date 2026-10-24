// A worked example of a BESPOKE adapter: an anchor that speaks a proprietary
// HTTP API instead of SEP-31.
//
// The engine knows only `AnchorAdapter`, so a bespoke anchor is not a special
// case anywhere else in the codebase — it is one more implementation of the
// same port. This file is the whole adapter: about 200 lines, no SEP code, and
// no engine changes.
//
// Everything it talks to is FICTIONAL: see `stub-api.ts` for the invented HTTP
// API it drives and the note on why no real anchor is named anywhere here.
//
// What it demonstrates, in the order the engine calls them:
//
//   requestQuote     -> a "native" quote: the anchor prices the pair itself
//   ensureCompliance -> a "bespoke" KYC call, not SEP-12
//   openTransaction  -> "stellar_payment" deposit instructions
//   getTransaction   -> polling until the order reads "completed"
//   requestRefund    -> refused: this fictional API has no refund endpoint
//
// The rules an adapter must not break (never throw, always return an `Outcome`,
// never leak PII into a message, never treat a malformed response as a
// success) are spelled out in `docs/adapters.md`.

import type {
  AdapterCapabilities,
  AnchorAdapter,
  DepositInstructions,
  KycResult,
  OpenTransaction,
  Quote,
  RefundRef,
  TransactionStatus,
} from "@corridor/adapter-kit";
import type { Corridor } from "@corridor/manifest";
import { fail, ok, type Money, type Outcome, type PaymentIntent } from "@corridor/types";

export interface HttpStubAdapterOptions {
  /**
   * Base URL of the anchor's bespoke API, e.g. "https://anchor.example".
   *
   * Required, and deliberately not guessed from the manifest at call time: the
   * engine polls `getTransaction(transactionId)` with no corridor in hand, so
   * the adapter has to know up front which anchor it is talking to.
   */
  readonly baseUrl: string;
  /** Custom fetch. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Adapter name, used in error messages. Defaults to "http-stub". */
  readonly name?: string;
}

/**
 * The base URL a manifest declares for a bespoke destination, if any.
 *
 * A `custom:<id>` destination carries `endpoints.base_url`; a SEP-31 or SEP-6
 * destination does not, and returns undefined here.
 */
export function bespokeBaseUrl(corridor: Corridor): string | undefined {
  const endpoints = corridor.dest.endpoints;
  return "base_url" in endpoints ? endpoints.base_url : undefined;
}

/**
 * Adapter for a fictional bespoke HTTP anchor.
 *
 * Fails closed rather than guessing: a manifest that names a different anchor
 * than the one this adapter was built for is a configuration mistake, and
 * routing value to the wrong anchor because two files disagreed is not a
 * recoverable mistake.
 */
export class HttpStubAdapter implements AnchorAdapter {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpStubAdapterOptions) {
    this.name = opts.name ?? "http-stub";
    this.baseUrl = opts.baseUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  capabilities(): AdapterCapabilities {
    return {
      protocol: "custom:http-stub",
      quotes: ["native"],
      kyc: "bespoke",
      settlement: ["stellar_payment"],
      refunds: "none",
      callbacks: false,
    };
  }

  async requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const mismatch = this.manifestMismatch(corridor);
    if (mismatch) return mismatch;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sell_amount: intent.sourceAmount.amount,
          buy_asset: corridor.dest.asset,
        }),
      });
      if (!res.ok) {
        return fail("QUOTE_UNAVAILABLE", `${this.name}: quote HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }

      // Everything below is untrusted wire data: read it field by field and
      // refuse the whole quote if any of it is missing or malformed.
      const j = (await res.json()) as Record<string, unknown>;
      const id = typeof j.quote_id === "string" ? j.quote_id : undefined;
      const price = typeof j.price === "string" ? j.price : undefined;
      const sellAmount = typeof j.sell_amount === "string" ? j.sell_amount : undefined;
      const buyAmount = typeof j.buy_amount === "string" ? j.buy_amount : undefined;
      const expiresAt =
        typeof j.expires_at === "string" ? Date.parse(j.expires_at) : Number.NaN;

      if (!id || !price || !sellAmount || !buyAmount || !Number.isFinite(expiresAt)) {
        return fail(
          "QUOTE_UNAVAILABLE",
          `${this.name}: quote response is missing or malformed`,
        );
      }

      return ok<Quote>({
        id,
        price,
        expiresAt,
        sourceAmount: { asset: intent.sourceAmount.asset, amount: sellAmount },
        destAmount: { asset: corridor.dest.asset, amount: buyAmount },
        firm: true,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: quote request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async ensureCompliance(
    intent: PaymentIntent,
    corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    const mismatch = this.manifestMismatch(corridor);
    if (mismatch) return mismatch;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/kyc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customer_id: intent.recipient.id,
          jurisdiction: corridor.compliance.dest_jurisdiction,
        }),
      });
      if (!res.ok) {
        return fail("KYC_REQUIRED", `${this.name}: kyc HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }

      const j = (await res.json()) as Record<string, unknown>;
      const raw = j.status;
      const status =
        raw === "accepted" || raw === "pending" || raw === "rejected" ? raw : undefined;
      if (status === undefined) {
        return fail("KYC_REQUIRED", `${this.name}: kyc response reported an unknown status`);
      }
      const customerId = typeof j.customer_id === "string" ? j.customer_id : undefined;
      return ok<KycResult>({
        status,
        ...(customerId ? { customerId } : {}),
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: kyc request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async openTransaction(
    _intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    const mismatch = this.manifestMismatch(corridor);
    if (mismatch) return mismatch;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amount: quote.sourceAmount.amount,
          asset: quote.sourceAmount.asset,
        }),
      });
      if (!res.ok) {
        return fail("SETTLEMENT_FAILED", `${this.name}: open HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }

      const j = (await res.json()) as Record<string, unknown>;
      const orderId = typeof j.order_id === "string" ? j.order_id : undefined;
      const to = typeof j.deposit_account === "string" ? j.deposit_account : undefined;
      if (!orderId || !to) {
        return fail(
          "SETTLEMENT_FAILED",
          `${this.name}: open response is missing the order id or the deposit account`,
          { retryable: false },
        );
      }
      const memo = typeof j.memo === "string" ? j.memo : undefined;
      const instructions: DepositInstructions = memo
        ? { kind: "stellar_payment", to, memo, memoType: "text" }
        : { kind: "stellar_payment", to };

      return ok<OpenTransaction>({
        transactionId: orderId,
        instructions,
        amountIn: quote.sourceAmount,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: open request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>> {
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/v1/orders/${encodeURIComponent(transactionId)}`,
        { method: "GET" },
      );
      if (res.status === 404) {
        return fail(
          "RECONCILE_MISMATCH",
          `${this.name}: unknown transaction ${transactionId}`,
          { retryable: false },
        );
      }
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: status HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }

      const j = (await res.json()) as Record<string, unknown>;
      const status = typeof j.status === "string" ? j.status : "unknown";
      return ok<TransactionStatus>({ status, settled: status === "completed" });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: status request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async requestRefund(
    _transactionId: string,
    _amount: Money,
    _reason: string,
  ): Promise<Outcome<RefundRef>> {
    return fail("REFUND_UNSUPPORTED", `${this.name}: this API has no refund endpoint`, {
      retryable: false,
    });
  }

  /**
   * The manifest and the adapter must name the same anchor.
   *
   * A mismatch is a configuration error, not something to paper over: routing
   * value to an anchor other than the one the corridor names is exactly the
   * mistake a manifest exists to prevent.
   */
  private manifestMismatch(corridor: Corridor): Outcome<never> | undefined {
    const declared = bespokeBaseUrl(corridor);
    if (declared && declared !== this.baseUrl) {
      return fail(
        "MANIFEST_INVALID",
        `${this.name}: corridor ${corridor.id} points at ${declared}, but this adapter is bound to ${this.baseUrl}`,
        { retryable: false },
      );
    }
    return undefined;
  }
}
