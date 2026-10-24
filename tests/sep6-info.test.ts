import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { Sep6Adapter, parseSep6Info } from "@corridor/sep6";

interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}
function res(body: unknown, ok = true, status = 200): FakeResponse {
  return { ok, status, body };
}

// Minimal router-style fetch fake. Keyed on `${METHOD} ${substring}`.
function fakeFetch(routes: Record<string, FakeResponse>) {
  const calls: { url: string; method: string }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
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

const INFO_FIXTURE = {
  withdraw: {
    ARS: {
      enabled: true,
      authentication_required: true,
      min_amount: 10,
      max_amount: 5000,
      fee_fixed: 5,
      fee_percent: 1.5,
      types: {
        bank_account: {
          fields: {
            dest: { description: "Account number" },
            dest_extra: { description: "CBU", optional: true },
            type: { choices: ["A", "B"] },
          },
        },
      },
    },
  },
  "withdraw-exchange": {
    ARS: {
      enabled: true,
      authentication_required: true,
      min_amount: 20,
      max_amount: 8000,
      fee_fixed: 4,
      fee_percent: 2,
      types: {
        bank_account: {
          fields: { dest: { description: "Account number" } },
        },
      },
    },
  },
};

function sep6Corridor(endpoints: Record<string, string> = {}): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      protocol: "sep6",
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server: "https://d.example/sep6",
        ...endpoints,
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

// A legacy SEP-31 dest (no explicit protocol) for the rejection test.
function sep31Corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "USDC",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

describe("parseSep6Info", () => {
  it("parses withdraw and withdraw-exchange entries, types and fields", () => {
    const info = parseSep6Info(INFO_FIXTURE);
    const w = info.withdraw.ARS;
    expect(w?.enabled).toBe(true);
    expect(w?.authenticationRequired).toBe(true);
    expect(w?.minAmount).toBe("10");
    expect(w?.maxAmount).toBe("5000");
    expect(w?.feeFixed).toBe("5");
    expect(w?.feePercent).toBe("1.5");
    expect(Object.keys(w?.types ?? {})).toEqual(["bank_account"]);
    expect(w?.types.bank_account?.fields.dest).toEqual({ description: "Account number" });
    expect(w?.types.bank_account?.fields.dest_extra).toEqual({
      description: "CBU",
      optional: true,
    });
    expect(w?.types.bank_account?.fields.type).toEqual({ choices: ["A", "B"] });
    expect(info.withdrawExchange.ARS?.minAmount).toBe("20");
  });

  it("drops malformed sections and entries rather than throwing", () => {
    const info = parseSep6Info({ withdraw: "nope", "withdraw-exchange": { ARS: null } });
    expect(info.withdraw).toEqual({});
    expect(info.withdrawExchange).toEqual({});
  });

  it("ignores amounts that do not survive as plain decimals", () => {
    const info = parseSep6Info({
      "withdraw-exchange": { ARS: { enabled: true, min_amount: 10, max_amount: 1e21 } },
    });
    expect(info.withdrawExchange.ARS?.minAmount).toBe("10");
    expect(info.withdrawExchange.ARS?.maxAmount).toBeUndefined();
  });

  it("treats a non-object document as empty", () => {
    expect(parseSep6Info(null)).toEqual({ withdraw: {}, withdrawExchange: {} });
  });
});

describe("Sep6Adapter", () => {
  it("rejects a non-SEP-6 destination with a clear error", () => {
    expect(() => new Sep6Adapter(sep31Corridor())).toThrow(
      'Sep6Adapter cannot handle protocol "sep31"',
    );
  });

  it("parses GET /info and derives capabilities from it", async () => {
    const { fn, calls } = fakeFetch({ "GET /info": res(INFO_FIXTURE) });
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fn });

    // Before discovery nothing is known; the engine reads capabilities() without
    // fetching /info, so the corridor's own stellar_payment lane is assumed.
    expect(adapter.capabilities().settlement).toEqual(["stellar_payment"]);

    const info = await adapter.info();
    expect(info.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const caps = adapter.capabilities();
    expect(caps.protocol).toBe("sep6");
    expect(caps.settlement).toEqual(["stellar_payment"]);
    // No kyc_server / quote_server on this corridor.
    expect(caps.kyc).toBe("sep6_fields");
    expect(caps.quotes).toEqual(["none"]);
    expect(caps.refunds).toBe("report_only");
    expect(caps.callbacks).toBe(false);
  });

  it("reports no settlement kinds when withdraw-exchange omits the dest asset", async () => {
    const fixture = { "withdraw-exchange": { USD: { enabled: true, types: {} } } };
    const adapter = new Sep6Adapter(sep6Corridor(), {
      fetchImpl: fakeFetch({ "GET /info": res(fixture) }).fn,
    });
    await adapter.info();
    expect(adapter.capabilities().settlement).toEqual([]);
  });

  it("reflects quote_server and kyc_server in capabilities", async () => {
    const adapter = new Sep6Adapter(
      sep6Corridor({
        quote_server: "https://d.example/sep38",
        kyc_server: "https://d.example/sep12",
      }),
      { fetchImpl: fakeFetch({ "GET /info": res(INFO_FIXTURE) }).fn },
    );
    await adapter.info();
    expect(adapter.capabilities().quotes).toEqual(["sep38_firm"]);
    expect(adapter.capabilities().kyc).toBe("sep12");
  });

  it("caches /info per instance", async () => {
    const { fn, calls } = fakeFetch({ "GET /info": res(INFO_FIXTURE) });
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fn });
    await adapter.info();
    await adapter.info();
    expect(calls).toHaveLength(1);
    await adapter.info(true);
    expect(calls).toHaveLength(2);
  });

  it("fails closed when /info is unavailable", async () => {
    const adapter = new Sep6Adapter(sep6Corridor(), {
      fetchImpl: fakeFetch({ "GET /info": res({}, false, 500) }).fn,
    });
    const result = await adapter.info();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
  });
});
