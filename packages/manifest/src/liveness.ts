// Liveness — can this corridor actually move money, and do we KNOW that?
//
// The distinction this file exists to enforce: a manifest naming an endpoint is
// not evidence the endpoint exists. Anyone can write
//
//     transfer_server_sep31: https://anchor.example.mx/sep31
//
// into a YAML file. Reporting that lane as "runnable" because the string is
// non-empty is how tooling ends up asserting a fictional corridor is healthy.
//
// So liveness has FOUR states, not two:
//
//   not-runnable  a required endpoint is missing outright — cannot settle
//   unverified    endpoints are present but nobody has confirmed they resolve
//   verified      endpoints were checked against the anchor's published
//                 stellar.toml (or a running instance) on a recorded date
//   proven        canary payment through this exact lane reached completed within
//                 the last max_age_days, with evidence recorded in manifest proof block
//
// Only `verified` and `proven` are green/runnable. `unverified` is the honest default for any lane
// whose endpoints have not been looked at, and it is where every corridor
// starts. Earning `verified` requires setting `endpoints_verified_at` on the
// dest anchor, which a human does only after actually checking. Earning `proven`
// requires a fresh proof block.

import type { Corridor, Proof } from "./index";

export type LivenessState = "proven" | "verified" | "unverified" | "not-runnable";

export interface Liveness {
  readonly state: LivenessState;
  /**
   * True only when `state === "verified" || state === "proven"`. Gate execution and UI affordances on
   * this — never on the mere presence of an endpoint URL.
   */
  readonly runnable: boolean;
  /** ISO date the dest endpoints were last confirmed, when known. */
  readonly verifiedAt?: string;
  readonly proof?: Proof;
  readonly warnings: readonly string[];
}

/** Human-readable label for each state. Shared so the CLI and the web app can
 *  never drift into describing the same corridor differently. */
export const LIVENESS_LABEL: Record<LivenessState, string> = {
  proven: "proven",
  verified: "verified",
  unverified: "unverified",
  "not-runnable": "not runnable",
};

export function liveness(c: Corridor, now: Date = new Date()): Liveness {
  const warnings: string[] = [];
  const endpoints = c.dest.endpoints;
  const verifiedAt = endpoints.endpoints_verified_at;
  const sep31Server =
    "transfer_server_sep31" in endpoints ? endpoints.transfer_server_sep31 : undefined;
  const quoteServer = "quote_server" in endpoints ? endpoints.quote_server : undefined;
  const kycServer = "kyc_server" in endpoints ? endpoints.kyc_server : undefined;
  const proof = c.proof;

  if (!sep31Server) {
    warnings.push(
      "dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.",
    );
  } else if (!verifiedAt) {
    warnings.push(
      "dest endpoints are UNVERIFIED — the URLs below have never been confirmed against " +
        "a published stellar.toml. Do not treat this lane as runnable. Set " +
        "dest.endpoints.endpoints_verified_at once you have checked them.",
    );
  }

  if (c.fx.quote_source === "sep38" && !quoteServer) {
    warnings.push(
      "fx.quote_source=sep38 but dest exposes no SEP-38 quote server — quotes will fail.",
    );
  }
  if (!kycServer) {
    warnings.push(
      "dest has no SEP-12 KYC server — assuming 1:1 delivery with no per-customer KYC.",
    );
  }

  const rc = c.recovery.reconcile;
  if (
    rc.poll_seconds !== undefined &&
    rc.stall_polls !== undefined &&
    rc.stall_polls > 0 &&
    rc.poll_seconds * rc.stall_polls >= c.recovery.timeout_seconds
  ) {
    warnings.push(
      `recovery.reconcile: poll_seconds (${rc.poll_seconds}) x stall_polls (${rc.stall_polls}) ` +
        `is not below timeout_seconds (${c.recovery.timeout_seconds}) — the stall check can never fire.`,
    );
  }
  if (c.recovery.timeout_seconds <= rc.external_stall_seconds) {
    warnings.push(
      `recovery.timeout_seconds (${c.recovery.timeout_seconds}s) does not exceed ` +
        `recovery.reconcile.external_stall_seconds (${rc.external_stall_seconds}s); the corridor ` +
        `timeout will end pending_external/pending_receiver waits first. Raise timeout_seconds ` +
        `for corridors that need the full external stall budget.`,
    );
  }

  let state: LivenessState = !sep31Server
    ? "not-runnable"
    : verifiedAt
      ? "verified"
      : "unverified";

  if (state === "verified" && proof) {
    const completedAt = new Date(proof.canary_completed_at).getTime();
    const maxAgeDays = proof.max_age_days ?? 30;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const ageMs = now.getTime() - completedAt;

    if (Number.isNaN(completedAt)) {
      // Unreachable for a parsed manifest (the schema rejects it); guards hand-built objects.
      warnings.push(
        `proof.canary_completed_at (${proof.canary_completed_at}) is not a real date — ignoring the proof.`,
      );
    } else if (ageMs < 0) {
      warnings.push(
        `proof.canary_completed_at (${proof.canary_completed_at}) is in the future — ignoring the proof.`,
      );
    } else if (ageMs > maxAgeMs) {
      warnings.push(
        `proof is stale — canary payment completed at ${proof.canary_completed_at} is older than ${maxAgeDays} days.`,
      );
    } else {
      state = "proven";
    }
  }

  return {
    state,
    runnable: state === "verified" || state === "proven",
    verifiedAt,
    proof,
    warnings,
  };
}
