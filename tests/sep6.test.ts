import { describe, expect, it, vi } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { conformanceSuite, runConformance, type Quote } from "@corridor/adapter-kit";
import { mapSep6Status, Sep6Adapter, type Sep10Signer } from "@corridor/sep6";
import { StaticRouteResolver } from "@corridor/router";
import {
  createMockSubmitter,
  execute,
  InMemoryIdempotencyStore,
  StellarPaymentStrategy,
  type EngineDeps,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";
import { createMockSep6Anchor } from "./fixtures/mock-sep6-anchor";
import { expectConformance } from "./helpers/conformance";

const PASSPHRASE = "Test SDF Network ; September 2015";
const TRANSFER = "https://d.example/sep6";

function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

function corridor(
  endpoints: Record<string, string> = {},
  settlement: Record<string, string> = {},
): Corridor {
  const r = parseCorridor({
    id: "sep6-test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      protocol: "sep6",
      name: "D",
      asset: "iso4217:ARS",
      endpoints: { home_domain: "d.example", transfer_server: TRANSFER, ...endpoints },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    // testnet, not public: this fixture exercises the SEP-6 lane without live
    // network settlement.
    settlement: { network: "testnet", asset_issuer: "GISSUER", ...settlement },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "k",
  corridorId: "sep6-test",
  sender: { id: "s" },
  // The SEP-12 customer id the RECEIVING anchor issued at registration: what
  // SEP-6 sends as `customer_id`, and the only attribution available when the
  // corridor runs without a SEP-10 signer.
  recipient: { id: "recipient-acct", sep12Id: "cust-1" },
  sourceAmount: { asset: "USDC", amount: "5.00" },
};

function quote(over: Partial<Quote> = {}): Quote {
  return {
    id: "q-1",
    price: "250",
    expiresAt: Date.now() + 60_000,
    sourceAmount: { asset: "USDC", amount: "5.00" },
    destAmount: { asset: "iso4217:ARS", amount: "1250.00" },
    firm: true,
    ...over,
  };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}
function res(body: unknown, ok = true, status = 200): FakeResponse {
  return { ok, status, body };
}

// Router-style fetch fake, keyed on `${METHOD} ${substring}`. `text()` as well
// as `json()`: the adapter reads every body once through `text()` (an error
// detail may be plain text, and a body may be unreadable JSON), and re-reads it
// for the detail of a non-OK response.
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
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function params(call: { url: string } | undefined): URLSearchParams {
  return new URL(call!.url).searchParams;
}

describe("Sep6Adapter construction", () => {
  it("refuses a corridor whose dest is not SEP-6", () => {
    const r = parseCorridor({
      id: "test",
      source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
      dest: {
        name: "D",
        asset: "iso4217:ARS",
        endpoints: {
          home_domain: "d.example",
          transfer_server_sep31: "https://d.example/sep31",
        },
      },
      fx: { path: ["ARS", "USDC"], who_holds_risk: "receiving_anchor" },
      compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
      settlement: { network: "testnet", asset_issuer: "GISSUER" },
      recovery: {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(() => new Sep6Adapter(r.value)).toThrow(
        'Sep6Adapter cannot handle protocol "sep31"',
      );
    }
  });

  it("refuses a hand-built corridor with no transfer_server instead of reaching the network", () => {
    const c = corridor();
    // A Corridor assembled without parseCorridor can skip the required endpoint.
    const broken = {
      ...c,
      dest: { ...c.dest, endpoints: { ...c.dest.endpoints, transfer_server: "" } },
    };
    expect(() => new Sep6Adapter(broken as Corridor)).toThrow(/no dest transfer_server/);
  });
});

describe("openTransaction request shape", () => {
  // An initiate that answers with an account: no follow-up record read.
  function initiator(routes: Record<string, FakeResponse> = {}) {
    const { fn, calls } = fakeFetch({
      "GET /withdraw-exchange": res({ id: "tx-1", account_id: "GDEPOSIT" }),
      ...routes,
    });
    const c = corridor();
    return { c, adapter: new Sep6Adapter(c, { fetchImpl: fn }), calls };
  }

  it("GETs /withdraw-exchange with the SEP-38 asset ids, the quote's amount and the customer", async () => {
    const token = jwt(900);
    const signer: Sep10Signer = {
      account: "GSIGNER",
      signChallenge: async (xdr, pass) => {
        expect(pass).toBe(PASSPHRASE);
        return `signed(${xdr})`;
      },
    };
    const { c, adapter, calls } = (() => {
      const { fn, calls } = fakeFetch({
        "GET /auth": res({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
        "POST /auth": res({ token }),
        "GET /withdraw-exchange": res({
          id: "tx-1",
          account_id: "GDEPOSIT",
          memo: "aGVsbG8=",
          memo_type: "hash",
        }),
      });
      const c = corridor({ web_auth: "https://d.example/auth" });
      return { c, adapter: new Sep6Adapter(c, { fetchImpl: fn, sep10: signer }), calls };
    })();

    const opened = await adapter.openTransaction(
      {
        ...intent,
        destinationFields: { type: "bank_account", account_number: "12345", amount: "999.99" },
      },
      quote(),
      c,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // `instructions` is what the engine routes on; the flat fields are the deprecated
    // duplicates `OpenTransaction` still carries.
    expect(opened.value).toEqual({
      transactionId: "tx-1",
      instructions: {
        kind: "stellar_payment",
        to: "GDEPOSIT",
        memo: "aGVsbG8=",
        memoType: "hash",
      },
      depositAddress: "GDEPOSIT",
      memo: "aGVsbG8=",
      memoType: "hash",
    });

    const call = calls.find((x) => x.url.includes("/withdraw-exchange"))!;
    expect(call.method).toBe("GET");
    expect(call.headers.authorization).toBe(`Bearer ${token}`);
    const q = params(call);
    expect(q.get("source_asset")).toBe("stellar:USDC:GISSUER");
    expect(q.get("destination_asset")).toBe("iso4217:ARS");
    // The quote's sell amount, not the intent's: a firm quote binds to the
    // anchor's own number.
    expect(q.get("amount")).toBe("5.00");
    expect(q.get("quote_id")).toBe("q-1");
    expect(q.get("account")).toBe("GSIGNER");
    expect(q.get("customer_id")).toBe("cust-1");
    // `type` is the anchor's own withdrawal-method name, forwarded from the
    // caller's payout fields — never derived from the payout asset.
    expect(q.get("type")).toBe("bank_account");
    expect(q.get("account_number")).toBe("12345");
    // A payout field must not be able to rewrite a protocol parameter.
    expect(q.getAll("amount")).toEqual(["5.00"]);

    const initiateIdx = calls.findIndex((x) => x.url.includes("/withdraw-exchange"));
    expect(initiateIdx).toBe(2); // challenge GET, token POST, then the initiate
  });

  it("sends stellar:native as the source asset on an XLM bridge", async () => {
    const { fn, calls } = fakeFetch({
      "GET /withdraw-exchange": res({ id: "tx-1", account_id: "G" }),
    });
    const c = corridor({}, { bridge_asset: "XLM" });
    const opened = await new Sep6Adapter(c, { fetchImpl: fn }).openTransaction(
      intent,
      quote(),
      c,
    );
    expect(opened.ok).toBe(true);
    expect(params(calls.at(-1)).get("source_asset")).toBe("stellar:native");
  });

  it("calls anonymously when no signer is configured and still attributes via customer_id", async () => {
    const { c, adapter, calls } = initiator({});
    const opened = await adapter.openTransaction(intent, quote(), c);
    expect(opened.ok).toBe(true);
    const call = calls.at(-1)!;
    expect(call.headers.authorization).toBeUndefined();
    expect(params(call).has("account")).toBe(false);
    expect(params(call).get("customer_id")).toBe("cust-1");
  });

  it("omits quote_id for a non-firm quote, and type unless the caller names one", async () => {
    const { c, adapter, calls } = initiator();
    await adapter.openTransaction(intent, { ...quote(), firm: false, id: "ours-1" }, c);
    expect(params(calls.at(-1)).has("quote_id")).toBe(false);

    // A fiat payout asset is not a funding method: testanchor's /info declares
    // `cash`/`bank_account`, so sending the asset's category would be a guess
    // the anchor is entitled to reject.
    const fiatLane = structuredClone(c);
    fiatLane.dest.asset = "iso4217:ZAR";
    await adapter.openTransaction(intent, quote(), fiatLane);
    expect(params(calls.at(-1)).has("type")).toBe(false);
  });

  it("preserves the memo type the anchor reports and never defaults it", async () => {
    const { fn } = fakeFetch({
      "GET /withdraw-exchange": res({
        id: "tx-1",
        account_id: "G",
        memo: "hi",
        memo_type: "TEXT",
      }),
    });
    const c = corridor();
    const opened = await new Sep6Adapter(c, { fetchImpl: fn }).openTransaction(
      intent,
      quote(),
      c,
    );
    expect(opened.ok && opened.value.memoType).toBe("text");
  });

  it("drops an unknown memo type instead of guessing one", async () => {
    const { fn } = fakeFetch({
      "GET /withdraw-exchange": res({
        id: "tx-1",
        account_id: "G",
        memo: "aGVsbG8=",
        memo_type: "base64",
      }),
    });
    const c = corridor();
    const opened = await new Sep6Adapter(c, { fetchImpl: fn }).openTransaction(
      intent,
      quote(),
      c,
    );
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.memo).toBe("aGVsbG8=");
      expect(opened.value.memoType).toBeUndefined();
    }
  });

  it("refuses to open unattributed: no signer, no customer id, no network call", async () => {
    const { c, adapter, calls } = initiator({});
    const opened = await adapter.openTransaction(
      { ...intent, recipient: { id: "no-sep12" } },
      quote(),
      c,
    );
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("KYC_REQUIRED");
      expect(opened.error.retryable).toBe(false);
      expect(opened.error.message).toContain("unattributed");
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed on a success body with no transaction id", async () => {
    const { c, adapter } = initiator({ "GET /withdraw-exchange": res({ account_id: "G" }) });
    const opened = await adapter.openTransaction(intent, quote(), c);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(opened.error.message).toContain("no transaction id");
      expect(opened.error.retryable).toBe(false);
    }
  });

  it("reports an HTTP refusal with the anchor's own detail", async () => {
    const { c, adapter } = initiator({
      "GET /withdraw-exchange": res({ error: "amount too small" }, false, 400),
    });
    const opened = await adapter.openTransaction(intent, quote(), c);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(opened.error.message).toContain("HTTP 400");
      expect(opened.error.message).toContain("amount too small");
      // 4xx is the anchor saying no, not an outage: retrying the same request
      // would only open a second withdrawal.
      expect(opened.error.retryable).toBe(false);
    }
  });

  it("treats a transport failure as retryable", async () => {
    const c = corridor();
    const down = (async () => {
      throw new Error("connection reset by peer");
    }) as unknown as typeof fetch;
    const opened = await new Sep6Adapter(c, { fetchImpl: down }).openTransaction(
      intent,
      quote(),
      c,
    );
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(opened.error.retryable).toBe(true);
    }
  });
});

describe("openTransaction KYC branches", () => {
  async function openWith(body: unknown, okFlag = false, status = 403) {
    const { fn } = fakeFetch({ "GET /withdraw-exchange": res(body, okFlag, status) });
    const c = corridor();
    return new Sep6Adapter(c, { fetchImpl: fn }).openTransaction(intent, quote(), c);
  }

  it("maps a denied customer to KYC_REJECTED", async () => {
    const r = await openWith({
      type: "customer_info_status",
      status: "denied",
      more_info_url: "https://d.example/help",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("KYC_REJECTED");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("https://d.example/help");
    }
  });

  it("maps a still-processing customer to KYC_REQUIRED", async () => {
    const r = await openWith({ type: "customer_info_status", status: "pending" });
    expect(!r.ok && r.error.code).toBe("KYC_REQUIRED");
    expect(!r.ok && r.error.message).toContain("still processing");
  });

  it("lists the fields a non-interactive customer owes", async () => {
    const r = await openWith({
      type: "non_interactive_customer_info_needed",
      fields: ["account_type", "mobile_number"],
    });
    expect(!r.ok && r.error.code).toBe("KYC_REQUIRED");
    expect(!r.ok && r.error.message).toContain("account_type, mobile_number");
  });

  it("refuses a KYC-shaped body even when the anchor sends it with a 200", async () => {
    // Branches v4.3.0 deprecates are still in the wild, and some anchors return
    // them as 200. An account is only an instruction when the anchor named one.
    const r = await openWith({ type: "customer_info_status", status: "denied" }, true, 200);
    expect(!r.ok && r.error.code).toBe("KYC_REJECTED");
  });

  it("retries an authentication_required answer, which a fresh JWT can fix", async () => {
    const r = await openWith({ type: "authentication_required" });
    expect(!r.ok && r.error.code).toBe("ANCHOR_UNAVAILABLE");
    expect(!r.ok && r.error.retryable).toBe(true);
  });
});

describe("openTransaction follow-up GET /transaction", () => {
  async function openWith(routes: Record<string, FakeResponse>) {
    const { fn, calls } = fakeFetch({
      // testanchor's real behaviour: 200 with an id and no account.
      "GET /withdraw-exchange": res({ id: "tx-9" }),
      ...routes,
    });
    const c = corridor();
    const opened = await new Sep6Adapter(c, {
      fetchImpl: fn,
    }).openTransaction(intent, quote(), c);
    return { calls, opened };
  }

  it("reads the account back exactly once, authenticated", async () => {
    const token = jwt(900);
    const signer: Sep10Signer = { account: "GSIGNER", signChallenge: async () => "signed" };
    const { fn, calls } = fakeFetch({
      "GET /auth": res({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
      "POST /auth": res({ token }),
      "GET /withdraw-exchange": res({ id: "tx-9" }),
      "GET /transaction": res({
        transaction: {
          status: "pending_user_transfer_start",
          withdraw_anchor_account: "GANCHOR",
          withdraw_memo: "aGVsbG8=",
          withdraw_memo_type: "hash",
        },
      }),
    });
    const c = corridor({ web_auth: "https://d.example/auth" });
    const opened = await new Sep6Adapter(c, { fetchImpl: fn, sep10: signer }).openTransaction(
      intent,
      quote(),
      c,
    );
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value).toEqual({
        transactionId: "tx-9",
        instructions: {
          kind: "stellar_payment",
          to: "GANCHOR",
          memo: "aGVsbG8=",
          memoType: "hash",
        },
        depositAddress: "GANCHOR",
        memo: "aGVsbG8=",
        memoType: "hash",
      });
    }
    // One record read — no polling loop hiding inside `open`.
    const recordCalls = calls.filter((x) => x.url.includes("/transaction"));
    expect(recordCalls).toHaveLength(1);
    expect(params(recordCalls[0]).get("id")).toBe("tx-9");
    expect(recordCalls[0].headers.authorization).toBe(`Bearer ${token}`);
  });

  it("omits a memo the record does not carry", async () => {
    const { opened } = await openWith({
      "GET /transaction": res({
        transaction: { status: "pending_anchor", withdraw_anchor_account: "GANCHOR" },
      }),
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.depositAddress).toBe("GANCHOR");
      expect(opened.value.instructions).toEqual({
        kind: "stellar_payment",
        to: "GANCHOR",
        memo: undefined,
        memoType: undefined,
      });
      // Unset, not defaulted: a missing `withdraw_memo_type` must not become
      // "text", and the fields stay absent-valued exactly as @corridor/sep31
      // leaves them.
      expect(opened.value.memo).toBeUndefined();
      expect(opened.value.memoType).toBeUndefined();
    }
  });

  it("names KYC when the record is held there rather than handing back an empty address", async () => {
    const { opened, calls } = await openWith({
      "GET /transaction": res({ transaction: { status: "incomplete" } }),
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("KYC_REQUIRED");
      expect(opened.error.retryable).toBe(false);
      // The anchor's id travels in the message: re-opening would create a
      // second withdrawal, so the operator resolves THIS record.
      expect(opened.error.message).toContain("tx-9");
      expect(opened.error.message).toContain("incomplete");
    }
    expect(calls.filter((x) => x.url.includes("/transaction"))).toHaveLength(1);
  });

  it("refuses to settle blind when a non-KYC record still has no account", async () => {
    const { opened } = await openWith({
      "GET /transaction": res({ transaction: { status: "pending_anchor" } }),
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(opened.error.retryable).toBe(false);
      expect(opened.error.message).toContain("refusing to settle blind");
    }
  });

  it("marks a 5xx record read retryable and a 4xx one final", async () => {
    const five = await openWith({ "GET /transaction": res("boom", false, 503) });
    expect(!five.opened.ok && five.opened.error.retryable).toBe(true);
    expect(!five.opened.ok && five.opened.error.message).toContain("boom");

    const four = await openWith({ "GET /transaction": res("nope", false, 404) });
    expect(!four.opened.ok && four.opened.error.retryable).toBe(false);
  });
});

describe("mapSep6Status", () => {
  it("classifies completed as settled and nothing else", () => {
    expect(mapSep6Status("completed")).toEqual({
      status: "completed",
      settled: true,
      terminalFailure: false,
      awaitingInput: false,
    });
  });

  it("classifies SEP-6's extra terminal statuses as terminalFailure", () => {
    for (const terminal of [
      "error",
      "expired",
      "refunded",
      "no_market",
      "too_small",
      "too_large",
    ]) {
      expect(mapSep6Status(terminal)).toEqual({
        status: terminal,
        settled: false,
        terminalFailure: true,
        awaitingInput: false,
      });
    }
  });

  it("flags the statuses waiting on us or on a human", () => {
    // `pending_user_transfer_start` is the withdraw state the settle leg acts
    // on; timing out there means a run waited on a payment, not on a slow anchor.
    for (const blocked of [
      "incomplete",
      "pending_user",
      "pending_user_transfer_start",
      "pending_customer_info_update",
      "pending_transaction_info_update",
    ]) {
      expect(mapSep6Status(blocked)).toEqual({
        status: blocked,
        settled: false,
        terminalFailure: false,
        awaitingInput: true,
      });
    }
  });

  it("classifies the anchor-side in-flight statuses without awaitingInput", () => {
    for (const pending of [
      "pending_anchor",
      "pending_stellar",
      "pending_trust",
      "pending_user_transfer_complete",
      "on_hold",
    ]) {
      expect(mapSep6Status(pending)).toEqual({
        status: pending,
        settled: false,
        terminalFailure: false,
        awaitingInput: false,
      });
    }
    expect(mapSep6Status("pending_external")).toEqual({
      status: "pending_external",
      phase: "external",
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    });
  });

  it("is case-insensitive and fails open to polling on an unknown status", () => {
    expect(mapSep6Status("COMPLETED").settled).toBe(true);
    expect(mapSep6Status("Too_Small").terminalFailure).toBe(true);
    expect(mapSep6Status("some_new_state")).toEqual({
      status: "some_new_state",
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    });
    expect(mapSep6Status("").settled).toBe(false);
  });
});

describe("getTransaction", () => {
  async function getTx(body: unknown, response: FakeResponse = res(body)) {
    const { fn } = fakeFetch({ "GET /transaction": response });
    const c = corridor();
    return new Sep6Adapter(c, { fetchImpl: fn }).getTransaction("tx-1");
  }

  it("carries the withdraw account and memo so a later run can verify them", async () => {
    const r = await getTx({
      transaction: {
        status: "pending_user_transfer_start",
        amount_in: " 5.00 ",
        amount_in_asset: "stellar:USDC:GISSUER",
        withdraw_anchor_account: "GANCHOR",
        withdraw_memo: "aGVsbG8=",
        withdraw_memo_type: "HASH",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.awaitingInput).toBe(true);
    expect(r.value.amountIn).toEqual({ asset: "stellar:USDC:GISSUER", amount: "5.00" });
    expect(r.value.depositAddress).toBe("GANCHOR");
    expect(r.value.memo).toBe("aGVsbG8=");
    expect(r.value.memoType).toBe("hash");
  });

  it("omits each malformed field on its own and never launders a float", async () => {
    const r = await getTx({
      transaction: {
        status: "completed",
        // A number has already been through a float64.
        amount_in: 5.0,
        withdraw_anchor_account: "GANCHOR",
        withdraw_memo: 12345,
        withdraw_memo_type: "base64",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amountIn).toBeUndefined();
    expect(r.value.memo).toBeUndefined();
    expect(r.value.memoType).toBeUndefined();
    expect(r.value.depositAddress).toBe("GANCHOR");
    expect(r.value.settled).toBe(true);
  });

  it("reports a refund the anchor made, in the amount-in denomination", async () => {
    const r = await getTx({
      transaction: {
        status: "refunded",
        amount_in: "5.00",
        amount_in_asset: "stellar:USDC:GISSUER",
        refunds: {
          amount_refunded: "5.00",
          amount_fee: "0.10",
          payments: [{ id: "abc123", id_type: "stellar", amount: "4.90", fee: "0.10" }],
        },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.terminalFailure).toBe(true);
    expect(r.value.refunds?.payments).toHaveLength(1);
    expect(r.value.refunds?.payments[0]?.amount).toEqual({
      asset: "stellar:USDC:GISSUER",
      amount: "4.90",
    });
  });

  it("ignores a malformed refunds object without failing the poll", async () => {
    const r = await getTx({
      transaction: { status: "completed", refunds: { amount_refunded: 5 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.refunds).toBeUndefined();
      expect(r.value.settled).toBe(true);
    }
  });

  it("names the bridge asset when the anchor reports an amount without one", async () => {
    const r = await getTx({ transaction: { status: "completed", amount_in: "5.00" } });
    expect(r.ok && r.value.amountIn).toEqual({ asset: "USDC", amount: "5.00" });
  });

  it("fails closed on an unreadable body and on an HTTP error", async () => {
    const noStatus = await getTx({}, res({ transaction: { status: 42 } }));
    expect(!noStatus.ok && noStatus.error.code).toBe("ANCHOR_UNAVAILABLE");
    expect(!noStatus.ok && noStatus.error.retryable).toBe(true);

    const five = await getTx({}, res({ error: "server error" }, false, 500));
    expect(!five.ok && five.error.retryable).toBe(true);

    const four = await getTx({}, res({ error: "not found" }, false, 404));
    expect(!four.ok && four.error.retryable).toBe(false);
  });
});

describe("ensureCompliance", () => {
  it("refuses a SEP-6 dest with no kyc_server instead of assuming a KYC-less lane", async () => {
    const c = corridor();
    const { fn, calls } = fakeFetch({});
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).ensureCompliance(intent, c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("KYC_REQUIRED");
      // Issue #193 owns compliance routing for SEP-6; say so rather than
      // silently accepting the #191-style 1:1 assumption.
      expect(r.error.message).toContain("#193");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an unregistered recipient without touching the network", async () => {
    const c = corridor({ kyc_server: "https://d.example/sep12" });
    const { fn, calls } = fakeFetch({});
    const r = await new Sep6Adapter(c, {
      fetchImpl: fn,
    }).ensureCompliance({ ...intent, recipient: { id: "r" } }, c);
    expect(!r.ok && r.error.code).toBe("KYC_REQUIRED");
    expect(!r.ok && r.error.message).toContain("no SEP-12 customer id");
    expect(calls).toHaveLength(0);
  });

  it("maps SEP-12 statuses through GET /customer with the manifest's type", async () => {
    for (const [sep12, expected] of [
      ["ACCEPTED", "accepted"],
      ["PROCESSING", "pending"],
      ["NEEDS_INFO", "pending"],
      ["REJECTED", "rejected"],
    ] as const) {
      const { fn, calls } = fakeFetch({
        "GET /sep12/customer": res({ id: "cust-1", status: sep12 }),
      });
      const c = corridor({ kyc_server: "https://d.example/sep12" });
      const r = await new Sep6Adapter(c, { fetchImpl: fn }).ensureCompliance(intent, c);
      expect(r.ok && r.value.status).toBe(expected);
      expect(params(calls[0]).get("type")).toBe("sep31-receiver");
      expect(params(calls[0]).get("id")).toBe("cust-1");
    }
  });

  it("reads anchorCustomerId through the shared SEP-12 check, ahead of sep12Id", async () => {
    const { fn, calls } = fakeFetch({
      "GET /sep12/customer": res({ id: "cust-2", status: "ACCEPTED" }),
    });
    const c = corridor({ kyc_server: "https://d.example/sep12" });
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).ensureCompliance(
      { ...intent, recipient: { id: "r", sep12Id: "cust-1", anchorCustomerId: "cust-2" } },
      c,
    );
    expect(r.ok && r.value.status).toBe("accepted");
    expect(params(calls[0]).get("id")).toBe("cust-2");
  });

  it("treats an anchor outage as retryable and a 4xx as final", async () => {
    const c = corridor({ kyc_server: "https://d.example/sep12" });
    const { fn } = fakeFetch({ "GET /sep12/customer": res({}, false, 502) });
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).ensureCompliance(intent, c);
    expect(!r.ok && r.error.code).toBe("KYC_REQUIRED");
    expect(!r.ok && r.error.retryable).toBe(true);
  });
});

describe("requestQuote", () => {
  const endpoints = { quote_server: "https://d.example/sep38" };

  it("refuses without a quote server, naming #196", async () => {
    const c = corridor();
    const { fn, calls } = fakeFetch({});
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(r.error.message).toContain("#196");
    }
    expect(calls).toHaveLength(0);
  });

  it("posts a context=sep6 SEP-38 quote and honours the anchor's own sell_amount", async () => {
    const { fn, calls } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-6",
        price: "250",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "5.50",
        buy_amount: "1375.00",
        fee: { total: "0.25", asset: "stellar:USDC:GISSUER" },
      }),
    });
    const c = corridor(endpoints);
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        id: "q-6",
        price: "250",
        expiresAt: expect.any(Number),
        sourceAmount: { asset: "USDC", amount: "5.50" },
        destAmount: { asset: "iso4217:ARS", amount: "1375.00" },
        fee: { asset: "USDC", amount: "0.25" },
        firm: true,
      });
    }
    expect(calls[0].body).toEqual({
      context: "sep6",
      sell_asset: "stellar:USDC:GISSUER",
      buy_asset: "iso4217:ARS",
      sell_amount: "5.00",
    });
  });

  it("refuses a quote it cannot read", async () => {
    for (const body of [
      {},
      { id: "q", price: 250, buy_amount: "1", expires_at: "later" },
      { id: "q", price: "250", buy_amount: "1" },
      { id: "q", price: "250", expires_at: new Date().toISOString() },
    ]) {
      const { fn } = fakeFetch({ "POST /sep38/quote": res(body) });
      const c = corridor(endpoints);
      const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("QUOTE_UNAVAILABLE");
    }
  });

  it("refuses a fee denominated in something other than the sell asset", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q",
        price: "250",
        buy_amount: "1250.00",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        fee: { total: "1.00", asset: "iso4217:ARS" },
      }),
    });
    const c = corridor(endpoints);
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(!r.ok && r.error.message).toContain("does not match sell asset");
  });

  it("refuses a firm quote whose total_price x buy_amount does not match sell_amount", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-inconsistent",
        price: "250",
        total_price: "0.002", // 1250.00 x 0.002 = 2.50, but sell_amount is 5.00
        buy_amount: "1250.00",
        sell_amount: "5.00",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    const c = corridor(endpoints);
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(r.error.message).toContain("internally inconsistent");
    }
  });

  it("accepts a firm quote whose total_price agrees with sell_amount", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q-consistent",
        price: "250",
        total_price: "0.004", // 1250.00 x 0.004 = 5.00
        buy_amount: "1250.00",
        sell_amount: "5.00",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    const c = corridor(endpoints);
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(r.ok).toBe(true);
  });

  it("treats a 5xx quote failure as retryable", async () => {
    const { fn } = fakeFetch({ "POST /sep38/quote": res({}, false, 503) });
    const c = corridor(endpoints);
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(!r.ok && r.error.retryable).toBe(true);
  });
});

describe("requestRefund", () => {
  it("fails closed with REFUND_UNSUPPORTED and makes no call", async () => {
    const c = corridor();
    const { fn, calls } = fakeFetch({});
    const r = await new Sep6Adapter(c, { fetchImpl: fn }).requestRefund(
      "tx-1",
      { asset: "USDC", amount: "5.00" },
      "wrong amount",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REFUND_UNSUPPORTED");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("no sender-initiated refund endpoint");
      expect(r.error.message).toContain("out-of-band");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("capabilities", () => {
  it("reports what the manifest's endpoints actually say", () => {
    expect(new Sep6Adapter(corridor()).capabilities()).toEqual({
      protocol: "sep6",
      quotes: ["none"],
      // Not "none": the engine skips ensureCompliance when kyc is "none", and this
      // adapter refuses (KYC_REQUIRED) a lane with no kyc_server rather than assume
      // it needs no KYC. "sep6_fields" keeps the compliance step in the run.
      kyc: "sep6_fields",
      settlement: ["stellar_payment"],
      refunds: "report_only",
      callbacks: false,
    });
    expect(
      new Sep6Adapter(
        corridor({
          kyc_server: "https://d.example/sep12",
          quote_server: "https://d.example/sep38",
        }),
      ).capabilities(),
    ).toEqual({
      protocol: "sep6",
      quotes: ["sep38_firm"],
      kyc: "sep12",
      settlement: ["stellar_payment"],
      refunds: "report_only",
      callbacks: false,
    });
  });
});

describe("SEP-10 auth is fail-closed", () => {
  const routes = (extra: Record<string, FakeResponse> = {}) => ({
    "GET /auth": res({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
    "POST /auth": res({}, false, 500),
    ...extra,
  });

  it("refuses an anonymous fallback when a signer is configured but the handshake fails", async () => {
    const { fn, calls } = fakeFetch(routes());
    const c = corridor({ web_auth: "https://d.example/auth" });
    const adapter = new Sep6Adapter(c, {
      fetchImpl: fn,
      sep10: { account: "GSIGNER", signChallenge: async () => "signed" },
    });
    const opened = await adapter.openTransaction(intent, quote(), c);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(opened.error.message).toContain("SEP-10 auth failed");
      expect(opened.error.retryable).toBe(true);
    }
    // The initiate never went out on a broken handshake.
    expect(calls.filter((x) => x.url.includes("/withdraw-exchange"))).toHaveLength(0);
  });

  it("reuses the cached JWT until near expiry", async () => {
    const token = jwt(900);
    const { fn, calls } = fakeFetch({
      "GET /auth": res({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
      "POST /auth": res({ token }),
      "GET /withdraw-exchange": res({ id: "tx-1", account_id: "G" }),
    });
    const c = corridor({ web_auth: "https://d.example/auth" });
    const adapter = new Sep6Adapter(c, {
      fetchImpl: fn,
      sep10: { account: "GSIGNER", signChallenge: async () => "signed" },
    });
    await adapter.openTransaction(intent, quote(), c);
    await adapter.openTransaction(intent, quote(), c);
    expect(calls.filter((x) => x.url.includes("/auth"))).toHaveLength(2);
    expect(calls.filter((x) => x.url.includes("/withdraw-exchange"))).toHaveLength(2);
  });
});

describe("engine end-to-end: a SEP-6 withdrawal settles over StellarPaymentStrategy", () => {
  // No engine changes: `openTransaction` returns the flat OpenTransaction
  // `buildSettlementRequest` already reads, and `getTransaction` returns the
  // reconcile model the poll loop already consumes.
  it("walks quote, comply, open, settle, reconcile to completed", async () => {
    const { fn } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q6",
        price: "250",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "5.00",
        buy_amount: "1250.00",
      }),
      "GET /sep12/customer": res({ id: "cust-1", status: "ACCEPTED" }),
      "GET /withdraw-exchange": res({
        id: "tx-e2e",
        account_id: "GANCHOR6",
        memo: "aGVsbG8=",
        memo_type: "hash",
      }),
      "GET /transaction": res({
        transaction: {
          status: "completed",
          amount_in: "5.00",
          amount_in_asset: "stellar:USDC:GISSUER",
          withdraw_anchor_account: "GANCHOR6",
          withdraw_memo: "aGVsbG8=",
          withdraw_memo_type: "hash",
        },
      }),
    });

    const c = corridor({
      quote_server: "https://d.example/sep38",
      kyc_server: "https://d.example/sep12",
    });
    const adapter = new Sep6Adapter(c, { fetchImpl: fn });
    const submitter = createMockSubmitter();
    const submitSpy = vi.spyOn(submitter, "submit");

    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      strategies: [new StellarPaymentStrategy(submitter)],
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(
      {
        ...intent,
        idempotencyKey: "sep6-e2e",
        destinationFields: { account_number: "12345" },
      },
      c,
      deps,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("completed");
    expect(r.value.trail).toEqual([
      "created",
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "reconciled",
      "completed",
    ]);

    // The on-chain leg went to the account the ANCHOR named, at the quoted
    // amount, with the hash memo intact.
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const req = submitSpy.mock.calls[0][0];
    expect(req.to).toBe("GANCHOR6");
    expect(req.memo).toBe("aGVsbG8=");
    expect(req.memoType).toBe("hash");
    expect(req.amount).toEqual({ asset: "USDC", amount: "5.00" });
  });
});

describe("scripted mock SEP-6 anchor (mock-sep6-anchor) and conformance (#200)", () => {
  const fullEndpoints = {
    web_auth: "https://d.example/auth",
    quote_server: "https://d.example/sep38",
    kyc_server: "https://d.example/sep12",
  };

  const mockSigner: Sep10Signer = {
    account: "GSIGNER",
    signChallenge: async (xdr) => `signed(${xdr})`,
  };

  it("walks a multi-step scripted status progression from created to completed", async () => {
    const mock = createMockSep6Anchor({
      statuses: [
        "pending_user_transfer_start",
        "pending_anchor",
        "pending_external",
        "completed",
      ],
      anchorAccount: "GMOCKSEP6DEPOSIT",
      memo: "aGVsbG8=",
      memoType: "hash",
    });

    const c = corridor(fullEndpoints);
    const adapter = new Sep6Adapter(c, { fetchImpl: mock.fetchImpl, sep10: mockSigner });

    const infoRes = await adapter.info();
    expect(infoRes.ok).toBe(true);
    if (infoRes.ok) {
      expect(infoRes.value.withdrawExchange.ARS?.enabled).toBe(true);
    }

    const submitter = createMockSubmitter();
    let nowMs = 1_700_000_000_000;
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      strategies: [new StellarPaymentStrategy(submitter)],
      idempotency: new InMemoryIdempotencyStore(),
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      reconcilePollMs: 100,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(
      {
        ...intent,
        idempotencyKey: "sep6-scripted-e2e",
        destinationFields: { type: "bank_account", dest: "12345" },
      },
      c,
      deps,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("completed");
    expect(r.value.trail).toEqual([
      "created",
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "reconciled",
      "completed",
    ]);

    const txPolls = mock.calls.filter((call) => call.url.includes("/transaction"));
    expect(txPolls).toHaveLength(4);
  });

  it("routes terminal anchor `error` status into the recovery path (held / refunded)", async () => {
    const mockHold = createMockSep6Anchor({
      statuses: ["pending_anchor", "error"],
    });
    const baseCorridor = corridor(fullEndpoints);
    const holdCorridor: Corridor = {
      ...baseCorridor,
      recovery: { ...baseCorridor.recovery, rollback: "hold" },
    };
    const holdAdapter = new Sep6Adapter(holdCorridor, {
      fetchImpl: mockHold.fetchImpl,
      sep10: mockSigner,
    });
    const holdStore = new InMemoryIdempotencyStore();
    const holdSubmitter = createMockSubmitter();
    let nowMs = 1_700_000_000_000;

    const holdRes = await execute(
      { ...intent, idempotencyKey: "sep6-error-hold" },
      holdCorridor,
      {
        resolver: new StaticRouteResolver(() => holdAdapter, {
          trustManifestWithoutAttestation: true,
        }),
        submitter: holdSubmitter,
        strategies: [new StellarPaymentStrategy(holdSubmitter)],
        idempotency: holdStore,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
        reconcilePollMs: 50,
        trustManifestWithoutAttestation: true,
        unsafeSkipPreSettleGate: true,
      },
    );

    expect(holdRes.ok).toBe(false);
    if (!holdRes.ok) {
      expect(holdRes.error.code).toBe("RECONCILE_MISMATCH");
      expect(holdRes.error.message).toContain("status=error");
    }
    const storedHold = await holdStore.get("sep6-error-hold");
    expect(storedHold?.state).toBe("held");

    // Also verify refund_sender recovery when the anchor reports a full refund on `error`.
    const mockRefund = createMockSep6Anchor({
      statuses: ["pending_anchor", "error"],
      refunds: {
        amount_refunded: "5.00",
        amount_fee: "0.00",
        payments: [{ id: "stellar-ref-1", id_type: "stellar", amount: "5.00", fee: "0.00" }],
      },
    });
    const refundCorridor: Corridor = {
      ...baseCorridor,
      recovery: { ...baseCorridor.recovery, rollback: "refund_sender" },
    };
    const refundAdapter = new Sep6Adapter(refundCorridor, {
      fetchImpl: mockRefund.fetchImpl,
      sep10: mockSigner,
    });
    const refundStore = new InMemoryIdempotencyStore();
    const refundSubmitter = createMockSubmitter();

    const refundRes = await execute(
      { ...intent, idempotencyKey: "sep6-error-refund" },
      refundCorridor,
      {
        resolver: new StaticRouteResolver(() => refundAdapter, {
          trustManifestWithoutAttestation: true,
        }),
        submitter: refundSubmitter,
        strategies: [new StellarPaymentStrategy(refundSubmitter)],
        idempotency: refundStore,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
        reconcilePollMs: 50,
        trustManifestWithoutAttestation: true,
        unsafeSkipPreSettleGate: true,
      },
    );

    expect(refundRes.ok).toBe(false);
    const storedRefund = await refundStore.get("sep6-error-refund");
    expect(storedRefund?.state).toBe("refunded");
    expect(storedRefund?.refundId).toBe("stellar-ref-1");
  });

  it("includes awaiting-input detail in the timeout message on pending_customer_info_update", async () => {
    const mock = createMockSep6Anchor({
      statuses: ["pending_customer_info_update"],
    });
    const baseCorridor = corridor(fullEndpoints);
    const timeoutCorridor: Corridor = {
      ...baseCorridor,
      recovery: {
        ...baseCorridor.recovery,
        timeout_seconds: 10,
        rollback: "hold",
      },
    };
    const adapter = new Sep6Adapter(timeoutCorridor, {
      fetchImpl: mock.fetchImpl,
      sep10: mockSigner,
    });
    const submitter = createMockSubmitter();
    const store = new InMemoryIdempotencyStore();
    let nowMs = 1_700_000_000_000;

    const r = await execute(
      { ...intent, idempotencyKey: "sep6-awaiting-input-timeout" },
      timeoutCorridor,
      {
        resolver: new StaticRouteResolver(() => adapter, {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        strategies: [new StellarPaymentStrategy(submitter)],
        idempotency: store,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
        reconcilePollMs: 3_000,
        stallThreshold: 0,
        trustManifestWithoutAttestation: true,
        unsafeSkipPreSettleGate: true,
      },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.message).toContain("last status=pending_customer_info_update");
      expect(r.error.message).toContain("awaiting input from another party");
    }
    const stored = await store.get("sep6-awaiting-input-timeout");
    expect(stored?.state).toBe("held");
  });

  it("passes both conformanceSuite and runConformance against the mock SEP-6 anchor", async () => {
    const mock = createMockSep6Anchor();
    const c = corridor(fullEndpoints);
    const adapter = new Sep6Adapter(c, { fetchImpl: mock.fetchImpl, sep10: mockSigner });

    for (const probe of conformanceSuite(adapter, intent, c)) {
      expect(await probe.run(), `probe failed: ${probe.name}`).toBe(true);
    }

    const report = await runConformance(
      adapter,
      { intent, corridor: c },
      { allowNetworkWrites: true },
    );
    expectConformance(report);
  });
});
