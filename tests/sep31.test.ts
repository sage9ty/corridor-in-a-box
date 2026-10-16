import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import {
  Sep31Adapter,
  mapSep31Status,
  openedTxCheck,
  receiverKycCheck,
  parseRefunds,
  sep31InfoCheck,
  amountRangeCheck,
  sep31GateChecks,
  type ReportedTransactionFields,
  type Sep10Signer,
  type Sep31InfoCheckResult,
} from "@corridor/sep31";
import { fail, ok, type PaymentIntent } from "@corridor/types";
import { CompositeGate, type GateContext } from "@corridor/engine";
import type { TransactionStatus } from "@corridor/adapter-kit";

const PASSPHRASE = "Test SDF Network ; September 2015";

function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

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

function corridor(
  endpoints: Record<string, string>,
  settlement: Record<string, string> = {},
): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: { home_domain: "d.example", ...endpoints },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER", ...settlement },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "k",
  corridorId: "test",
  sender: { id: "s" },
  // sep12Id is the customer id the RECEIVING anchor issued at registration. It
  // is what SEP-12 status is looked up by and what SEP-31 open sends as
  // receiver_id; without it the adapter fails closed rather than checking the
  // operator's own account (see tests/security.test.ts).
  recipient: { id: "recipient-acct", sep12Id: "anchor-cust-1" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

describe("SEP-10 auth", () => {
  it("rejects a non-SEP-31 destination with a clear error", () => {
    const raw = {
      id: "test",
      source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
      dest: {
        protocol: "sep6",
        name: "D",
        asset: "iso4217:ARS",
        endpoints: { home_domain: "d.example", transfer_server: "https://d.example/sep6" },
      },
      fx: { path: ["ARS", "USDC"], who_holds_risk: "receiving_anchor" },
      compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
      settlement: { network: "public", asset_issuer: "GISSUER" },
      recovery: {},
    };
    const parsed = parseCorridor(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(() => new Sep31Adapter(parsed.value)).toThrow(
        'Sep31Adapter cannot handle protocol "sep6"',
      );
    }
  });

  it("does the challenge/response handshake and attaches the JWT", async () => {
    const token = jwt(900);
    const signer: Sep10Signer = {
      account: "GSIGNER",
      signChallenge: async (xdr, pass) => {
        expect(pass).toBe(PASSPHRASE);
        return `signed(${xdr})`;
      },
    };
    const { fn, calls } = fakeFetch({
      "GET /auth": res({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
      "POST /auth": res({ token }),
      "POST /sep38/quote": res({
        id: "q1",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
      }),
    });
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      web_auth: "https://d.example/auth",
      quote_server: "https://d.example/sep38",
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn, sep10: signer });

    const q = await adapter.requestQuote(intent, c);
    expect(q.ok).toBe(true);

    const quoteCall = calls.find((x) => x.url.includes("/sep38/quote"));
    expect(quoteCall?.headers.authorization).toBe(`Bearer ${token}`);
    // challenge GET happened before the token POST
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("account=GSIGNER");
  });

  it("calls anonymously when no signer is configured", async () => {
    const { fn, calls } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q1",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
      }),
    });
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      web_auth: "https://d.example/auth",
      quote_server: "https://d.example/sep38",
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const q = await adapter.requestQuote(intent, c);
    expect(q.ok).toBe(true);
    expect(calls.every((x) => !x.url.includes("/auth"))).toBe(true);
  });
});

describe("SEP-38 quote request shape", () => {
  const quoteRoute = {
    "POST /sep38/quote": res({
      id: "q1",
      price: "1.0",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      sell_amount: "100",
      buy_amount: "100",
    }),
  };
  const endpoints = {
    transfer_server_sep31: "https://d.example/sep31",
    quote_server: "https://d.example/sep38",
  };

  // Live anchors reject issuer-less asset ids and quotes without a context —
  // this pins the exact body SEP-38 requires.
  it("sends context=sep31 and an issuer-qualified sell_asset", async () => {
    const { fn, calls } = fakeFetch(quoteRoute);
    const c = corridor(endpoints);
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(true);
    const body = calls.find((x) => x.url.includes("/sep38/quote"))?.body as Record<
      string,
      string
    >;
    expect(body.context).toBe("sep31");
    expect(body.sell_asset).toBe("stellar:USDC:GISSUER");
    expect(body.buy_asset).toBe("iso4217:ARS");
    expect(body.sell_amount).toBe("100");
  });

  it("sends stellar:native when the bridge asset is XLM", async () => {
    const { fn, calls } = fakeFetch(quoteRoute);
    const c = corridor(endpoints, { bridge_asset: "XLM" });
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(true);
    const body = calls.find((x) => x.url.includes("/sep38/quote"))?.body as Record<
      string,
      string
    >;
    expect(body.sell_asset).toBe("stellar:native");
  });
});

describe("SEP-38 quote fee handling", () => {
  const endpoints = {
    transfer_server_sep31: "https://d.example/sep31",
    quote_server: "https://d.example/sep38",
  };

  it("parses valid fee when fee asset matches sell asset", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-fee-1",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
        fee: { total: "1.50", asset: "stellar:USDC:GISSUER" },
      }),
    });
    const c = corridor(endpoints);
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.fee).toEqual({ asset: "USDC", amount: "1.50" });
    }
  });

  it("omits fee when fee total is malformed", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-fee-2",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
        fee: { total: "not-a-number", asset: "stellar:USDC:GISSUER" },
      }),
    });
    const c = corridor(endpoints);
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.fee).toBeUndefined();
    }
  });

  it.each([
    ["the same code from a different issuer", "stellar:USDC:GOTHERISSUER"],
    ["a bare code with no issuer", "USDC"],
  ])("rejects a fee in %s: it is not the asset being sold", async (_label, feeAsset) => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-fee-asset",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
        fee: { total: "1.00", asset: feeAsset },
      }),
    });
    const c = corridor(endpoints);
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(q.error.message).toContain("does not match sell asset");
    }
  });

  it("rejects quote when fee asset is in a foreign asset", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-fee-3",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
        fee: { total: "1.00", asset: "iso4217:EUR" },
      }),
    });
    const c = corridor(endpoints);
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(q.error.message).toContain("does not match sell asset");
    }
  });
});

describe("SEP-31 status mapping", () => {
  it("classifies `completed` as settled and nothing else", () => {
    expect(mapSep31Status("completed")).toEqual({
      status: "completed",
      settled: true,
      terminalFailure: false,
      awaitingInput: false,
    });
  });

  it("classifies the terminal non-success statuses as terminalFailure", () => {
    for (const terminal of ["error", "expired", "refunded"]) {
      expect(mapSep31Status(terminal)).toEqual({
        status: terminal,
        settled: false,
        terminalFailure: true,
        awaitingInput: false,
      });
    }
  });

  it("classifies the Anchor Platform's in-flight statuses as in-flight", () => {
    for (const pending of ["pending_sender", "pending_anchor", "pending_stellar"]) {
      expect(mapSep31Status(pending)).toEqual({
        status: pending,
        settled: false,
        terminalFailure: false,
        awaitingInput: false,
      });
    }
    for (const pending of ["pending_receiver", "pending_external"]) {
      expect(mapSep31Status(pending)).toEqual({
        status: pending,
        phase: "external",
        settled: false,
        terminalFailure: false,
        awaitingInput: false,
      });
    }
  });

  it("flags the statuses that are blocked on someone else's input", () => {
    // Still in flight — the engine keeps polling — but the hold-up is a party
    // owing the anchor information, not the anchor doing its work.
    for (const blocked of [
      "incomplete",
      "pending_customer_info_update",
      "pending_transaction_info_update",
    ]) {
      expect(mapSep31Status(blocked)).toEqual({
        status: blocked,
        settled: false,
        terminalFailure: false,
        awaitingInput: true,
      });
    }
  });

  it("treats an unrecognised status as in-flight, never as settled", () => {
    expect(mapSep31Status("something_new_we_dont_know")).toEqual({
      status: "something_new_we_dont_know",
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    });
    expect(mapSep31Status("").settled).toBe(false);
  });

  it("is case-insensitive on the raw anchor status", () => {
    expect(mapSep31Status("COMPLETED").settled).toBe(true);
    expect(mapSep31Status("Error").terminalFailure).toBe(true);
    expect(mapSep31Status("Pending_Customer_Info_Update").awaitingInput).toBe(true);
    expect(mapSep31Status("PENDING_ANCHOR").awaitingInput).toBe(false);
  });

  it("getTransaction reflects the mapping for the anchor's reported status", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    for (const [raw, settled, terminal] of [
      ["completed", true, false],
      ["pending_receiver", false, false],
      ["error", false, true],
      ["refunded", false, true],
    ] as const) {
      const { fn } = fakeFetch({
        "GET /sep31/transactions/": res({ transaction: { status: raw } }),
      });
      const adapter = new Sep31Adapter(c, { fetchImpl: fn });
      const r = await adapter.getTransaction("tx-1");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.settled).toBe(settled);
        expect(r.value.terminalFailure ?? false).toBe(terminal);
      }
    }
  });

  // --- SEP-31 `refunds` (#56) --------------------------------------------
  //
  // A refund flips the status to `refunded`, which the mapping above already
  // classifies as a terminal failure. What was missing is everything else: how
  // much came back, what the anchor kept, and whether the refund was partial.

  const REFUND_ASSET = "stellar:USDC:GISSUER";

  async function getTx(transaction: Record<string, unknown>) {
    const c = corridor(
      { transfer_server_sep31: "https://d.example/sep31" },
      {
        bridge_asset: "USDC",
      },
    );
    const { fn } = fakeFetch({
      "GET /sep31/transactions/": res({ transaction }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    return adapter.getTransaction("tx-1");
  }

  it("leaves refunds absent when the anchor does not report any", async () => {
    const r = await getTx({
      status: "completed",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.refunds).toBeUndefined();
    // Absent, not a zero-filled placeholder: "refunded nothing" and "said
    // nothing" must stay distinguishable.
    expect(r.value.settled).toBe(true);
  });

  it("parses a full refund and classifies it as full", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100.0000000",
      amount_in_asset: REFUND_ASSET,
      refunds: {
        amount_refunded: "100",
        amount_fee: "0",
        payments: [{ id: "abc123", id_type: "stellar", amount: "100", fee: "0" }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Terminal-failure classification is unchanged by refund parsing.
    expect(r.value.terminalFailure).toBe(true);
    expect(r.value.refunds?.completeness).toBe("full");
    // "100" vs "100.0000000" — equal as money, unequal as strings.
    expect(r.value.refunds?.amountRefunded).toEqual({ asset: REFUND_ASSET, amount: "100" });
    expect(r.value.refunds?.amountFee).toEqual({ asset: REFUND_ASSET, amount: "0" });
    expect(r.value.refunds?.payments).toEqual([
      {
        id: "abc123",
        idType: "stellar",
        amount: { asset: REFUND_ASSET, amount: "100" },
        fee: { asset: REFUND_ASSET, amount: "0" },
      },
    ]);
  });

  it("distinguishes a partial refund from a full one", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "40.5", amount_fee: "1.25", payments: [] },
    });
    expect(r.ok && r.value.refunds?.completeness).toBe("partial");
    expect(r.ok && r.value.refunds?.amountRefunded.amount).toBe("40.5");
    expect(r.ok && r.value.refunds?.amountFee.amount).toBe("1.25");
  });

  it("carries multiple payments entries", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: {
        amount_refunded: "100",
        amount_fee: "2",
        payments: [
          { id: "p1", id_type: "stellar", amount: "60", fee: "1" },
          { id: "p2", id_type: "external", amount: "40", fee: "1" },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.refunds?.payments).toHaveLength(2);
    expect(r.value.refunds?.payments.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(r.value.refunds?.payments[1]?.idType).toBe("external");
  });

  it("falls back to the corridor's bridge asset when the anchor names none", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      refunds: { amount_refunded: "100" },
    });
    expect(r.ok && r.value.refunds?.amountRefunded.asset).toBe("USDC");
  });

  it("reports completeness as unknown when there is nothing to compare against", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "40" },
    });
    // No amount_in: the caller is told we do not know, not handed a guess.
    expect(r.ok && r.value.refunds?.completeness).toBe("unknown");
  });

  it("treats an over-refund as full rather than partial", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "101" },
    });
    expect(r.ok && r.value.refunds?.completeness).toBe("full");
  });

  it("never throws and never changes the classification on garbage refunds", async () => {
    const garbage: unknown[] = [
      null,
      "refunded",
      [],
      42,
      {},
      { amount_refunded: null },
      // A number has already been through a float64 — refuse it rather than
      // laundering the lost precision into a Money.
      { amount_refunded: 100 },
      { amount_refunded: "not-a-number" },
      { amount_refunded: "1e5" },
    ];

    for (const refunds of garbage) {
      const r = await getTx({
        status: "refunded",
        amount_in: "100",
        amount_in_asset: REFUND_ASSET,
        refunds,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.refunds).toBeUndefined();
      // The status classification is decided independently and is untouched.
      expect(r.value.status).toBe("refunded");
      expect(r.value.terminalFailure).toBe(true);
    }
  });

  it("drops an unreadable payments entry without dropping the refund", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: {
        amount_refunded: "100",
        payments: [
          { id: "good", amount: "100", fee: "0" },
          { id: "no-amount" },
          { amount: "10" },
          null,
          "nonsense",
          { id: "bad-amount", amount: 10 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.refunds?.payments.map((p) => p.id)).toEqual(["good"]);
    // Totals still describe the refund even though entries were dropped.
    expect(r.value.refunds?.amountRefunded.amount).toBe("100");
  });

  it("defaults a missing or unreadable fee to zero, not to undefined", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "100", amount_fee: {} },
    });
    expect(r.ok && r.value.refunds?.amountFee.amount).toBe("0");
  });

  it("parseRefunds is directly callable and pure", () => {
    expect(parseRefunds(undefined, "USDC", "100")).toBeUndefined();
    expect(parseRefunds({ amount_refunded: "  50  " }, "USDC", "100")).toEqual({
      amountRefunded: { asset: "USDC", amount: "50" },
      amountFee: { asset: "USDC", amount: "0" },
      payments: [],
      completeness: "partial",
    });
  });

  // --- The anchor's own record of what it expects (#147) -------------------
  //
  // Read back off GET /transactions/:id so the opened transaction can be
  // cross-checked against what we are about to send, before settling.

  it("parses amount, deposit account and memo when the anchor reports them", async () => {
    const r = await getTx({
      status: "pending_sender",
      amount_in: " 100.50 ",
      amount_in_asset: REFUND_ASSET,
      stellar_account_id: "GDEPOSIT",
      stellar_memo: "aGVsbG8=",
      stellar_memo_type: "HASH",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amountIn).toEqual({ asset: REFUND_ASSET, amount: "100.50" });
    expect(r.value.depositAddress).toBe("GDEPOSIT");
    expect(r.value.memo).toBe("aGVsbG8=");
    expect(r.value.memoType).toBe("hash");
  });

  it("names the bridge asset on amountIn when the anchor names none", async () => {
    const r = await getTx({ status: "pending_sender", amount_in: "100" });
    expect(r.ok && r.value.amountIn).toEqual({ asset: "USDC", amount: "100" });
  });

  it("omits the fields when the anchor does not report them", async () => {
    const r = await getTx({ status: "pending_sender" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      status: "pending_sender",
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    });
    for (const key of ["amountIn", "depositAddress", "memo", "memoType"]) {
      expect(key in r.value).toBe(false);
    }
  });

  it("omits each malformed field on its own and never guesses", async () => {
    const r = await getTx({
      status: "pending_sender",
      // A number has already been through a float64 — refused, not laundered.
      amount_in: 100.5,
      amount_in_asset: REFUND_ASSET,
      stellar_account_id: "GDEPOSIT",
      stellar_memo: 12345,
      stellar_memo_type: "base64",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amountIn).toBeUndefined();
    expect(r.value.memo).toBeUndefined();
    expect(r.value.memoType).toBeUndefined();
    // A readable field survives its neighbours being malformed.
    expect(r.value.depositAddress).toBe("GDEPOSIT");
  });

  it("rejects numeric and unparseable amounts and empty strings", async () => {
    for (const amount_in of [100, 0, "abc", "1e5", "", null, {}]) {
      const r = await getTx({
        status: "completed",
        amount_in,
        stellar_account_id: "",
        stellar_memo: "",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.amountIn).toBeUndefined();
      expect(r.value.depositAddress).toBeUndefined();
      expect(r.value.memo).toBeUndefined();
      // Classification is decided independently and is untouched.
      expect(r.value.settled).toBe(true);
    }
  });
});

describe("SEP-12 compliance", () => {
  it("treats a corridor with no kyc_server as 1:1 accepted", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const adapter = new Sep31Adapter(c, { fetchImpl: fakeFetch({}).fn });
    const r = await adapter.ensureCompliance(intent, c);
    expect(r.ok && r.value.status).toBe("accepted");
  });

  it("maps SEP-12 statuses to accepted / pending / rejected", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    for (const [sep12, expected] of [
      ["ACCEPTED", "accepted"],
      ["PROCESSING", "pending"],
      ["NEEDS_INFO", "pending"],
      ["REJECTED", "rejected"],
    ] as const) {
      const { fn } = fakeFetch({ "GET /sep12/customer": res({ id: "c1", status: sep12 }) });
      const adapter = new Sep31Adapter(c, { fetchImpl: fn });
      const r = await adapter.ensureCompliance(intent, c);
      expect(r.ok && r.value.status).toBe(expected);
    }
  });
});

describe("refund initiation (deliberately unsupported)", () => {
  // SEP-31 has no sender-initiated refund endpoint: a refund is initiated by
  // the RECEIVING anchor and only reported back on the transaction record.
  // The generic adapter must fail closed rather than invent an endpoint.
  it("fails closed with a non-retryable REFUND_UNSUPPORTED", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn, calls } = fakeFetch({});
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const r = await adapter.requestRefund("tx-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REFUND_UNSUPPORTED");
      expect(r.error.retryable).toBe(false);
      // The message must carry the reason and the alternative, so an operator
      // reading a run's lastError knows this is protocol, not an outage.
      expect(r.error.message).toContain("no sender-initiated refund endpoint");
      expect(r.error.message).toContain("out-of-band");
    }
    // Fail-closed means CLOSED: no bespoke HTTP call dressed up as SEP-31.
    expect(calls).toHaveLength(0);
  });
});

describe("openedTxCheck gate check (anchor.tx.match)", () => {
  const DEST = "GDEPOSIT";

  function gateCtx(): GateContext {
    return {
      intent,
      corridor: corridor({ transfer_server_sep31: "https://d.example/sep31" }),
      quote: {
        id: "q1",
        sourceAmount: { asset: "USDC", amount: "10" },
        destAmount: { asset: "iso4217:ARS", amount: "10000" },
        price: "1000",
        expiresAt: Date.now() + 60_000,
        firm: true,
      },
      opened: {
        transactionId: "tx-1",
        depositAddress: DEST,
        memo: "memo-abc-123",
        memoType: "text",
      },
      now: Date.now(),
      attempt: 1,
    };
  }

  type Reported = TransactionStatus & ReportedTransactionFields;
  function adapterReporting(status: Reported) {
    return { getTransaction: async () => ({ ok: true as const, value: status }) };
  }

  const matching: Reported = {
    status: "pending_sender",
    settled: false,
    amount: "10",
    asset: "USDC",
    depositAddress: DEST,
    memo: "memo-abc-123",
    memoType: "text",
  };

  it("has the name 'anchor.tx.match'", () => {
    expect(openedTxCheck(adapterReporting(matching)).name).toBe("anchor.tx.match");
  });

  it("passes on an exact match", async () => {
    const result = await openedTxCheck(adapterReporting(matching)).run(gateCtx());
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("matches on every field");
  });

  it('passes when the anchor writes "10.00" for our "10"', async () => {
    const result = await openedTxCheck(adapterReporting({ ...matching, amount: "10.00" })).run(
      gateCtx(),
    );
    expect(result.passed).toBe(true);
  });

  it("fails on status pending_receiver", async () => {
    const result = await openedTxCheck(
      adapterReporting({ ...matching, status: "pending_receiver" }),
    ).run(gateCtx());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_TX_MISMATCH");
    expect(result.detail).toContain("pending_receiver");
  });

  it("fails on a different deposit account", async () => {
    const result = await openedTxCheck(
      adapterReporting({ ...matching, depositAddress: "GOTHER" }),
    ).run(gateCtx());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_TX_MISMATCH");
    expect(result.detail).toContain("depositAddress");
  });

  it("fails on a wrong memo without ever logging the full memo", async () => {
    const result = await openedTxCheck(
      adapterReporting({ ...matching, memo: "memo-zzz-999" }),
    ).run(gateCtx());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_TX_MISMATCH");
    expect(result.detail).toContain("memo");
    // Only the type and a 6-char prefix appear — never either full memo.
    expect(result.detail).not.toContain("memo-abc-123");
    expect(result.detail).not.toContain("memo-zzz-999");
  });

  it("fails on a wrong memo type", async () => {
    const result = await openedTxCheck(
      adapterReporting({ ...matching, memoType: "hash" }),
    ).run(gateCtx());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("memoType");
  });

  it("fails on a wrong amount", async () => {
    const result = await openedTxCheck(adapterReporting({ ...matching, amount: "11" })).run(
      gateCtx(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("amount");
  });

  it("records an omitted field as unverified without failing", async () => {
    const { amount: _a, ...rest } = matching;
    const result = await openedTxCheck(adapterReporting(rest as Reported)).run(gateCtx());
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("unverified: amount");
  });

  it("strict: true fails when a field is omitted", async () => {
    const { memo: _m, ...rest } = matching;
    const result = await openedTxCheck(adapterReporting(rest as Reported), {
      strict: true,
    }).run(gateCtx());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_TX_MISMATCH");
    expect(result.detail).toContain("did not report memo");
  });

  it("fails closed when the re-read itself fails", async () => {
    const adapter = {
      getTransaction: async () => ({
        ok: false as const,
        error: { code: "ANCHOR_UNAVAILABLE" as const, message: "boom", retryable: true },
      }),
    };
    const result = await openedTxCheck(adapter).run(gateCtx());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("SETTLEMENT_FAILED");
  });
});

describe("SEP-31 getInfo", () => {
  it("parses a realistic /info body with string amounts", async () => {
    const infoPayload = {
      receive: {
        USDC: {
          enabled: true,
          fee_fixed: "0.50",
          fee_percent: "0.01",
          min_amount: "1.00",
          max_amount: "10000.00",
          sender_sep12_type: "sep31-sender",
          receiver_sep12_type: "sep31-receiver",
          fields: {
            transaction: {
              account_number: { description: "bank account number" },
            },
          },
        },
      },
    };
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({ "GET /sep31/info": res(infoPayload) });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const outcome = await adapter.getInfo();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.receive.USDC).toEqual({
      enabled: true,
      minAmount: "1.00",
      maxAmount: "10000.00",
      feeFixed: "0.50",
      feePercent: "0.01",
      senderSep12Type: "sep31-sender",
      receiverSep12Type: "sep31-receiver",
      fields: {
        transaction: {
          account_number: { description: "bank account number" },
        },
      },
    });
  });

  it("rejects numeric amounts, keeping them undefined to avoid precision loss", async () => {
    const infoPayload = {
      receive: {
        USDC: {
          enabled: true,
          min_amount: 10.5,
          max_amount: 5000,
          fee_fixed: 0.25,
        },
      },
    };
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({ "GET /sep31/info": res(infoPayload) });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const outcome = await adapter.getInfo();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.receive.USDC?.enabled).toBe(true);
    expect(outcome.value.receive.USDC?.minAmount).toBeUndefined();
    expect(outcome.value.receive.USDC?.maxAmount).toBeUndefined();
    expect(outcome.value.receive.USDC?.feeFixed).toBeUndefined();
  });

  it("attaches SEP-10 JWT if configured", async () => {
    const token = jwt(900);
    const signer: Sep10Signer = {
      account: "GSIGNER",
      signChallenge: async (xdr) => `signed(${xdr})`,
    };
    const { fn, calls } = fakeFetch({
      "GET /auth": res({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
      "POST /auth": res({ token }),
      "GET /sep31/info": res({ receive: { USDC: { enabled: true } } }),
    });
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      web_auth: "https://d.example/auth",
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn, sep10: signer });

    const outcome = await adapter.getInfo();
    expect(outcome.ok).toBe(true);

    const infoCall = calls.find((x) => x.url.includes("/sep31/info"));
    expect(infoCall?.headers.authorization).toBe(`Bearer ${token}`);
  });
});

describe("sep31InfoCheck gate check (sep31.info.asset)", () => {
  function makeGateContext(c: Corridor, bridgeAsset = "USDC"): GateContext {
    return {
      intent,
      corridor: {
        ...c,
        settlement: {
          ...c.settlement,
          bridge_asset: bridgeAsset,
        },
      },
      quote: {
        id: "q1",
        sourceAmount: { asset: bridgeAsset, amount: "100" },
        destAmount: { asset: "iso4217:ARS", amount: "10000" },
        price: "100",
        expiresAt: Date.now() + 60_000,
        firm: true,
      },
      opened: {
        transactionId: "tx-1",
        depositAddress: "GDEPOSIT",
        memo: "memo123",
        memoType: "text",
      },
      now: Date.now(),
      attempt: 1,
    };
  }

  it("passes against Anchor Platform reference stack fixture and exposes parsed info", async () => {
    const refStackFixture = {
      receive: {
        USDC: {
          enabled: true,
          fee_fixed: "0.00",
          fee_percent: "0.00",
          min_amount: "1.00",
          max_amount: "100000.00",
          sender_sep12_type: "sep31-sender",
          receiver_sep12_type: "sep31-receiver",
        },
      },
    };
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({ "GET /sep31/info": res(refStackFixture) });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const check = sep31InfoCheck(adapter);
    expect(check.name).toBe("sep31.info.asset");

    const result = (await check.run(makeGateContext(c, "USDC"))) as Sep31InfoCheckResult;
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('active bridge asset "USDC"');
    expect(result.info?.receive.USDC?.enabled).toBe(true);
  });

  it("fails on empty receive with PRESETTLE_ANCHOR_DRIFT", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({ "GET /sep31/info": res({ receive: {} }) });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const check = sep31InfoCheck(adapter);
    const result = await check.run(makeGateContext(c, "USDC"));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_ANCHOR_DRIFT");
    expect(result.detail).toContain("receive list is empty");
  });

  it("fails when bridge asset is missing with PRESETTLE_ANCHOR_DRIFT", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({
      "GET /sep31/info": res({ receive: { EURC: { enabled: true } } }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const check = sep31InfoCheck(adapter);
    const result = await check.run(makeGateContext(c, "USDC"));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_ANCHOR_DRIFT");
    expect(result.detail).toContain('does not list bridge asset "USDC"');
  });

  it("fails when bridge asset enabled is false with PRESETTLE_ANCHOR_DRIFT", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({
      "GET /sep31/info": res({ receive: { USDC: { enabled: false } } }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const check = sep31InfoCheck(adapter);
    const result = await check.run(makeGateContext(c, "USDC"));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_ANCHOR_DRIFT");
    expect(result.detail).toContain("disabled (enabled: false)");
  });

  it("fails on HTTP 500 error with PRESETTLE_ANCHOR_DRIFT", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({ "GET /sep31/info": res({}, false, 500) });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const check = sep31InfoCheck(adapter);
    const result = await check.run(makeGateContext(c, "USDC"));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_ANCHOR_DRIFT");
    expect(result.detail).toContain("HTTP 500");
  });

  it("fails on network error with PRESETTLE_ANCHOR_DRIFT", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const failingFetch = (async () => {
      throw new Error("connection reset by peer");
    }) as unknown as typeof fetch;
    const adapter = new Sep31Adapter(c, { fetchImpl: failingFetch });

    const check = sep31InfoCheck(adapter);
    const result = await check.run(makeGateContext(c, "USDC"));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_ANCHOR_DRIFT");
    expect(result.detail).toContain("get-info request failed");
  });
});

describe("receiverKycCheck gate check (sep12.receiver)", () => {
  function testGateContext(c: Corridor, customIntent: PaymentIntent = intent): GateContext {
    return {
      intent: customIntent,
      corridor: c,
      quote: {
        id: "q-1",
        price: "1",
        expiresAt: Date.now() + 60_000,
        sourceAmount: { asset: "USDC", amount: "100" },
        destAmount: { asset: "iso4217:ARS", amount: "100" },
        firm: true,
      },
      opened: {
        transactionId: "tx-1",
        depositAddress: "GDEPOSIT",
      },
      now: Date.now(),
      attempt: 1,
    };
  }

  it("has the name 'sep12.receiver'", () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const adapter = new Sep31Adapter(c, { fetchImpl: fakeFetch({}).fn });
    const check = receiverKycCheck(adapter);
    expect(check.name).toBe("sep12.receiver");
  });

  it("passes when receiver status is ACCEPTED on anchor with kyc_server", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-1", status: "ACCEPTED" }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const check = receiverKycCheck(adapter);
    const result = await check.run(testGateContext(c));

    expect(result.passed).toBe(true);
    expect(result.name).toBe("sep12.receiver");
    expect(result.detail).toBe("receiver SEP-12 status is accepted");
    expect(result.code).toBeUndefined();
  });

  it("passes with detail 'no SEP-12 server' when corridor has no kyc_server", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const adapter = new Sep31Adapter(c, { fetchImpl: fakeFetch({}).fn });
    const check = receiverKycCheck(adapter);
    const result = await check.run(testGateContext(c));

    expect(result.passed).toBe(true);
    expect(result.name).toBe("sep12.receiver");
    expect(result.detail).toBe("no SEP-12 server");
    expect(result.code).toBeUndefined();
  });

  it("detail distinguishes 'no SEP-12 server' from a real ACCEPTED", async () => {
    const cNoKyc = corridor({
      transfer_server_sep31: "https://d.example/sep31",
    });
    const adapterNoKyc = new Sep31Adapter(cNoKyc, {
      fetchImpl: fakeFetch({}).fn,
    });
    const noKycResult = await receiverKycCheck(adapterNoKyc).run(testGateContext(cNoKyc));

    const cWithKyc = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-1", status: "ACCEPTED" }),
    });
    const adapterWithKyc = new Sep31Adapter(cWithKyc, { fetchImpl: fn });
    const withKycResult = await receiverKycCheck(adapterWithKyc).run(
      testGateContext(cWithKyc),
    );

    expect(noKycResult.detail).toBe("no SEP-12 server");
    expect(withKycResult.detail).toBe("receiver SEP-12 status is accepted");
    expect(noKycResult.detail).not.toBe(withKycResult.detail);
  });

  it("fails with PRESETTLE_RECEIVER_NOT_ACCEPTED when status is PROCESSING", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-1", status: "PROCESSING" }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const result = await receiverKycCheck(adapter).run(testGateContext(c));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
    expect(result.detail).toContain("pending");
  });

  it("fails with PRESETTLE_RECEIVER_NOT_ACCEPTED when status is NEEDS_INFO", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-1", status: "NEEDS_INFO" }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const result = await receiverKycCheck(adapter).run(testGateContext(c));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
    expect(result.detail).toContain("pending");
  });

  it("fails with PRESETTLE_RECEIVER_NOT_ACCEPTED when status is REJECTED", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-1", status: "REJECTED" }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const result = await receiverKycCheck(adapter).run(testGateContext(c));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
    expect(result.detail).toContain("rejected");
  });

  it("fails with PRESETTLE_RECEIVER_NOT_ACCEPTED when anchor returns HTTP 500", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn } = fakeFetch({
      "GET /sep12/customer": res({ error: "internal server error" }, false, 500),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const result = await receiverKycCheck(adapter).run(testGateContext(c));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
    expect(result.detail).toContain("HTTP 500");
  });

  it("fails when recipient has no sep12Id", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fakeFetch({}).fn });
    const intentNoSep12: PaymentIntent = {
      ...intent,
      recipient: { id: "recip-no-sep12" },
    };
    const result = await receiverKycCheck(adapter).run(testGateContext(c, intentNoSep12));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
    expect(result.detail).toContain("no SEP-12 customer id");
  });

  it("fails when adapter throws unexpectedly", async () => {
    const throwingAdapter = {
      ensureCompliance: async () => {
        throw new Error("unexpected network timeout");
      },
    };
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const result = await receiverKycCheck(throwingAdapter).run(testGateContext(c));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
    expect(result.detail).toContain("unexpected network timeout");
  });

  it("evaluates correctly within CompositeGate", async () => {
    const cPass = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn: fnPass } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-1", status: "ACCEPTED" }),
    });
    const adapterPass = new Sep31Adapter(cPass, { fetchImpl: fnPass });
    const gatePass = new CompositeGate([receiverKycCheck(adapterPass)]);
    const evalPass = await gatePass.evaluate(testGateContext(cPass));
    expect(evalPass.passed).toBe(true);
    expect(evalPass.results).toHaveLength(1);
    expect(evalPass.results[0].passed).toBe(true);

    const cFail = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    const { fn: fnFail } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-1", status: "NEEDS_INFO" }),
    });
    const adapterFail = new Sep31Adapter(cFail, { fetchImpl: fnFail });
    const gateFail = new CompositeGate([receiverKycCheck(adapterFail)]);
    const evalFail = await gateFail.evaluate(testGateContext(cFail));
    expect(evalFail.passed).toBe(false);
    expect(evalFail.results[0].code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
  });
});

describe("amountRangeCheck gate check (sep31.amount.range)", () => {
  function testGateContext(c: Corridor, customQuoteAmount = "100"): GateContext {
    return {
      intent,
      corridor: c,
      quote: {
        id: "q-1",
        price: "1",
        expiresAt: Date.now() + 60_000,
        sourceAmount: { asset: "USDC", amount: customQuoteAmount },
        destAmount: { asset: "iso4217:ARS", amount: customQuoteAmount },
        firm: true,
      },
      opened: {
        transactionId: "tx-1",
        depositAddress: "GDEPOSIT",
      },
      now: Date.now(),
      attempt: 1,
    };
  }

  it("has the name 'sep31.amount.range'", () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const adapter = new Sep31Adapter(c, { fetchImpl: fakeFetch({}).fn });
    const check = amountRangeCheck(adapter);
    expect(check.name).toBe("sep31.amount.range");
  });

  it("passes when amount is within anchor info limits", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({
      "GET /sep31/info": res({
        receive: { USDC: { min_amount: "50", max_amount: "500" } },
      }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const check = amountRangeCheck(adapter);
    const result = await check.run(testGateContext(c, "100"));

    expect(result.passed).toBe(true);
    expect(result.code).toBeUndefined();
  });

  it("anchor bumps sell_amount above max_amount, refused at verifying with zero submits", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn } = fakeFetch({
      "GET /sep31/info": res({
        receive: { USDC: { max_amount: "90" } },
      }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const check = amountRangeCheck(adapter);
    const result = await check.run(testGateContext(c, "100"));

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
    expect(result.detail).toContain("above maximum 90");
  });

  it("below anchor min, above anchor max, and missing /info bounds so only manifest bounds apply", async () => {
    const c = corridor(
      { transfer_server_sep31: "https://d.example/sep31" },
      { bridge_asset: "USDC" },
    );
    // Add manifest limits
    c.limits = { min_amount: "20", max_amount: "200" };

    // Missing info bounds
    const { fn } = fakeFetch({
      "GET /sep31/info": res({
        receive: { USDC: {} },
      }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const check = amountRangeCheck(adapter);

    // Within manifest limits
    const passResult = await check.run(testGateContext(c, "100"));
    expect(passResult.passed).toBe(true);

    // Below manifest min
    const failMinResult = await check.run(testGateContext(c, "10"));
    expect(failMinResult.passed).toBe(false);
    expect(failMinResult.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
    expect(failMinResult.detail).toContain("below minimum 20");

    // Above manifest max
    const failMaxResult = await check.run(testGateContext(c, "300"));
    expect(failMaxResult.passed).toBe(false);
    expect(failMaxResult.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
    expect(failMaxResult.detail).toContain("above maximum 200");
  });
  it("shares one /info fetch with sep31InfoCheck via sep31GateChecks", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn, calls } = fakeFetch({
      "GET /sep31/info": res({ receive: { USDC: { min_amount: "50", max_amount: "500" } } }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const gate = new CompositeGate(sep31GateChecks(adapter));
    const out = await gate.evaluate(testGateContext(c, "100"));
    expect(out.passed).toBe(true);
    expect(out.results.map((r) => r.name).sort()).toEqual([
      "sep31.amount.range",
      "sep31.info.asset",
    ]);
    expect(calls.filter((x) => x.url.endsWith("/sep31/info"))).toHaveLength(1);
  });

  it("fails (not silently passes) when /info cannot be fetched or bounds cannot be compared", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const down = amountRangeCheck({
      getInfo: async () => fail("ANCHOR_UNAVAILABLE", "down"),
    });
    const r1 = await down.run(testGateContext(c, "100"));
    expect(r1.passed).toBe(false);

    const bad = amountRangeCheck({
      getInfo: async () => ok({ receive: { USDC: { maxAmount: "not-a-number" } } }),
    });
    const r2 = await bad.run(testGateContext(c, "100"));
    expect(r2.passed).toBe(false);
    expect(r2.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
  });
});
