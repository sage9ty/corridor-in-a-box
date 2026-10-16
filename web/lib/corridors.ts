// Mirrors the *.corridor.yaml manifests in ../corridors. Kept as plain data so
// the demo UI is self-contained; in a real deployment these come from the engine
// (via @corridor/service) or the manifest loader.

export interface Endpoints {
  home_domain: string;
  transfer_server_sep31?: string;
  web_auth?: string;
  kyc_server?: string;
  quote_server?: string;
  /** ISO date the URLs above were confirmed against the anchor's published
   *  stellar.toml. Unset = nobody has checked. See liveness() below. */
  endpoints_verified_at?: string;
}

export interface Corridor {
  id: string;
  status_note?: string;
  source: { name: string; asset: string; endpoints: Endpoints };
  dest: { name: string; asset: string; endpoints: Endpoints };
  fx: { path: string[]; quote_source: "sep38" | "external"; who_holds_risk: string; quote_ttl_seconds: number };
  compliance: { source_jurisdiction: string; dest_jurisdiction: string };
  settlement: { bridge_asset: string; network: "public" | "testnet"; asset_issuer: string };
  recovery: {
    max_retries: number;
    timeout_seconds: number;
    rollback: string;
    reconcile?: { external_stall_seconds?: number };
  };
  /** Recorded by `corridor canary --write` after a Horizon re-read. Optional. */
  proof?: Proof;
}

/** A canary payment that completed on this lane, as recorded in the manifest. */
export interface Proof {
  canary_completed_at: string;
  stellar_tx_hash: string;
  anchor_transaction_id: string;
  amount: string;
  max_age_days: number;
  canary_max_amount: string;
}

export const corridors: Corridor[] = [
  {
    id: "reference-testnet",
    status_note: "Anchor Platform reference server on testnet. Run it yourself, no agreements.",
    source: { name: "Local Sending Anchor", asset: "USDC", endpoints: { home_domain: "localhost:8080" } },
    dest: {
      name: "Anchor Platform Reference",
      asset: "iso4217:USD",
      endpoints: {
        home_domain: "localhost:8080",
        transfer_server_sep31: "http://localhost:8080/sep31",
        web_auth: "http://localhost:8080/auth",
        kyc_server: "http://localhost:8080/sep12",
        quote_server: "http://localhost:8080/sep38",
      },
    },
    fx: { path: ["USD", "USDC", "USD"], quote_source: "sep38", who_holds_risk: "receiving_anchor", quote_ttl_seconds: 60 },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "US" },
    settlement: { bridge_asset: "USDC", network: "testnet", asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    recovery: { max_retries: 3, timeout_seconds: 900, rollback: "refund_sender" },
  },
  {
    id: "mx-example",
    status_note:
      "TEMPLATE — endpoints are fictional placeholders. No anchor relationship exists. Not runnable.",
    source: { name: "USD Sending Anchor", asset: "USDC", endpoints: { home_domain: "sending-anchor.example" } },
    dest: {
      name: "Mexico Off-Ramp (example — not a real anchor)",
      asset: "iso4217:MXN",
      endpoints: {
        home_domain: "anchor.example.mx",
        transfer_server_sep31: "https://anchor.example.mx/sep31",
        web_auth: "https://anchor.example.mx/auth",
        kyc_server: "https://anchor.example.mx/sep12",
        quote_server: "https://anchor.example.mx/sep38",
      },
    },
    fx: { path: ["USD", "USDC", "MXN"], quote_source: "sep38", who_holds_risk: "receiving_anchor", quote_ttl_seconds: 60 },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "MX" },
    settlement: { bridge_asset: "USDC", network: "public", asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    recovery: { max_retries: 3, timeout_seconds: 900, rollback: "refund_sender" },
  },
  {
    id: "ng-cowrie",
    status_note:
      "REAL — Cowrie Exchange (Lagos, Nigeria), issuer of NGNT. Confirmed 2026-08-11 by " +
      "@corridor/probe against the anchor's live production API: SEP-10 challenge signed " +
      "and exchanged for a JWT, SEP-12 answered, and SEP-31 GET /info returned a non-empty " +
      "receive list (NGNT, USDC). No SEP-38 quote server is published, so pricing is " +
      "off-protocol (quote_source=external) — this corridor cannot get a firm on-chain " +
      "quote today. No payment has been attempted; a real settlement still needs a KYC'd " +
      "business relationship with Cowrie, which this repo does not have.",
    source: { name: "USD Sending Anchor", asset: "USDC", endpoints: { home_domain: "sending-anchor.example" } },
    dest: {
      name: "Cowrie Exchange (Nigeria)",
      asset: "iso4217:NGN",
      endpoints: {
        home_domain: "cowrie.exchange",
        transfer_server_sep31: "https://api.cowrie.exchange/sep31/direct",
        web_auth: "https://api.cowrie.exchange/web_auth",
        kyc_server: "https://api.cowrie.exchange/kyc",
        endpoints_verified_at: "2026-08-11",
      },
    },
    fx: { path: ["USD", "USDC", "NGN"], quote_source: "external", who_holds_risk: "receiving_anchor", quote_ttl_seconds: 60 },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "NG" },
    settlement: { bridge_asset: "USDC", network: "public", asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    recovery: { max_retries: 3, timeout_seconds: 900, rollback: "refund_sender" },
  },
  {
    id: "ng-cn",
    status_note: "PENDING — no compliant RMB SEP-31 off-ramp exists yet. dest endpoints unfilled.",
    source: { name: "Nigeria On-Ramp (cNGN/Cowrie-class)", asset: "USDC", endpoints: { home_domain: "example-ng-anchor.invalid" } },
    dest: {
      name: "China RMB Off-Ramp (does not exist yet)",
      asset: "iso4217:CNY",
      endpoints: { home_domain: "example-cn-anchor.invalid" },
    },
    fx: { path: ["NGN", "USDC", "CNY"], quote_source: "sep38", who_holds_risk: "sending_anchor", quote_ttl_seconds: 45 },
    compliance: { source_jurisdiction: "NG", dest_jurisdiction: "CN" },
    settlement: { bridge_asset: "USDC", network: "public", asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    recovery: { max_retries: 2, timeout_seconds: 1200, rollback: "refund_sender" },
  },
];

export function getCorridor(id: string): Corridor | undefined {
  return corridors.find((c) => c.id === id);
}

export type LivenessState = "proven" | "verified" | "unverified" | "not-runnable";

export interface Liveness {
  state: LivenessState;
  /** True for "verified" and "proven". Never gate a UI affordance on an endpoint URL existing. */
  runnable: boolean;
  verifiedAt?: string;
  warnings: string[];
}

export const LIVENESS_LABEL: Record<LivenessState, string> = {
  proven: "proven",
  verified: "verified",
  unverified: "unverified",
  "not-runnable": "not runnable",
};

// MIRROR of packages/manifest/src/liveness.ts. Keep the two in lockstep — this
// app is deliberately outside the pnpm workspace (see web/README.md) so it cannot
// import the package directly.
//
// Four states, not two. A manifest naming an endpoint is not evidence the
// endpoint exists; a lane whose URLs have never been checked is UNVERIFIED and
// must never render green. `proven` additionally needs a `proof` block — written
// by `corridor canary --write` after a Horizon re-read — that is still inside
// proof.max_age_days.
export function liveness(c: Corridor, now: Date = new Date()): Liveness {
  const warnings: string[] = [];
  const endpoints = c.dest.endpoints;
  const verifiedAt = endpoints.endpoints_verified_at;

  if (!endpoints.transfer_server_sep31) {
    warnings.push("dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.");
  } else if (!verifiedAt) {
    warnings.push(
      "dest endpoints are UNVERIFIED — the URLs have never been confirmed against a published stellar.toml. Do not treat this lane as runnable.",
    );
  }
  if (c.fx.quote_source === "sep38" && !endpoints.quote_server) {
    warnings.push("fx.quote_source=sep38 but dest exposes no SEP-38 quote server — quotes will fail.");
  }
  if (!endpoints.kyc_server) {
    warnings.push("dest has no SEP-12 KYC server — assuming 1:1 delivery with no per-customer KYC.");
  }
  const externalStallSeconds = c.recovery.reconcile?.external_stall_seconds ?? 21_600;
  if (c.recovery.timeout_seconds <= externalStallSeconds) {
    warnings.push(
      `recovery.timeout_seconds (${c.recovery.timeout_seconds}s) does not exceed ` +
        `recovery.reconcile.external_stall_seconds (${externalStallSeconds}s); the corridor ` +
        `timeout will end pending_external/pending_receiver waits first. Raise timeout_seconds ` +
        `for corridors that need the full external stall budget.`,
    );
  }

  // Mirrors the manifest package: a proof only counts while it is fresh, and a
  // stale one drops the lane back to VERIFIED rather than quietly staying green.
  const proof = c.proof;
  const proofTime = proof ? Date.parse(`${proof.canary_completed_at}T00:00:00Z`) : NaN;
  const proofAgeMs = now.getTime() - proofTime;
  const proofFresh =
    proof !== undefined &&
    Number.isFinite(proofTime) &&
    proofAgeMs >= 0 &&
    proofAgeMs <= proof.max_age_days * 86_400_000;

  if (proof && !verifiedAt) {
    warnings.push(
      "canary proof is present but dest endpoints are UNVERIFIED — a payment cannot promote an unchecked corridor to proven.",
    );
  } else if (proof && !proofFresh) {
    warnings.push(
      `canary proof is stale (completed ${proof.canary_completed_at}, max age ${proof.max_age_days} days) — corridor remains verified, not proven.`,
    );
  }

  const state: LivenessState = !endpoints.transfer_server_sep31
    ? "not-runnable"
    : !verifiedAt
      ? "unverified"
      : proofFresh
        ? "proven"
        : "verified";

  return {
    state,
    runnable: state === "verified" || state === "proven",
    verifiedAt,
    warnings,
  };
}

export const VERBS = [
  { step: 1, verb: "quote", sep: "SEP-38  POST /quote" },
  { step: 2, verb: "comply", sep: "SEP-10 auth + SEP-12 KYC handoff" },
  { step: 3, verb: "open", sep: "SEP-31  POST /transactions" },
  { step: 4, verb: "settle", sep: "native Stellar payment of bridge asset" },
  { step: 5, verb: "reconcile", sep: "SEP-31  GET /transactions/:id" },
] as const;
