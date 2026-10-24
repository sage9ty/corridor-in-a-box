// A FICTIONAL anchor API, served in-process.
//
// Nothing in this file names a real anchor, a real host, or a real endpoint.
// The host is "anchor.example" — RFC 2606 reserves `.example` for exactly this
// purpose — the routes below are invented, and the payloads are made up. What
// this file demonstrates is the SHAPE of a bespoke integration: how a
// proprietary HTTP API is wrapped in `AnchorAdapter`, and nothing more.
//
// The API is served by a `fetchImpl` handed to the adapter, so the whole
// example runs with no network, no port and no listener.

import { applyPrice, isValidAmount } from "@corridor/types";

export interface StubApiOptions {
  /** Dest units per 1 source unit. Defaults to "1.00". */
  readonly price?: string;
  /** How long a quote stays valid, in seconds. Defaults to 60. */
  readonly quoteTtlSeconds?: number;
  /** What the fictional KYC endpoint answers. Defaults to "accepted". */
  readonly kycStatus?: "accepted" | "pending" | "rejected";
  /** How many status polls report "pending" before the order reads "completed". */
  readonly pollsBeforeSettled?: number;
}

/**
 * The fictional account the stub pays into. Shape-correct (a G-address is one
 * `G` plus 55 base32 characters) but not a real account — it is a made-up
 * string, and nothing in this repository can send value to it.
 */
export const STUB_DEPOSIT_ACCOUNT = "GEXAMPLESTUBDEPOSITACCOUNT222222222222222222222222222222";

/** The fictional memo the stub expects on the settlement payment. */
export const STUB_MEMO_PREFIX = "STUB-ORDER";

interface StubOrder {
  readonly orderId: string;
  readonly depositAccount: string;
  readonly memo: string;
  readonly amount: string;
  polls: number;
}

/**
 * Build a `fetch` implementation that answers the stub anchor's four routes.
 *
 * The returned function is a plain `fetch`, so an adapter written against it
 * is exactly as testable as one written against a real HTTP API: pass it in as
 * `fetchImpl` and the adapter cannot tell the difference.
 */
export function createStubFetchImpl(opts: StubApiOptions = {}): typeof fetch {
  const price = opts.price ?? "1.00";
  const quoteTtlSeconds = opts.quoteTtlSeconds ?? 60;
  const kycStatus = opts.kycStatus ?? "accepted";
  const pollsBeforeSettled = opts.pollsBeforeSettled ?? 0;

  const orders = new Map<string, StubOrder>();
  let counter = 0;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const handler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? "GET").toUpperCase();

    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return json(400, { error: "malformed JSON body" });
      }
    }

    // POST /v1/quote — the anchor prices the pair itself (a "native" quote).
    if (method === "POST" && url.pathname === "/v1/quote") {
      const sellAmount = typeof body.sell_amount === "string" ? body.sell_amount : "";
      if (!isValidAmount(sellAmount)) {
        return json(400, { error: "sell_amount must be a decimal string" });
      }
      const priced = applyPrice(sellAmount, price);
      if (!priced.ok) {
        return json(400, { error: "price is not a usable decimal" });
      }
      counter += 1;
      return json(200, {
        quote_id: `stub_quote_${counter}`,
        price,
        expires_at: new Date(Date.now() + quoteTtlSeconds * 1000).toISOString(),
        sell_amount: sellAmount,
        buy_amount: priced.value,
        buy_asset: typeof body.buy_asset === "string" ? body.buy_asset : "iso4217:USD",
      });
    }

    // POST /v1/kyc — a bespoke compliance call, not SEP-12.
    if (method === "POST" && url.pathname === "/v1/kyc") {
      return json(200, {
        status: kycStatus,
        customer_id:
          typeof body.customer_id === "string" ? body.customer_id : "stub_customer_unknown",
      });
    }

    // POST /v1/orders — open the order; the anchor answers where to pay.
    if (method === "POST" && url.pathname === "/v1/orders") {
      const amount = typeof body.amount === "string" ? body.amount : "";
      if (!isValidAmount(amount)) {
        return json(400, { error: "amount must be a decimal string" });
      }
      counter += 1;
      const orderId = `stub_order_${counter}`;
      const order: StubOrder = {
        orderId,
        depositAccount: STUB_DEPOSIT_ACCOUNT,
        memo: `${STUB_MEMO_PREFIX}-${counter.toString().padStart(4, "0")}`,
        amount,
        polls: 0,
      };
      orders.set(orderId, order);
      return json(201, {
        order_id: order.orderId,
        deposit_account: order.depositAccount,
        memo: order.memo,
        amount: order.amount,
      });
    }

    // GET /v1/orders/{id} — poll the order.
    const orderMatch = /^\/v1\/orders\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && orderMatch) {
      const order = orders.get(orderMatch[1]);
      if (!order) {
        return json(404, { error: "unknown order" });
      }
      order.polls += 1;
      const settled = order.polls > pollsBeforeSettled;
      return json(200, {
        order_id: order.orderId,
        status: settled ? "completed" : "awaiting_funds",
        amount: order.amount,
      });
    }

    return json(404, { error: `no such route: ${method} ${url.pathname}` });
  };

  return handler as typeof fetch;
}
