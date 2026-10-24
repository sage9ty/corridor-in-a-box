import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import {
  AdapterQuoteProvider,
  createMockAdapter,
  Sep38QuoteProvider,
  type AnchorAdapter,
  type Quote,
  type QuoteProvider,
} from "@corridor/adapter-kit";
import {
  execute,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
} from "@corridor/engine";
import { fail, ok, type PaymentIntent } from "@corridor/types";
import { StaticRouteResolver } from "@corridor/router";

interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function res(body: unknown, ok = true, status = 200): FakeResponse {
  return { ok, status, body };
}

function fakeFetch(routes: Record<string, FakeResponse>) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const key = Object.keys(routes).find((k) => {
      const [m, sub] = k.split(" ");
      return m === method && url.includes(sub);
    });
    const r = key ? routes[key] : res({}, false, 404);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function corridorFixture(
  fx: Record<string, unknown> = {},
  endpoints: Record<string, string> = { quote_server: "https://d.example/sep38" },
): Corridor {
  const r = parseCorridor({
    id: "test-lane",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
        ...endpoints,
      },
    },
    fx: {
      path: ["ARS", "USDC", "ARS"],
      quote_source: "sep38",
      who_holds_risk: "receiving_anchor",
      quote_ttl_seconds: 60,
      min_quote_remaining_seconds: 45,
      ...fx,
    },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: { max_retries: 2 },
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error(`fixture invalid: ${r.error.message}`);
  return r.value;
}

const sampleIntent: PaymentIntent = {
  idempotencyKey: "intent-1",
  corridorId: "test-lane",
  sender: { id: "sender-1" },
  recipient: { id: "recip-1", sep12Id: "cust-1" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

describe("Sep38QuoteProvider", () => {
  it("requests quote with default context sep31 and bearer auth", async () => {
    const { fn, calls } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-1",
        price: "1.0",
        total_price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
      }),
    });
    const provider = new Sep38QuoteProvider({
      fetchImpl: fn,
      authToken: async () => ok("test-jwt-token"),
    });

    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.id).toBe("q-1");
      expect(q.value.firm).toBe(true);
      expect(q.value.sourceAmount).toEqual({ asset: "USDC", amount: "100" });
      expect(q.value.destAmount).toEqual({ asset: "iso4217:ARS", amount: "100" });
    }

    const call = calls.find((x) => x.url.includes("/sep38/quote"));
    const body = call?.body as Record<string, unknown> | undefined;
    expect(call?.headers.authorization).toBe("Bearer test-jwt-token");
    expect(body?.context).toBe("sep31");
    expect(body?.sell_amount).toBe("100");
  });

  it("supports custom context such as sep6", async () => {
    const { fn, calls } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-sep6",
        price: "1.5",
        total_price: "1.5",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "66.6666667",
      }),
    });
    const provider = new Sep38QuoteProvider({
      fetchImpl: fn,
      context: "sep6",
    });

    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(true);

    const call = calls.find((x) => x.url.includes("/sep38/quote"));
    const body = call?.body as Record<string, unknown> | undefined;
    expect(body?.context).toBe("sep6");
  });

  it("fails with QUOTE_UNAVAILABLE when quote server is missing", async () => {
    const provider = new Sep38QuoteProvider();
    const c = corridorFixture({}, {}); // no quote_server endpoint
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(q.error.message).toContain("no SEP-38 quote server");
    }
  });

  it("fails when authToken fails closed", async () => {
    const provider = new Sep38QuoteProvider({
      authToken: async () => fail("ANCHOR_UNAVAILABLE", "SEP-10 auth rejected"),
    });
    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(q.error.message).toContain("SEP-10 auth rejected");
    }
  });

  it("fails with QUOTE_UNAVAILABLE and retryable on HTTP 500", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({ error: "server error" }, false, 500),
    });
    const provider = new Sep38QuoteProvider({ fetchImpl: fn });
    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(q.error.retryable).toBe(true);
    }
  });

  it("fails with QUOTE_UNAVAILABLE when quote is internally inconsistent beyond QUOTE_TOLERANCE", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-bad-math",
        price: "1.0",
        total_price: "2.0", // 2.0 * 100 != 100
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
      }),
    });
    const provider = new Sep38QuoteProvider({ fetchImpl: fn });
    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(q.error.message).toContain("internally inconsistent");
    }
  });

  it("passes arithmetic cross-check when drift is within tolerance", async () => {
    // 100 / 85.714 = ~1.1666725
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-within-tolerance",
        price: "1.0",
        total_price: "1.1666705555",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "10",
        buy_amount: "8.57",
      }),
    });
    const provider = new Sep38QuoteProvider({ fetchImpl: fn });
    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(true);
  });

  it("handles fee validation: rejects foreign fee asset", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-bad-fee",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
        fee: { total: "1.0", asset: "stellar:EUR:GISSUER" },
      }),
    });
    const provider = new Sep38QuoteProvider({ fetchImpl: fn });
    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(q.error.message).toContain("does not match sell asset");
    }
  });

  it("maps unexpected fetch throw to ANCHOR_UNAVAILABLE", async () => {
    const provider = new Sep38QuoteProvider({
      fetchImpl: (async () => {
        throw new Error("DNS lookup failure");
      }) as unknown as typeof fetch,
    });
    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(q.error.retryable).toBe(true);
    }
  });
});

describe("AdapterQuoteProvider", () => {
  it("wraps an anchor adapter and reports source native", async () => {
    const mock = createMockAdapter({ price: "42.50" });
    const provider = new AdapterQuoteProvider(mock);
    expect(provider.source).toBe("native");

    const c = corridorFixture();
    const q = await provider.quote(sampleIntent, c);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.price).toBe("42.50");
      expect(q.value.firm).toBe(true);
    }
  });
});

describe("engine integration with QuoteProvider & quote_source native", () => {
  function makeDeps(overrides: Partial<EngineDeps> = {}, adapterOpts = {}): EngineDeps {
    return {
      resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
      ...overrides,
    };
  }

  it("fails closed when corridor specifies quote_source native but adapter does not support native quotes", async () => {
    const c = corridorFixture({ quote_source: "native" });
    const d = makeDeps({}, { capabilities: { quotes: ["sep38_firm"] } });
    const r = await execute(sampleIntent, c, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("MANIFEST_INVALID");
      expect(r.error.message).toContain("requires an adapter that reports native quotes");
    }
  });

  it("executes successfully when corridor specifies quote_source native and adapter reports native quotes", async () => {
    const c = corridorFixture({ quote_source: "native" });
    const d = makeDeps({}, { capabilities: { quotes: ["native"] }, price: "125.0" });
    const r = await execute(sampleIntent, c, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
    }
  });

  it("uses custom quoteProvider passed in EngineDeps", async () => {
    let customCalled = false;
    const customProvider: QuoteProvider = {
      source: "external",
      async quote(intent, corridor) {
        customCalled = true;
        return ok<Quote>({
          id: "custom-quote-id",
          price: "99.99",
          expiresAt: Date.now() + 60_000,
          sourceAmount: intent.sourceAmount,
          destAmount: { asset: corridor.dest.asset, amount: "99.99" },
          firm: false,
        });
      },
    };

    const c = corridorFixture();
    const d = makeDeps({ quoteProvider: customProvider });
    const r = await execute(sampleIntent, c, d);
    expect(r.ok).toBe(true);
    expect(customCalled).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
    }
  });

  it("supports quoteProvider factory function (corridor, adapter) => QuoteProvider", async () => {
    let factoryCalled = false;
    const factory = (corridor: Corridor, adapter: AnchorAdapter): QuoteProvider => {
      factoryCalled = true;
      return new AdapterQuoteProvider(adapter);
    };

    const c = corridorFixture();
    const d = makeDeps({ quoteProvider: factory });
    const r = await execute(sampleIntent, c, d);
    expect(r.ok).toBe(true);
    expect(factoryCalled).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
    }
  });
});
