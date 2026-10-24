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
  anchorCustomerIdOf,
  fail,
  isValidAmount,
  ok,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import {
  type AdapterCapabilities,
  type AnchorAdapter,
  type DepositInstructions,
  type KycResult,
  type OpenTransaction,
  type Quote,
  type RefundRef,
  Sep12ComplianceCheck,
  Sep38QuoteProvider,
  type TransactionStatus,
  parseRefunds,
} from "@corridor/adapter-kit";
import { Sep10Client, type Sep10Signer } from "@corridor/adapter-kit";
import type { CheckResult, GateCheck, GateContext } from "@corridor/engine";

type FetchLike = typeof fetch;

export type { RefundInfo, RefundPayment } from "@corridor/adapter-kit";
export type { Sep10Signer } from "@corridor/adapter-kit";

/**
 * Signs a SEP-10 challenge. The concrete implementation (Keypair + Transaction
 * from @stellar/stellar-sdk) is supplied by the caller, keeping this package
 * free of a chain SDK. See @corridor/stellar for a ready-made signer.
 */
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

export { parseRefunds };

function amountString(v: unknown): string | undefined {
  return typeof v === "string" && isValidAmount(v.trim()) ? v.trim() : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function parseMemoType(v: unknown): "text" | "hash" | "id" | undefined {
  const memoType = typeof v === "string" ? v.toLowerCase() : undefined;
  return memoType === "hash" || memoType === "id" || memoType === "text"
    ? memoType
    : undefined;
}

export { sep38SellAsset } from "@corridor/adapter-kit";

export class Sep31Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: Sep31Anchor;
  /** Bridge asset for this corridor — the denomination `amount_in` is reported in. */
  private readonly settlementAsset: string;
  private readonly fetchImpl: FetchLike;
  private readonly sep10: Sep10Client;
  private readonly sep10Signer?: Sep10Signer;
  private readonly sep38Provider: Sep38QuoteProvider;
  /** SEP-12 status read; absent when the dest exposes no `kyc_server`. */
  private readonly sep12?: Sep12ComplianceCheck;

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
    this.sep10Signer = opts.sep10;
    this.sep10 = new Sep10Client(
      this.anchor.endpoints.web_auth,
      this.anchor.endpoints.home_domain,
      opts.sep10,
      this.fetchImpl,
    );
    this.sep38Provider = new Sep38QuoteProvider({
      context: "sep31",
      fetchImpl: this.fetchImpl,
      name: this.name,
      authToken: () => this.authToken(),
      quoteServer: () => this.anchor.endpoints.quote_server,
    });
    const kycServer = this.anchor.endpoints.kyc_server;
    if (kycServer) {
      this.sep12 = new Sep12ComplianceCheck({
        kycServer,
        name: this.name,
        fetchImpl: this.fetchImpl,
        authToken: () => this.authToken(),
      });
    }
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
    const auth = await this.sep10.token();
    if (!auth.ok) {
      return fail(auth.error.code, `${this.name}: ${auth.error.message}`, {
        retryable: auth.error.retryable,
        cause: auth.error.cause,
      });
    }
    return auth;
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
    return this.sep38Provider.quote(intent, corridor);
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
   * ever sees an opaque customer id.
   *
   * Call this from your deployment layer before `execute()`, and put the
   * returned id on `intent.recipient.anchorCustomerId`.
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
          ...((opts.account ?? this.sep10Signer?.account)
            ? { account: opts.account ?? this.sep10Signer?.account }
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
    if (!this.sep12) {
      // Some corridors deliver 1:1 with no per-customer KYC at the receiver.
      return ok<KycResult>({ status: "accepted" });
    }
    // SEP-12: check the receiving anchor's view of THE RECIPIENT's status. The
    // sending anchor collects/verifies PII and registers the customer with the
    // receiving anchor (SEP-12 PUT /customer), which returns the customer id we
    // carry as `recipient.anchorCustomerId` (or the deprecated `sep12Id`). Here
    // we only read status — no PII flows through the engine. NEEDS_INFO /
    // PROCESSING surface as "pending" so the engine fails closed rather than
    // settling early.
    //
    // This used to query `this.sep10?.account` — the OPERATOR's own signing
    // account — whenever a signer was configured, which is every production
    // wiring. It therefore answered "is the operator in good standing?" and
    // recorded the result as the recipient's KYC verdict: a compliance control
    // that reported a pass without ever evaluating the customer. The shared
    // check fails closed instead when we have no id for the recipient.
    return this.sep12.check(
      anchorCustomerIdOf(intent.recipient),
      corridor.compliance.sep12_receiver_type,
    );
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
    const receiverId = anchorCustomerIdOf(intent.recipient);
    if (!receiverId) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: cannot open a SEP-31 transaction without recipient.anchorCustomerId ` +
          `(or the deprecated recipient.sep12Id)`,
      );
    }
    const senderId = anchorCustomerIdOf(intent.sender);
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
          receiver_id: receiverId,
          ...(senderId ? { sender_id: senderId } : {}),
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
      const memoType = parseMemoType(j.stellar_memo_type);
      const instructions: DepositInstructions = {
        kind: "stellar_payment",
        to: j.stellar_account_id,
        memo: j.stellar_memo,
        memoType,
      };
      return ok<OpenTransaction>({
        transactionId: j.id,
        instructions,
        amountIn: {
          asset: corridor.settlement.bridge_asset,
          amount: quote.sourceAmount.amount,
        },
        depositAddress: j.stellar_account_id,
        memo: j.stellar_memo,
        memoType,
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
