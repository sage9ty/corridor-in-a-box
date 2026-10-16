// @corridor/sep31 — ONE adapter that works for any standards-compliant SEP-31
// receiving anchor (Anclap, Bitso, the Anchor Platform testnet reference server, ...).
//
// This is the whole point of the standard: you don't write a new adapter per anchor.
// Bespoke exchanges/OTC desks that don't speak SEP-31 implement AnchorAdapter
// directly instead — bespoke implementations are outside this generic adapter
// and could be maintained separately; no private repo is assumed to exist.
//
// The HTTP shapes below follow SEP-31 (GET /info, POST /transactions,
// GET /transactions/:id), SEP-38 (POST /quote), SEP-10 (GET/POST web_auth) and
// SEP-12 (GET /customer). The crypto for SEP-10 — parsing and signing the
// challenge transaction XDR — lives behind an injected Sep10Signer so this
// adapter never has to depend on a Stellar SDK. The on-chain settle leg is NOT
// here; that's the engine's job.

import type { Sep31Anchor, Corridor } from "@corridor/manifest";
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
} from "@corridor/types";
import type {
  AdapterCapabilities,
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  RefundInfo,
  RefundPayment,
  RefundRef,
  TransactionStatus,
} from "@corridor/adapter-kit";
import type { CheckResult, GateCheck, GateContext } from "@corridor/engine";

type FetchLike = typeof fetch;

/**
 * How far `total_price × buy_amount` may drift from `sell_amount` before we
 * treat a firm quote as internally inconsistent. Anchors round to their payout
 * asset's precision (2dp for most fiat) while prices are quoted to 7+, so exact
 * equality is the wrong test — 0.1% absorbs legitimate rounding without hiding a
 * quote that simply does not add up.
 */
const QUOTE_TOLERANCE = "0.001";

/**
 * Signs a SEP-10 challenge. The concrete implementation (Keypair + Transaction
 * from @stellar/stellar-sdk) is supplied by the caller, keeping this package
 * free of a chain SDK. See @corridor/stellar for a ready-made signer.
 */
export interface Sep10Signer {
  /** The Stellar account (G…) being authenticated. */
  readonly account: string;
  /** Sign the base64 challenge XDR and return the signed XDR. */
  signChallenge(challengeXdr: string, networkPassphrase: string): Promise<string>;
}

export interface Sep31AdapterOptions {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: FetchLike;
  /** SEP-10 signer. Without it the adapter calls anchors anonymously. */
  sep10?: Sep10Signer;
}

/** Terminal non-success at the anchor: stop polling, hand over to recovery. */
const TERMINAL_FAILURE_STATUSES = new Set(["refunded", "expired", "error"]);

/**
 * In flight and blocked on input from outside the engine — the anchor is not
 * working on the transfer, it is waiting for someone to supply something.
 * `incomplete` is the Anchor Platform's "the SEP-12 customer record isn't
 * complete yet"; the two `*_info_update` statuses are the anchor explicitly
 * asking for a correction via `PATCH /transactions/:id`.
 */
const AWAITING_INPUT_STATUSES = new Set([
  "incomplete",
  "pending_customer_info_update",
  "pending_transaction_info_update",
]);

/**
 * In flight with the work on the anchor's side (or the network's). Classified
 * explicitly rather than left to the default so that "we know this status and
 * it means keep waiting" is distinguishable from "we have never seen this".
 */
const IN_FLIGHT_STATUSES = new Set([
  "pending_sender",
  "pending_receiver",
  "pending_external",
  "pending_anchor",
  "pending_stellar",
]);

/**
 * Classify a SEP-31 transaction status into the engine's reconcile model.
 *
 * SEP-31 defines a lifecycle of `pending_*` / `incomplete` (in flight) plus the
 * terminals `completed` (success), `refunded`, `expired`, and `error`. The engine
 * needs these buckets:
 *   - settled         → `completed`
 *   - terminalFailure → `refunded` | `expired` | `error`  (stop polling, recover)
 *   - awaitingInput   → `incomplete` | `pending_customer_info_update` |
 *                       `pending_transaction_info_update` (in flight, but the
 *                       hold-up is someone else's input, not the anchor's work)
 *   - otherwise        → still in flight, keep polling
 * Unknown statuses are treated as in-flight (fail-open to polling, never to a
 * false "settled"). Exported so it can grow as real anchors surface new statuses.
 */
export function mapSep31Status(raw: string): {
  status: string;
  phase?: "anchor" | "external";
  settled: boolean;
  terminalFailure: boolean;
  awaitingInput: boolean;
} {
  const status = (raw ?? "").toLowerCase();
  if (status === "completed") {
    return { status, settled: true, terminalFailure: false, awaitingInput: false };
  }
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    return { status, settled: false, terminalFailure: true, awaitingInput: false };
  }
  if (AWAITING_INPUT_STATUSES.has(status)) {
    return { status, settled: false, terminalFailure: false, awaitingInput: true };
  }
  if (IN_FLIGHT_STATUSES.has(status)) {
    return {
      status,
      ...(status === "pending_external" || status === "pending_receiver"
        ? { phase: "external" as const }
        : {}),
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    };
  }
  // Unrecognised status. Same shape as a known in-flight one on purpose: the
  // default must stay fail-open to polling and never to a false "settled".
  return { status, settled: false, terminalFailure: false, awaitingInput: false };
}

/** The `refunds` object as SEP-31 puts it on the wire — every field untrusted. */
interface RawRefunds {
  amount_refunded?: unknown;
  amount_fee?: unknown;
  payments?: unknown;
}

/**
 * A decimal amount string, or undefined if the anchor sent anything else.
 *
 * Deliberately refuses numbers. An anchor that sends `100.1` as JSON has
 * already put the value through a float64, and accepting it here would launder
 * that into a `Money` the rest of the system trusts. Better to report nothing
 * than to report a number that has already lost precision.
 */
function amountString(v: unknown): string | undefined {
  return typeof v === "string" && isValidAmount(v.trim()) ? v.trim() : undefined;
}

/** A non-empty string, or undefined if the anchor sent anything else. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * SEP-31's `stellar_memo_type`, case-insensitively, or undefined when absent or
 * not one of the three memo encodings Stellar supports. Never defaulted to
 * "text" here: a hash memo encoded as text is corrupted, so an unknown type is
 * reported as unknown.
 */
function parseMemoType(v: unknown): "text" | "hash" | "id" | undefined {
  const memoType = typeof v === "string" ? v.toLowerCase() : undefined;
  return memoType === "hash" || memoType === "id" || memoType === "text"
    ? memoType
    : undefined;
}

/**
 * Parse SEP-31's `refunds` object off a transaction record.
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

  const amountRefunded = amountString(raw.amount_refunded);
  if (amountRefunded === undefined) return undefined;

  // A missing fee is a real answer — nothing was withheld. A malformed one is
  // not, but it does not invalidate the refunded amount, so it reads as zero.
  const amountFee = amountString(raw.amount_fee) ?? "0";

  const payments: RefundPayment[] = [];
  if (Array.isArray(raw.payments)) {
    for (const entry of raw.payments) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const p = entry as { id?: unknown; id_type?: unknown; amount?: unknown; fee?: unknown };
      const amount = amountString(p.amount);
      // An entry with no id or no readable amount says nothing; drop that entry
      // rather than the whole refund, which the totals above still describe.
      if (typeof p.id !== "string" || !p.id || amount === undefined) continue;
      payments.push({
        id: p.id,
        ...(typeof p.id_type === "string" && p.id_type ? { idType: p.id_type } : {}),
        amount: { asset, amount },
        fee: { asset, amount: amountString(p.fee) ?? "0" },
      });
    }
  }

  const settled = settledAmount !== undefined ? amountString(settledAmount) : undefined;
  let completeness: RefundInfo["completeness"] = "unknown";
  if (settled !== undefined) {
    const cmp = compareAmounts(amountRefunded, settled);
    // An over-refund (cmp > 0) is anomalous but not partial: the whole payment
    // came back and then some. Reporting it as "partial" would be a lie.
    if (cmp.ok) completeness = cmp.value < 0 ? "partial" : "full";
  }

  return {
    amountRefunded: { asset, amount: amountRefunded },
    amountFee: { asset, amount: amountFee },
    payments,
    completeness,
  };
}

/**
 * SEP-38 Asset Identification Format for the corridor's bridge asset:
 * `stellar:native` for XLM, `stellar:CODE:ISSUER` for everything else. Anchors
 * reject issuer-less Stellar asset ids ("sell_asset not found").
 */
function sep38SellAsset(corridor: Corridor): string {
  const code = corridor.settlement.bridge_asset;
  return code.toUpperCase() === "XLM"
    ? "stellar:native"
    : `stellar:${code}:${corridor.settlement.asset_issuer}`;
}

/** Decode a JWT's `exp` claim (epoch ms) without verifying it. */
function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class Sep31Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: Sep31Anchor;
  /** Bridge asset for this corridor — the denomination `amount_in` is reported in. */
  private readonly settlementAsset: string;
  private readonly fetchImpl: FetchLike;
  private readonly sep10?: Sep10Signer;
  private cachedToken?: { token: string; expMs: number };

  constructor(corridor: Corridor, opts: Sep31AdapterOptions = {}) {
    if (corridor.dest.protocol !== "sep31") {
      throw new Error(
        `Sep31Adapter cannot handle protocol "${corridor.dest.protocol}"; use an adapter for that protocol`,
      );
    }
    this.anchor = corridor.dest as Sep31Anchor;
    this.settlementAsset = corridor.settlement.bridge_asset;
    this.name = corridor.dest.name;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sep10 = opts.sep10;
  }

  // SEP-10 challenge/response: GET a challenge transaction, sign it, POST it back
  // for a JWT. Cached until ~30s before expiry.
  //
  // FAILS CLOSED. This previously returned `undefined` on every failure path and
  // callers carried on unauthenticated — so an anchor that 500'd on /auth got
  // its SEP-12 status read anonymously, and whatever it said back was treated as
  // an authenticated compliance answer. Now: if a signer is configured, a failed
  // handshake is a hard, retryable error. `ok(undefined)` means one thing only —
  // no auth was configured for this anchor, so anonymous access is intended.
  private async authToken(): Promise<Outcome<string | undefined>> {
    const webAuth = this.anchor.endpoints.web_auth;
    if (!webAuth || !this.sep10) return ok(undefined);

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expMs - 30_000 > now) {
      return ok(this.cachedToken.token);
    }

    const authFailed = (why: string) =>
      fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-10 auth failed (${why})`, {
        retryable: true,
      });

    try {
      const url = new URL(webAuth);
      url.searchParams.set("account", this.sep10.account);
      url.searchParams.set("home_domain", this.anchor.endpoints.home_domain);
      const challengeRes = await this.fetchImpl(url.toString());
      if (!challengeRes.ok) return authFailed(`challenge HTTP ${challengeRes.status}`);
      const challenge = (await challengeRes.json()) as {
        transaction?: string;
        network_passphrase?: string;
      };
      if (!challenge.transaction || !challenge.network_passphrase) {
        return authFailed("challenge response missing transaction/network_passphrase");
      }

      const signed = await this.sep10.signChallenge(
        challenge.transaction,
        challenge.network_passphrase,
      );
      const tokenRes = await this.fetchImpl(webAuth, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: signed }),
      });
      if (!tokenRes.ok) return authFailed(`token HTTP ${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token?: string };
      if (!token) return authFailed("token response missing `token`");

      this.cachedToken = { token, expMs: jwtExpiryMs(token) ?? now + 15 * 60_000 };
      return ok(token);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-10 auth request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /** `Authorization` header for an authenticated call, or {} when the corridor
   *  configures no SEP-10. Propagates an auth failure to the caller. */
  private authHeader(token: string | undefined): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private base(corridor: Corridor): Outcome<{ sep31: string; sep38?: string }> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) {
      return fail(
        "ANCHOR_UNAVAILABLE",
        `${this.name}: no SEP-31 transfer server configured for corridor ${corridor.id}`,
      );
    }
    return ok({ sep31, sep38: this.anchor.endpoints.quote_server });
  }

  capabilities(): AdapterCapabilities {
    const e = this.anchor.endpoints;
    return {
      protocol: "sep31",
      quotes: e.quote_server ? ["sep38_firm"] : ["none"],
      kyc: e.kyc_server ? "sep12" : "none",
      settlement: ["stellar_payment"],
      refunds: "report_only",
      callbacks: false,
    };
  }

  async requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    if (!b.value.sep38) {
      return fail("QUOTE_UNAVAILABLE", `${this.name}: anchor exposes no SEP-38 quote server`);
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${b.value.sep38}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({
          // Required by SEP-38: the protocol the quote will be executed under.
          context: "sep31",
          sell_asset: sep38SellAsset(corridor),
          buy_asset: this.anchor.asset,
          sell_amount: intent.sourceAmount.amount,
        }),
      });
      if (!res.ok) {
        return fail("QUOTE_UNAVAILABLE", `${this.name}: quote HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as {
        id: string;
        /** Conversion rate EXCLUDING fees. Not the rate the payment executes at. */
        price: string;
        /** sell_amount / buy_amount — the all-in rate, fees included. */
        total_price?: string;
        expires_at: string;
        sell_amount: string;
        buy_amount: string;
        fee?: { total: string; asset: string };
      };

      // Honour the anchor's OWN sell_amount, not the amount we asked for. The
      // anchor may adjust for fees, rounding or minimums, and the firm quote
      // binds to its number — settling the requested amount instead means the
      // payout will not match and reconcile fails only after the money has left.
      const sellAmount = j.sell_amount ?? intent.sourceAmount.amount;
      if (!isValidAmount(sellAmount)) {
        return fail(
          "QUOTE_UNAVAILABLE",
          `${this.name}: quote sell_amount "${sellAmount}" is malformed`,
        );
      }

      // Cross-check the anchor's arithmetic before trusting a firm quote.
      //
      // Get the SEP-38 semantics right, because they are easy to get wrong:
      //   price        conversion rate EXCLUDING fees
      //   total_price  sell_amount / buy_amount, i.e. the all-in rate
      //   fee          charged in fee.asset, typically the sell side
      // so the invariant that actually holds is
      //   sell_amount ≈ total_price × buy_amount
      // NOT `buy_amount ≈ price × sell_amount`, which is wrong twice over
      // (inverted, and using the pre-fee rate). Against the Anchor Platform
      // reference server: sell 10, fee 1.00, price 1.0500035,
      // total_price 1.1666705555, buy 8.57 — and 1.1666705555 × 8.57 ≈ 10. ✓
      //
      // Only checkable when the anchor sends total_price; skip rather than guess.
      if (j.total_price && isValidAmount(j.total_price) && isValidAmount(j.buy_amount)) {
        const impliedSell = applyPrice(j.buy_amount, j.total_price);
        if (impliedSell.ok) {
          const drift = subAmounts(impliedSell.value, sellAmount);
          const tolerance = applyPrice(sellAmount, QUOTE_TOLERANCE);
          if (drift.ok && tolerance.ok) {
            const abs = drift.value.startsWith("-") ? drift.value.slice(1) : drift.value;
            const within = compareAmounts(abs, tolerance.value);
            if (within.ok && within.value > 0) {
              return fail(
                "QUOTE_UNAVAILABLE",
                `${this.name}: quote ${j.id} is internally inconsistent — ` +
                  `total_price ${j.total_price} × buy_amount ${j.buy_amount} = ` +
                  `${impliedSell.value}, but sell_amount is ${sellAmount}`,
              );
            }
          }
        }
      }

      // The fee has to be in exactly the asset we asked to sell: a SEP-38 asset id, issuer included
      // (the same code from another issuer is a different asset). Anything else would change what
      // must be sent, so the quote is refused until someone proves the semantics of that case.
      let fee: Money | undefined;
      if (j.fee) {
        const sellAsset = sep38SellAsset(corridor);
        if (j.fee.asset !== sellAsset) {
          return fail(
            "QUOTE_UNAVAILABLE",
            `${this.name}: quote fee asset "${j.fee.asset}" does not match sell asset "${sellAsset}"`,
          );
        }
        // A malformed total is dropped rather than guessed at.
        if (isValidAmount(j.fee.total)) {
          fee = { asset: intent.sourceAmount.asset, amount: j.fee.total };
        }
      }

      return ok<Quote>({
        id: j.id,
        price: j.price,
        expiresAt: Date.parse(j.expires_at),
        sourceAmount: { asset: intent.sourceAmount.asset, amount: sellAmount },
        destAmount: { asset: this.anchor.asset, amount: j.buy_amount },
        ...(fee && { fee }),
        firm: true,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: quote request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /**
   * SEP-12 `PUT /customer` — register a customer with the receiving anchor and
   * get back the id that identifies them in every later call.
   *
   * This is deliberately NOT part of `AnchorAdapter`, and the engine never calls
   * it. Registration is the SENDING side's job: it collects and verifies the
   * PII, hands it to the receiving anchor once, and thereafter refers to the
   * customer by opaque id. Keeping it off the port is what lets the engine
   * orchestrate payments without PII ever passing through it — `execute()` only
   * ever sees a `sep12Id`.
   *
   * Call this from your deployment layer before `execute()`, and put the
   * returned id on `intent.recipient.sep12Id`.
   *
   * `fields` are the SEP-12 fields the anchor asks for; which ones are required
   * comes from its `GET /customer` response and varies per anchor and per type.
   */
  async registerCustomer(
    fields: Record<string, string>,
    opts: { type?: string; account?: string } = {},
  ): Promise<Outcome<string>> {
    const kyc = this.anchor.endpoints.kyc_server;
    if (!kyc) {
      return fail("KYC_REQUIRED", `${this.name}: anchor exposes no SEP-12 KYC server`);
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${kyc}/customer`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({
          ...((opts.account ?? this.sep10?.account)
            ? { account: opts.account ?? this.sep10?.account }
            : {}),
          ...(opts.type ? { type: opts.type } : {}),
          ...fields,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return fail(
          "KYC_REQUIRED",
          `${this.name}: SEP-12 PUT /customer HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
          { retryable: res.status >= 500 },
        );
      }
      const j = (await res.json()) as { id?: string };
      if (!j.id) {
        return fail("KYC_REQUIRED", `${this.name}: SEP-12 PUT /customer returned no id`);
      }
      return ok(j.id);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 registration failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async ensureCompliance(
    intent: PaymentIntent,
    corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    const kyc = this.anchor.endpoints.kyc_server;
    if (!kyc) {
      // Some corridors deliver 1:1 with no per-customer KYC at the receiver.
      return ok<KycResult>({ status: "accepted" });
    }
    // SEP-12: check the receiving anchor's view of THE RECIPIENT's status. The
    // sending anchor collects/verifies PII and registers the customer with the
    // receiving anchor (SEP-12 PUT /customer), which returns the customer id we
    // carry as `recipient.sep12Id`. Here we only read status — no PII flows
    // through the engine. NEEDS_INFO / PROCESSING surface as "pending" so the
    // engine fails closed rather than settling early.
    //
    // This used to query `this.sep10?.account` — the OPERATOR's own signing
    // account — whenever a signer was configured, which is every production
    // wiring. It therefore answered "is the operator in good standing?" and
    // recorded the result as the recipient's KYC verdict: a compliance control
    // that reported a pass without ever evaluating the customer. Fail closed
    // instead when we have no id for the recipient.
    const sep12Id = intent.recipient.sep12Id;
    if (!sep12Id) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: recipient has no SEP-12 customer id — register the receiver ` +
          `with this anchor (SEP-12 PUT /customer) and set recipient.sep12Id before ` +
          `settling. Refusing to settle on an unverified recipient.`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const url = new URL(`${kyc}/customer`);
      url.searchParams.set("id", sep12Id);
      url.searchParams.set("type", corridor.compliance.sep12_receiver_type);
      const res = await this.fetchImpl(url.toString(), {
        headers: this.authHeader(auth.value),
      });
      if (!res.ok) {
        return fail("KYC_REQUIRED", `${this.name}: SEP-12 customer HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as { id?: string; status?: string };
      const status = (j.status ?? "").toUpperCase();
      if (status === "ACCEPTED") {
        return ok<KycResult>({ status: "accepted", customerId: j.id });
      }
      if (status === "REJECTED") {
        return ok<KycResult>({ status: "rejected", customerId: j.id });
      }
      // PROCESSING, NEEDS_INFO, or anything unknown → not yet cleared.
      return ok<KycResult>({ status: "pending", customerId: j.id });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    // SEP-31 requires the receiving anchor to know WHO it is paying out to. The
    // receiver_id is the SEP-12 customer id from registration; without it a
    // conformant anchor rejects the transaction, and a lenient one would open a
    // payment with no identified beneficiary.
    if (!intent.recipient.sep12Id) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: cannot open a SEP-31 transaction without recipient.sep12Id`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${b.value.sep31}/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({
          // The quote's sell amount, which requestQuote() now takes from the
          // anchor's own response rather than echoing what we asked for.
          amount: quote.sourceAmount.amount,
          asset_code: corridor.settlement.bridge_asset,
          asset_issuer: corridor.settlement.asset_issuer,
          // SEP-31 requires destination_asset whenever a quote_id is supplied —
          // the quote fixes a specific sell→buy pair, and the anchor rejects the
          // request (400) if the transaction doesn't name the same buy asset.
          destination_asset: corridor.dest.asset,
          quote_id: quote.id,
          receiver_id: intent.recipient.sep12Id,
          ...(intent.sender.sep12Id ? { sender_id: intent.sender.sep12Id } : {}),
          // Payout instructions, keyed by the names the anchor publishes under
          // `fields.transaction` in GET /sep31/info.
          fields: { transaction: intent.destinationFields ?? {} },
        }),
      });
      if (!res.ok) {
        // Include the anchor's own explanation. A bare status code turns every
        // 400 into a guessing game about which field it disliked.
        const detail = await res.text().catch(() => "");
        return fail(
          "ANCHOR_UNAVAILABLE",
          `${this.name}: open-tx HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
          { retryable: res.status >= 500 },
        );
      }
      const j = (await res.json()) as {
        id: string;
        stellar_account_id: string;
        stellar_memo?: string;
        stellar_memo_type?: string;
      };
      return ok<OpenTransaction>({
        transactionId: j.id,
        depositAddress: j.stellar_account_id,
        memo: j.stellar_memo,
        // Carry the anchor's memo TYPE through. Assuming "text" corrupts a hash
        // memo (32 bytes, over the 28-byte text cap) and the submit fails.
        memoType: parseMemoType(j.stellar_memo_type),
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: open-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /** Not part of AnchorAdapter. Used by the engine/service to register for push notifications. */
  async registerCallback(transactionId: string, url: string): Promise<Outcome<void>> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) return fail("ANCHOR_UNAVAILABLE", `${this.name}: no SEP-31 server`);
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${sep31}/transactions/${transactionId}/callback`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        return fail(
          "ANCHOR_UNAVAILABLE",
          `${this.name}: register callback HTTP ${res.status}`,
          { retryable: res.status >= 500 },
        );
      }
      return ok(undefined);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: register callback failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) return fail("ANCHOR_UNAVAILABLE", `${this.name}: no SEP-31 server`);
    try {
      const res = await this.fetchImpl(`${sep31}/transactions/${transactionId}`);
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as {
        transaction: {
          status: string;
          amount_in?: unknown;
          amount_in_asset?: unknown;
          refunds?: unknown;
          stellar_account_id?: unknown;
          stellar_memo?: unknown;
          stellar_memo_type?: unknown;
        };
      };
      const tx = j.transaction;
      const mapped = mapSep31Status(tx.status);

      // The asset the anchor itself names for `amount_in`, falling back to the
      // corridor's bridge asset. Refund amounts are reported in the same
      // denomination as the amount that went out; SEP-31 does not restate it.
      const asset =
        typeof tx.amount_in_asset === "string" && tx.amount_in_asset
          ? tx.amount_in_asset
          : this.settlementAsset;
      const settledAmount = typeof tx.amount_in === "string" ? tx.amount_in : undefined;

      // Parsed off the same record the poll already read, and kept strictly
      // separate from the classification above: a malformed `refunds` object
      // must never turn a readable status into an error.
      const refunds = parseRefunds(tx.refunds, asset, settledAmount);

      // The anchor's own record of what it expects to receive, for a pre-settle
      // cross-check against what we are about to send. Same rule as refunds:
      // each field is read on its own, and anything malformed is left out
      // rather than guessed — including a numeric amount_in, which has already
      // been through a float64.
      const amountIn = amountString(tx.amount_in);
      const depositAddress = nonEmptyString(tx.stellar_account_id);
      const memo = nonEmptyString(tx.stellar_memo);
      const memoType = parseMemoType(tx.stellar_memo_type);

      return ok<TransactionStatus>({
        ...mapped,
        ...(refunds ? { refunds } : {}),
        ...(amountIn !== undefined ? { amountIn: { asset, amount: amountIn } } : {}),
        ...(depositAddress !== undefined ? { depositAddress } : {}),
        ...(memo !== undefined ? { memo } : {}),
        ...(memoType !== undefined ? { memoType } : {}),
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }

  // Refund initiation: NOT IMPLEMENTABLE over SEP-31, on purpose. Do not "fix"
  // this by adding an HTTP call.
  //
  // SEP-31 defines four endpoints — GET /info, POST /transactions,
  // GET /transactions/:id, PATCH /transactions/:id — and none of them lets the
  // SENDING side ask for a refund. In the protocol, a refund is a decision the
  // RECEIVING anchor makes on its own side (payout failed, compliance bounced
  // it, funds came back), and it is only *reported* to us afterwards, through
  // the `refunds` object on the transaction record. There is no request; there
  // is only news.
  //
  // So anything this method could POST to would be a bespoke, anchor-specific
  // endpoint dressed up as protocol conformance — exactly what this package
  // exists to avoid. If a particular anchor does expose a proprietary refund
  // API, that integration belongs in its own AnchorAdapter implementation, not
  // here. The generic adapter fails closed instead and never touches the
  // network. Learning that a refund *happened* is `getTransaction`'s job (the
  // anchor flips the transaction's status once it refunds).
  //
  // Since #72, `requestRefund` is part of the `AnchorAdapter` port. The
  // generic `Sep31Adapter` fails closed with `REFUND_UNSUPPORTED` — standard
  // SEP-31 anchors have no sender-initiated refund endpoint. The engine does
  // not call it yet, and the state machine defines `refund_pending` but no
  // transition enters it. The method occupies the name so bespoke adapters
  // (OTC desks, proprietary anchors) can implement anchor-driven refunds.
  async requestRefund(
    transactionId: string,
    _amount?: Money,
    _reason?: string,
  ): Promise<Outcome<RefundRef>> {
    return fail(
      "REFUND_UNSUPPORTED",
      `${this.name}: SEP-31 has no sender-initiated refund endpoint — a refund is ` +
        `initiated by the receiving anchor and only reported back on transaction ` +
        `${transactionId}; resolve out-of-band with the anchor (see the held/refunded ` +
        `runbook in docs/operations.md) and watch getTransaction() for the outcome`,
      { retryable: false },
    );
  }

  /**
   * Re-read the receiving anchor's SEP-31 /info directly.
   *
   * Authenticated via SEP-10 if configured. Kept OFF the generic AnchorAdapter
   * port because /info is SEP-31 specific.
   */
  async getInfo(): Promise<Outcome<Sep31Info>> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: no SEP-31 transfer server configured`);
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${sep31}/info`, {
        method: "GET",
        headers: this.authHeader(auth.value),
      });
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-info HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as {
        receive?: Record<string, unknown>;
      };
      if (!j || typeof j !== "object" || !j.receive || typeof j.receive !== "object") {
        return ok<Sep31Info>({ receive: {} });
      }
      const receive: Record<string, Sep31AssetInfo> = {};
      for (const [assetCode, rawAsset] of Object.entries(j.receive)) {
        if (!rawAsset || typeof rawAsset !== "object") continue;
        const a = rawAsset as Record<string, unknown>;
        const assetInfo: Sep31AssetInfo = {
          enabled: typeof a.enabled === "boolean" ? a.enabled : undefined,
          minAmount: amountString(a.min_amount),
          maxAmount: amountString(a.max_amount),
          feeFixed: amountString(a.fee_fixed),
          feePercent: amountString(a.fee_percent),
          senderSep12Type:
            typeof a.sender_sep12_type === "string" ? a.sender_sep12_type : undefined,
          receiverSep12Type:
            typeof a.receiver_sep12_type === "string" ? a.receiver_sep12_type : undefined,
          fields:
            a.fields && typeof a.fields === "object"
              ? (a.fields as Record<string, unknown>)
              : undefined,
        };
        receive[assetCode] = assetInfo;
      }
      return ok<Sep31Info>({ receive });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-info request failed`, {
        retryable: true,
        cause,
      });
    }
  }
}

export interface Sep31AssetInfo {
  readonly enabled?: boolean;
  readonly minAmount?: string;
  readonly maxAmount?: string;
  readonly feeFixed?: string;
  readonly feePercent?: string;
  readonly senderSep12Type?: string;
  readonly receiverSep12Type?: string;
  readonly fields?: Record<string, unknown>;
}

export interface Sep31Info {
  readonly receive: Record<string, Sep31AssetInfo>;
}

export interface Sep31InfoCheckResult extends CheckResult {
  readonly info?: Sep31Info;
}

/**
 * Gate check that verifies the receiving anchor's live SEP-31 /info still lists
 * and enables the corridor's bridge asset immediately before settlement.
 */
export function sep31InfoCheck(adapter: Sep31Adapter, infoSource?: InfoSource): GateCheck {
  return {
    name: "sep31.info.asset",
    async run(ctx: GateContext): Promise<Sep31InfoCheckResult> {
      const start = Date.now();
      const bridgeAsset = ctx.corridor.settlement.bridge_asset;
      const infoOutcome = await (infoSource ? infoSource(ctx) : adapter.getInfo());

      if (!infoOutcome.ok) {
        return {
          name: "sep31.info.asset",
          passed: false,
          code: "PRESETTLE_ANCHOR_DRIFT",
          detail: `SEP-31 /info check failed: ${infoOutcome.error.message}`,
          durationMs: Date.now() - start,
        };
      }

      const info = infoOutcome.value;
      const receiveKeys = Object.keys(info.receive);
      if (receiveKeys.length === 0) {
        return {
          name: "sep31.info.asset",
          passed: false,
          code: "PRESETTLE_ANCHOR_DRIFT",
          detail: "SEP-31 /info receive list is empty",
          durationMs: Date.now() - start,
          info,
        };
      }

      const assetInfo = info.receive[bridgeAsset];
      if (!assetInfo) {
        return {
          name: "sep31.info.asset",
          passed: false,
          code: "PRESETTLE_ANCHOR_DRIFT",
          detail: `SEP-31 /info does not list bridge asset "${bridgeAsset}" (lists: ${receiveKeys.join(", ")})`,
          durationMs: Date.now() - start,
          info,
        };
      }

      if (assetInfo.enabled === false) {
        return {
          name: "sep31.info.asset",
          passed: false,
          code: "PRESETTLE_ANCHOR_DRIFT",
          detail: `SEP-31 /info lists bridge asset "${bridgeAsset}" as disabled (enabled: false)`,
          durationMs: Date.now() - start,
          info,
        };
      }

      return {
        name: "sep31.info.asset",
        passed: true,
        detail: `SEP-31 /info lists active bridge asset "${bridgeAsset}" (enabled: ${assetInfo.enabled ?? true})`,
        durationMs: Date.now() - start,
        info,
      };
    },
  };
}

import { amountRangeCheck, sharedInfoSource, type InfoSource } from "./amountRangeCheck";
export {
  amountRangeCheck,
  sharedInfoSource,
  type InfoSource,
  type InfoAdapterLike,
} from "./amountRangeCheck";

/**
 * The standard SEP-31 gate checks (/info asset listing and amount range),
 * sharing a single /info fetch per gate run. Pass to `defaultSep31Gate({ checks })`.
 */
export function sep31GateChecks(adapter: Sep31Adapter): GateCheck[] {
  const info = sharedInfoSource(adapter);
  return [sep31InfoCheck(adapter, info), amountRangeCheck(adapter, info)];
}
export {
  openedTxCheck,
  type OpenedTxCheckOptions,
  type ReportedTransactionFields,
} from "./openedTxCheck";
export interface ReceiverKycAdapterLike {
  ensureCompliance(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<KycResult>>;
  readonly name?: string;
}

/**
 * Pre-settle gate check: re-read receiver SEP-12 status right before settle
 * and require ACCEPTED.
 *
 * `comply()` runs once before `open`, but between comply and settle the anchor
 * can move the receiver to NEEDS_INFO or REJECTED — especially on retry paths
 * with backoff sleeps.
 *
 * For corridors with no `kyc_server` the adapter returns accepted; record
 * `detail: "no SEP-12 server"` so the audit trail shows it was not really checked.
 * Anything other than accepted returns `PRESETTLE_RECEIVER_NOT_ACCEPTED`.
 */
export function receiverKycCheck(adapter: ReceiverKycAdapterLike): GateCheck {
  return {
    name: "sep12.receiver",
    async run(ctx: GateContext): Promise<CheckResult> {
      const start = Date.now();
      try {
        const outcome = await adapter.ensureCompliance(ctx.intent, ctx.corridor);
        if (!outcome.ok) {
          return {
            name: "sep12.receiver",
            passed: false,
            code: "PRESETTLE_RECEIVER_NOT_ACCEPTED",
            detail: outcome.error.message,
            durationMs: Date.now() - start,
          };
        }

        if (outcome.value.status === "accepted") {
          const endpoints = ctx.corridor.dest.endpoints;
          const hasKycServer = Boolean("kyc_server" in endpoints && endpoints.kyc_server);
          return {
            name: "sep12.receiver",
            passed: true,
            detail: hasKycServer ? "receiver SEP-12 status is accepted" : "no SEP-12 server",
            durationMs: Date.now() - start,
          };
        }

        return {
          name: "sep12.receiver",
          passed: false,
          code: "PRESETTLE_RECEIVER_NOT_ACCEPTED",
          detail: `receiver SEP-12 status is ${outcome.value.status}`,
          durationMs: Date.now() - start,
        };
      } catch (err: unknown) {
        return {
          name: "sep12.receiver",
          passed: false,
          code: "PRESETTLE_RECEIVER_NOT_ACCEPTED",
          detail: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        };
      }
    },
  };
}
