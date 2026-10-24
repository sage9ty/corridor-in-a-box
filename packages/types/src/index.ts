// @corridor/types — shared domain types + the result type the whole engine speaks.
//
// Everything returns Outcome instead of throwing. Failures are values you must
// handle, not exceptions that unwind the stack and lose the in-flight payment's
// state.

import { timingSafeEqual } from "node:crypto";

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Outcome<T, E = CorridorError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(o: Outcome<T, E>): o is Ok<T> => o.ok;
export const isErr = <T, E>(o: Outcome<T, E>): o is Err<E> => !o.ok;

export type CorridorErrorCode =
  | "MANIFEST_INVALID"
  | "MANIFEST_CHANGED"
  | "CAPABILITY_MISMATCH"
  | "AMOUNT_INVALID"
  | "ENGINE_MISCONFIGURED"
  | "PRESETTLE_ANCHOR_DRIFT"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_EXPIRED"
  | "KYC_REQUIRED"
  | "KYC_REJECTED"
  | "ANCHOR_UNAVAILABLE"
  | "SETTLEMENT_FAILED"
  | "SETTLEMENT_TIMEOUT"
  | "REFUND_UNSUPPORTED"
  | "RECONCILE_MISMATCH"
  | "RECONCILE_STALLED"
  | "IDEMPOTENCY_CONFLICT"
  /** live /info or stellar.toml no longer matches what was verified */
  | "PRESETTLE_ANCHOR_DRIFT"
  /** the opened anchor transaction is not what we are about to pay */
  | "PRESETTLE_TX_MISMATCH"
  /** destination missing, no trustline, or not authorized */
  | "PRESETTLE_DESTINATION_UNSAFE"
  /** our balance cannot cover amount + fee + reserve */
  | "PRESETTLE_INSUFFICIENT_FUNDS"
  /** firm quote will not survive settle + confirm */
  | "PRESETTLE_QUOTE_WINDOW"
  /** outside anchor or manifest min/max */
  | "PRESETTLE_AMOUNT_OUT_OF_RANGE"
  /** SEP-12 status is no longer ACCEPTED */
  | "PRESETTLE_RECEIVER_NOT_ACCEPTED"
  /** amount above the canary cap on a non-PROVEN lane */
  | "CORRIDOR_UNPROVEN"
  /**
   * The corridor's circuit breaker is open: it halted after N consecutive
   * lane-level failures and only a deliberate human reset reopens it. Not the
   * caller's fault and not retryable - retrying the same payment would fail
   * the same way until someone looks at why the lane stopped settling.
   */
  | "CORRIDOR_HALTED"
  /**
   * Not a failure of the lane: a run started with `dryRun: true` passed every
   * pre-settle gate check and stopped there, as asked, without submitting the
   * settle payment. The run is persisted as `failed` so its key cannot later
   * be reused to move money.
   */
  | "DRY_RUN_COMPLETE"
  /**
   * The route resolver refused (threw) instead of choosing a receiving anchor,
   * e.g. an unattested anchor. Fail closed: nothing was sent, a fresh run is
   * persisted as `failed`, and the key is spent. Not retryable.
   */
  | "ROUTE_REFUSED";

/**
 * Returns true if the error code is a pre-settle gate check refusal.
 */
export function isPreSettleCode(code: string): boolean {
  return code.startsWith("PRESETTLE_");
}

export interface CorridorError {
  readonly code: CorridorErrorCode;
  readonly message: string;
  /** Whether the recover step is allowed to retry this. */
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export const fail = (
  code: CorridorErrorCode,
  message: string,
  opts: { retryable?: boolean; cause?: unknown } = {},
): Err<CorridorError> =>
  err({ code, message, retryable: opts.retryable ?? false, cause: opts.cause });

/**
 * Compare two strings without leaking equality through early-exit timing —
 * for credential comparisons (bearer tokens, API keys), where `a !== b` lets
 * an attacker learn how many leading bytes matched from response latency.
 *
 * The length check runs first: a length mismatch only leaks the length, not
 * the value, so short-circuiting there doesn't reintroduce the leak
 * `timingSafeEqual` exists to close (it throws on unequal-length buffers
 * rather than comparing them).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// --- Money ---------------------------------------------------------------
// Amounts are strings on purpose. Never represent money as a JS number;
// FX math and stroop-level precision both lose data through float64.

export interface Money {
  /** Asset identifier: "USDC", or an off-chain SEP-38 asset like "iso4217:ARS". */
  readonly asset: string;
  readonly amount: string;
}

// --- Parties & intent ----------------------------------------------------

/** Opaque reference to a party. Real PII lives behind the anchor's KYC system, never here. */
export interface PartyRef {
  /** OUR internal reference for this party. Meaningless to the anchor. */
  readonly id: string;
  readonly jurisdiction?: string;
  /**
   * Customer id issued by the RECEIVING anchor's SEP-12, obtained by registering
   * this party with that anchor (SEP-12 `PUT /customer`) before the payment.
   *
   * This is the only identifier the receiving anchor can resolve. `id` above is
   * ours and means nothing to them, and the operator's own SEP-10 account
   * identifies the OPERATOR, not the customer — checking KYC against it answers
   * a question nobody asked. A corridor whose dest exposes a `kyc_server`
   * requires a customer reference; the engine fails closed without it.
   *
   * @deprecated Use `anchorCustomerId`. Still read as an alias; when both are
   * set, `anchorCustomerId` wins (see `anchorCustomerIdOf`).
   */
  readonly sep12Id?: string;
  /**
   * The receiving anchor's own reference for this party, whatever issued it: a
   * SEP-12 customer id, a SEP-6 `customer_id`, or a bespoke anchor's onboarding
   * id. Protocol-neutral successor to `sep12Id`. An opaque id, never PII.
   */
  readonly anchorCustomerId?: string;
}

/**
 * The anchor customer reference for a party: `anchorCustomerId` when set,
 * falling back to the deprecated `sep12Id` alias. An empty string counts as
 * unset, so the caller's fail-closed check sees "no reference", not "".
 */
export function anchorCustomerIdOf(party: PartyRef): string | undefined {
  return party.anchorCustomerId || party.sep12Id || undefined;
}

export interface PaymentIntent {
  /** Caller-supplied. Two requests with the same key must never settle twice. */
  readonly idempotencyKey: string;
  readonly corridorId: string;
  readonly sender: PartyRef;
  readonly recipient: PartyRef;
  /** What the sender is putting in, in the corridor's source asset. */
  readonly sourceAmount: Money;
  /**
   * SEP-31 transaction fields the DESTINATION anchor requires in order to pay
   * out — routing number, account number, deposit type, and so on.
   *
   * The anchor decides the names: they come from `fields.transaction` in its
   * `GET /sep31/info` response, where each is marked optional or not. Send an
   * empty set to an anchor that requires them and it rejects the transaction
   * ("'fields' field cannot be empty"). The values are per-payment, which is why
   * they live on the intent rather than the manifest.
   *
   * These are payout instructions, not identity documents — customer PII still
   * goes to the anchor through SEP-12, never through here.
   */
  readonly destinationFields?: Readonly<Record<string, string>>;
}

// --- Settlement references ----------------------------------------------
export type SettlementRef =
  | {
      readonly kind: "stellar";
      readonly stellarTxHash: string;
      readonly ledger?: number;
      /** Network fee actually charged, in stroops, as Horizon's `fee_charged` reports it. */
      readonly feeCharged?: string;
      /** Stellar claimable balance id (when created via createClaimableBalance). */
      readonly claimableBalanceId?: string;
    }
  | {
      readonly kind: "adapter";
      readonly reference: string;
      readonly reportedAt: number;
    };

export function settlementId(ref: SettlementRef): string {
  if (ref.kind === "adapter") {
    return ref.reference;
  }
  return ref.stellarTxHash;
}

// --- Decimal-safe money math ---------------------------------------------
export * from "./money";
