// Regression tests for the security and correctness findings fixed in Phase 0.
//
// Each block below reproduces a specific defect that was confirmed by execution
// against the pre-fix code. They are grouped here rather than scattered across
// the per-package suites so the whole class of "claimed control that did not
// actually hold" stays visible in one place — every one of these passed the type
// checker and the old test suite while being wrong.

import { describe, expect, it, vi } from "vitest";
import { createService } from "@corridor/service";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { InMemoryIdempotencyStore, type SettlementRef } from "@corridor/engine";
import { Sep31Adapter } from "@corridor/sep31";
import * as corridorTypes from "@corridor/types";
import { isSettleableAmount, isValidAmount, type Outcome } from "@corridor/types";

const loaded = loadCorridor("corridors/reference.corridor.yaml");
if (!loaded.ok) throw new Error("fixture manifest failed to load");
// The reference manifest is unverified/unproven, which caps payments at the canary
// amount. These tests exercise service behaviour, not the cap, so mark it proven.
const CORRIDOR: Corridor = {
  ...loaded.value,
  dest: {
    ...loaded.value.dest,
    endpoints: { ...loaded.value.dest.endpoints, endpoints_verified_at: "1970-01-01" },
  } as Corridor["dest"],
  proof: {
    canary_completed_at: "1970-01-01T00:00:00Z",
    stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    anchor_transaction_id: "canary-test",
    amount: "1",
    max_age_days: 50000,
  },
};

/** A submitter that records what it was asked to send, and always succeeds. */
function recordingSubmitter() {
  const sent: { asset: string; amount: string }[] = [];
  return {
    sent,
    submitter: {
      async submit(req: { amount: { asset: string; amount: string } }) {
        sent.push(req.amount);
        return {
          ok: true as const,
          value: { kind: "stellar" as const, stellarTxHash: "hash", ledger: 1 },
        };
      },
      async refund(): Promise<Outcome<SettlementRef>> {
        return {
          ok: false as const,
          error: { code: "SETTLEMENT_FAILED", message: "no", retryable: false },
        };
      },
    },
  };
}

function service(opts: {
  apiKeys?: Set<string>;
  rateLimit?: { capacity: number; refillPerSec: number };
  rateLimiter?: { take(key: string): boolean | Promise<boolean> };
  store?: InMemoryIdempotencyStore;
  submitter?: ReturnType<typeof recordingSubmitter>["submitter"];
  now?: () => number;
}) {
  return createService({
    corridors: new Map([[CORRIDOR.id, CORRIDOR]]),
    apiKeys: opts.apiKeys,
    rateLimit: opts.rateLimit,
    rateLimiter: opts.rateLimiter,
    now: opts.now,
    deps: {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      idempotency: opts.store ?? new InMemoryIdempotencyStore(),
      submitter: opts.submitter ?? recordingSubmitter().submitter,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    },
  });
}

function intent(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "k-1",
    corridorId: CORRIDOR.id,
    sender: { id: "sender-1" },
    recipient: { id: "recipient-1" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
    ...over,
  };
}

describe("amount validation", () => {
  // isValidAmount is a SIGNED syntax check — subAmounts needs negatives — and
  // using it as the payment guard let "-100.00" walk the state machine to
  // `completed` and reach the settlement submitter.
  it("isValidAmount accepts negatives; isSettleableAmount does not", () => {
    expect(isValidAmount("-100.00")).toBe(true);
    expect(isSettleableAmount("-100.00")).toBe(false);
    expect(isSettleableAmount("0")).toBe(false);
    expect(isSettleableAmount("0.0000000")).toBe(false);
    expect(isSettleableAmount("100.00")).toBe(true);
    expect(isSettleableAmount("not-a-number")).toBe(false);
  });

  it("rejects a negative amount at the HTTP boundary with 422", async () => {
    const rec = recordingSubmitter();
    const svc = service({ submitter: rec.submitter });
    const res = await svc.route({
      method: "POST",
      path: "/payments",
      body: intent({ sourceAmount: { asset: "USDC", amount: "-100.00" } }),
    });
    expect(res.status).toBe(422);
    // The point of the finding: nothing must reach the chain.
    expect(rec.sent).toHaveLength(0);
  });

  it("rejects a zero amount", async () => {
    const svc = service({});
    const res = await svc.route({
      method: "POST",
      path: "/payments",
      body: intent({ sourceAmount: { asset: "USDC", amount: "0" } }),
    });
    expect(res.status).toBe(422);
  });
});

describe("run ownership (IDOR)", () => {
  // A caller-chosen idempotency key is often guessable, so the key alone cannot
  // be the authorization. Before the fix, any valid key read any run — including
  // its stellarTxHash.
  it("does not let one API key read another key's run", async () => {
    const store = new InMemoryIdempotencyStore();
    const svc = service({ apiKeys: new Set(["alice", "bob"]), store });

    const created = await svc.route({
      method: "POST",
      path: "/payments",
      headers: { authorization: "Bearer alice" },
      body: intent({ idempotencyKey: "alice-invoice-0001" }),
    });
    expect(created.status).toBe(200);

    const asAlice = await svc.route({
      method: "GET",
      path: "/payments/alice-invoice-0001",
      headers: { authorization: "Bearer alice" },
    });
    expect(asAlice.status).toBe(200);

    const asBob = await svc.route({
      method: "GET",
      path: "/payments/alice-invoice-0001",
      headers: { authorization: "Bearer bob" },
    });
    // 404 not 403 — a 403 would confirm the key exists.
    expect(asBob.status).toBe(404);
    expect(JSON.stringify(asBob.body)).not.toContain("hash");
  });

  it("continues to accept legacy Set<string> API keys", async () => {
    const svc = service({ apiKeys: new Set(["legacy-key"]) });
    const response = await svc.route({
      method: "GET",
      path: "/payments/missing",
      headers: { authorization: "Bearer legacy-key" },
    });
    // Authentication succeeded; the requested run simply does not exist.
    expect(response.status).toBe(404);
  });

  it("never returns the raw lastError message to a caller", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.create({
      idempotencyKey: "failed-1",
      corridorId: CORRIDOR.id,
      state: "failed",
      version: 1,
      owner: "alice",
      lastError:
        "ANCHOR_UNAVAILABLE: https://internal.anchor.example/sep31 returned 500 body=...",
    });
    const svc = service({ apiKeys: new Set(["alice"]), store });
    const res = await svc.route({
      method: "GET",
      path: "/payments/failed-1",
      headers: { authorization: "Bearer alice" },
    });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain("ANCHOR_UNAVAILABLE");
    expect(body).not.toContain("internal.anchor.example");
  });
});

describe("rate limiting", () => {
  it("compares every configured secret using constantTimeEqual", async () => {
    const comparisons: string[] = [];
    const constantTimeEqual = corridorTypes.constantTimeEqual;
    const compareSpy = vi
      .spyOn(corridorTypes, "constantTimeEqual")
      .mockImplementation((candidate, presented) => {
        comparisons.push(candidate);
        return constantTimeEqual(candidate, presented);
      });
    try {
      const svc = service({
        apiKeys: new Set(["before", "matched", "after"]),
        rateLimit: { capacity: 10, refillPerSec: 1 },
      });
      const response = await svc.route({
        method: "GET",
        path: "/payments/missing",
        headers: { authorization: "Bearer matched" },
      });
      expect(response.status).toBe(404);
      // Matching occurs once for limiter identity and once for authentication.
      // Each pass must compare every configured candidate, including after a match.
      expect(comparisons).toEqual([
        "before",
        "matched",
        "after",
        "before",
        "matched",
        "after",
      ]);
    } finally {
      compareSpy.mockRestore();
    }
  });

  it("returns 401 for an invalid bearer credential", async () => {
    const svc = service({ apiKeys: new Set(["configured-key"]) });
    const response = await svc.route({
      method: "GET",
      path: "/payments/missing",
      headers: { authorization: "Bearer invalid-key" },
    });
    expect(response.status).toBe(401);
  });

  // The 401 used to return BEFORE the limiter, so wrong keys cost the attacker
  // nothing and could be tried at line rate.
  it("rate-limits failed authentication attempts", async () => {
    const svc = service({
      apiKeys: new Set(["real-key"]),
      rateLimit: { capacity: 3, refillPerSec: 0.0001 },
    });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await svc.route({
        method: "POST",
        path: "/payments",
        headers: { authorization: `Bearer guess-${i}` },
        clientIp: "10.0.0.1",
        body: {},
      });
      codes.push(res.status);
    }
    expect(codes).toContain(429);
  });

  // clientKey used to trust the RAW bearer, so rotating the token minted a fresh
  // bucket per request — with auth disabled the limiter was a no-op.
  it("cannot be bypassed by rotating an unrecognised bearer token", async () => {
    const svc = service({ rateLimit: { capacity: 2, refillPerSec: 0.0001 } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await svc.route({
        method: "GET",
        path: "/nope",
        clientIp: "10.0.0.2",
        headers: { authorization: `Bearer rotating-${i}` },
      });
      codes.push(res.status);
    }
    expect(codes).toContain(429);
  });

  it("still gives a recognised API key its own bucket", async () => {
    const svc = service({
      apiKeys: new Set(["key-a", "key-b"]),
      rateLimit: { capacity: 2, refillPerSec: 0.0001 },
    });
    // Drain key-a from one IP.
    for (let i = 0; i < 3; i++) {
      await svc.route({
        method: "GET",
        path: "/nope",
        clientIp: "10.0.0.3",
        headers: { authorization: "Bearer key-a" },
      });
    }
    // key-b from the SAME IP is unaffected: its bucket is keyed on the key.
    const res = await svc.route({
      method: "GET",
      path: "/nope",
      clientIp: "10.0.0.3",
      headers: { authorization: "Bearer key-b" },
    });
    expect(res.status).not.toBe(429);
  });
});

// --- SEP-31 adapter -------------------------------------------------------

type FetchArgs = [string, { method?: string; headers?: Record<string, string> }?];

/** Anchor stub. `on` maps a URL fragment to a response body. */
function anchorStub(handlers: {
  auth?: () => unknown;
  authFails?: boolean;
  sep12?: (url: string, init?: FetchArgs[1]) => unknown;
  quote?: () => unknown;
  tx?: (body: unknown) => unknown;
}) {
  const calls: { url: string; init?: FetchArgs[1]; body?: unknown }[] = [];
  const fetchImpl = (async (u: unknown, init?: FetchArgs[1] & { body?: string }) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const respond = (payload: unknown, ok = true, status = 200) => ({
      ok,
      status,
      json: async () => payload,
    });
    if (url.includes("/auth")) {
      if (handlers.authFails) return respond(null, false, 500);
      if (init?.method === "POST") {
        return respond({ token: "a.eyJleHAiOjk5OTk5OTk5OTl9.b" });
      }
      return respond(
        handlers.auth?.() ?? {
          transaction: "AAAA",
          network_passphrase: "Test SDF Network ; September 2015",
        },
      );
    }
    if (url.includes("/sep12"))
      return respond(handlers.sep12?.(url, init) ?? { id: "c", status: "ACCEPTED" });
    if (url.includes("/sep38")) return respond(handlers.quote?.() ?? {});
    if (url.includes("/sep31"))
      return respond(handlers.tx?.(body) ?? { id: "tx1", stellar_account_id: "GDEST" });
    return respond({});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const SIGNER = {
  account: "GOPERATOR_SIGNING_ACCOUNT",
  async signChallenge(x: string) {
    return x;
  },
};

describe("SEP-10 authentication", () => {
  // authToken() returned undefined on every failure and callers proceeded
  // ANONYMOUSLY, so an anchor that 500'd on /auth had its SEP-12 answer accepted
  // as an authenticated compliance verdict.
  it("fails closed when the handshake fails and a signer is configured", async () => {
    const stub = anchorStub({ authFails: true });
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.ensureCompliance(
      intent({ recipient: { id: "r", sep12Id: "cust-1" } }) as never,
      CORRIDOR,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ANCHOR_UNAVAILABLE");
    // The critical assertion: it must not have gone on to ask the anchor anyway.
    expect(stub.calls.some((c) => c.url.includes("/sep12"))).toBe(false);
  });
});

describe("SEP-12 compliance", () => {
  // The query used to be keyed to the OPERATOR's own SEP-10 account whenever a
  // signer was configured, so it answered "is the operator in good standing?"
  // and recorded that as the recipient's KYC verdict.
  it("queries the recipient's customer id, never the operator's account", async () => {
    const stub = anchorStub({});
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.ensureCompliance(
      intent({ recipient: { id: "internal-ref", sep12Id: "anchor-cust-42" } }) as never,
      CORRIDOR,
    );
    expect(res.ok).toBe(true);
    const kycCall = stub.calls.find((c) => c.url.includes("/sep12"));
    expect(kycCall).toBeDefined();
    expect(kycCall!.url).toContain("id=anchor-cust-42");
    expect(kycCall!.url).not.toContain("GOPERATOR_SIGNING_ACCOUNT");
  });

  it("fails closed when the recipient has no SEP-12 customer id", async () => {
    const stub = anchorStub({});
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.ensureCompliance(intent() as never, CORRIDOR);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("KYC_REQUIRED");
    expect(stub.calls.some((c) => c.url.includes("/sep12"))).toBe(false);
  });
});

describe("SEP-38 quotes", () => {
  // This fixture is the Anchor Platform reference server's ACTUAL response,
  // captured live. It is worth stating explicitly because the first version of
  // the consistency check below was written against an assumed model and the
  // live anchor rejected it:
  //
  //   price        1.0500035     conversion rate EXCLUDING fees
  //   total_price  1.1666705555  sell_amount / buy_amount, the all-in rate
  //   sell_amount  10            fee.total 1.00, charged on the sell side
  //   buy_amount   8.57          and 1.1666705555 × 8.57 ≈ 10 ✓
  //
  // So the invariant is `sell ≈ total_price × buy`, NOT `buy ≈ price × sell`,
  // which is inverted and uses the pre-fee rate.
  const quoteBody =
    (over: Record<string, string> = {}) =>
    () => ({
      id: "q1",
      price: "1.0500035",
      total_price: "1.1666705555",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      sell_amount: "10",
      buy_amount: "8.57",
      // A real SEP-38 server reports the fee in the asset it was asked to sell: the full
      // `stellar:CODE:ISSUER` id, issuer included.
      fee: {
        total: "1.00",
        asset: `stellar:${CORRIDOR.settlement.bridge_asset}:${CORRIDOR.settlement.asset_issuer}`,
      },
      ...over,
    });

  // sell_amount was destructured and discarded, so settle paid the amount we
  // ASKED for rather than the one the firm quote bound to.
  it("honours the anchor's sell_amount rather than the requested amount", async () => {
    const stub = anchorStub({ quote: quoteBody() });
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.requestQuote(
      intent({ sourceAmount: { asset: "USDC", amount: "100.00" } }) as never,
      CORRIDOR,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.sourceAmount.amount).toBe("10");
  });

  it("accepts the reference server's real quote unchanged", async () => {
    const stub = anchorStub({ quote: quoteBody() });
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.requestQuote(intent() as never, CORRIDOR);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.destAmount.amount).toBe("8.57");
  });

  it("rejects a quote whose total_price x buy_amount contradicts sell_amount", async () => {
    // total_price 2.0 × buy 8.57 = 17.14, but sell says 10.
    const stub = anchorStub({ quote: quoteBody({ total_price: "2.0000000" }) });
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.requestQuote(intent() as never, CORRIDOR);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("QUOTE_UNAVAILABLE");
  });

  it("skips the check rather than guessing when total_price is absent", async () => {
    const body = quoteBody();
    const stub = anchorStub({
      quote: () => {
        const b = body() as Record<string, unknown>;
        delete b.total_price;
        return b;
      },
    });
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.requestQuote(intent() as never, CORRIDOR);
    expect(res.ok).toBe(true);
  });

  it("tolerates payout-precision rounding", async () => {
    // The reference server's own numbers do not multiply out exactly:
    // 1.1666705555 × 8.57 = 9.99996766… against a sell_amount of 10. Anchors
    // round to the payout asset's precision (2dp here) while quoting price to
    // 10, so an exact-equality check would reject every real quote.
    const stub = anchorStub({ quote: quoteBody() });
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const res = await adapter.requestQuote(intent() as never, CORRIDOR);
    expect(res.ok).toBe(true);
  });
});

describe("SEP-31 open", () => {
  it("sends the receiver's SEP-12 id and the quote's sell amount", async () => {
    const stub = anchorStub({});
    const adapter = new Sep31Adapter(CORRIDOR, { sep10: SIGNER, fetchImpl: stub.fetchImpl });
    const quote = {
      id: "q1",
      price: "1.0000000",
      expiresAt: Date.now() + 60_000,
      sourceAmount: { asset: "USDC", amount: "99.50" },
      destAmount: { asset: "iso4217:USD", amount: "99.50" },
      firm: true,
    };
    const res = await adapter.openTransaction(
      intent({ recipient: { id: "r", sep12Id: "anchor-cust-42" } }) as never,
      quote,
      CORRIDOR,
    );
    expect(res.ok).toBe(true);
    const txCall = stub.calls.find((c) => c.url.includes("/sep31/transactions"));
    expect(txCall?.body).toMatchObject({ receiver_id: "anchor-cust-42", amount: "99.50" });
  });
});
