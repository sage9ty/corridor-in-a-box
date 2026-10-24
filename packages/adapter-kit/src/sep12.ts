// SEP-12 receiver status check, shared by every adapter whose dest runs a
// SEP-12 KYC server (SEP-31, SEP-6), so the read and its fail-closed rules
// cannot drift apart between protocols (#193).
//
// Status read ONLY. Registration (SEP-12 `PUT /customer`) is the sending side's
// job and stays off the engine's path: the engine only ever holds an opaque
// customer reference, so no PII flows through it.

import { fail, ok, type Outcome } from "@corridor/types";
import type { KycResult } from "./index";

export interface Sep12ComplianceCheckOptions {
  /** SEP-12 KYC_SERVER base URL. */
  readonly kycServer: string;
  /** Prefix for error messages — the adapter's name. */
  readonly name: string;
  /** Inject a fetch implementation (defaults to global fetch). */
  readonly fetchImpl?: typeof fetch;
  /**
   * SEP-10 token supplier. `ok(undefined)` means no auth is configured and
   * anonymous access is intended; a failure is returned as-is, so a broken
   * handshake can never degrade into an anonymous compliance answer.
   */
  readonly authToken: () => Promise<Outcome<string | undefined>>;
}

export class Sep12ComplianceCheck {
  constructor(private readonly opts: Sep12ComplianceCheckOptions) {}

  /**
   * `GET /customer?id=&type=` for the RECIPIENT. ACCEPTED / REJECTED map
   * through; PROCESSING, NEEDS_INFO, or anything unknown is "pending" so the
   * engine fails closed rather than settling early.
   *
   * FAILS CLOSED without a customer reference: there is nothing else to ask
   * about. The operator's own SEP-10 account identifies the OPERATOR, and
   * reading its status would report a pass without evaluating the customer.
   */
  async check(customerId: string | undefined, type: string): Promise<Outcome<KycResult>> {
    const { name, kycServer } = this.opts;
    if (!customerId) {
      return fail(
        "KYC_REQUIRED",
        `${name}: recipient has no SEP-12 customer id — register the receiver ` +
          `with this anchor (SEP-12 PUT /customer) and set recipient.anchorCustomerId ` +
          `(or the deprecated recipient.sep12Id) before settling. Refusing to settle ` +
          `on an unverified recipient.`,
      );
    }
    const auth = await this.opts.authToken();
    if (!auth.ok) return auth;
    try {
      const url = new URL(`${kycServer}/customer`);
      url.searchParams.set("id", customerId);
      url.searchParams.set("type", type);
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(url.toString(), {
        headers: auth.value ? { authorization: `Bearer ${auth.value}` } : {},
      });
      if (!res.ok) {
        return fail("KYC_REQUIRED", `${name}: SEP-12 customer HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as { id?: unknown; status?: unknown } | null;
      const id = typeof j?.id === "string" && j.id ? j.id : undefined;
      const status = (typeof j?.status === "string" ? j.status : "").toUpperCase();
      if (status === "ACCEPTED") return ok<KycResult>({ status: "accepted", customerId: id });
      if (status === "REJECTED") return ok<KycResult>({ status: "rejected", customerId: id });
      // PROCESSING, NEEDS_INFO, or anything unknown → not yet cleared.
      return ok<KycResult>({ status: "pending", customerId: id });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${name}: SEP-12 request failed`, {
        retryable: true,
        cause,
      });
    }
  }
}
