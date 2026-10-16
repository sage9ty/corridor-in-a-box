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
  | "CORRIDOR_HALTED";

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

/** Opaque reference to a party. Real PII lives behind the anchor's SEP-12, never here. */
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
   * requires this to be set; the engine fails closed without it.
   */
  readonly sep12Id?: string;
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

// --- Decimal-safe money math ---------------------------------------------
export * from "./money";
