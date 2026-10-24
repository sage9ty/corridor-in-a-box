import { stringify as stringifyYaml } from "yaml";
import { tomlValue, sepBit, probeBit, type ProbeResult } from "@corridor/probe";

export interface ManifestFromProbeOptions {
  /** Source asset name/code. Default "USDC". */
  readonly sourceAsset?: string;
  /** Network: "public" | "testnet". Default "public". */
  readonly network?: "public" | "testnet";
  /** Allow scaffolding when SEP-31 is not advertised. */
  readonly allowNotRunnable?: boolean;
  /** Override today's date (YYYY-MM-DD) for deterministic testing. */
  readonly today?: string;
  /** Explicit receive assets list, overriding parsing from sep31_info outcome detail. */
  readonly receiveAssets?: readonly string[];
  /** Explicit dest asset, overriding heuristic. */
  readonly destAsset?: string;
}

export function manifestFromProbe(
  result: ProbeResult,
  toml: string,
  opts: ManifestFromProbeOptions = {},
): string {
  const sep31Advertised =
    (result.seps & sepBit(31)) !== 0 || tomlValue(toml, "DIRECT_PAYMENT_SERVER") !== undefined;
  if (!sep31Advertised && !opts.allowNotRunnable) {
    throw new Error(
      `anchor "${result.domain}" does not advertise SEP-31 (DIRECT_PAYMENT_SERVER). Consider SEP-6 or SEP-24 support, or re-run with --allow-not-runnable.`,
    );
  }

  const transfer_server_sep31 = tomlValue(toml, "DIRECT_PAYMENT_SERVER");
  const web_auth = tomlValue(toml, "WEB_AUTH_ENDPOINT");
  const kyc_server = tomlValue(toml, "KYC_SERVER");
  const quote_server = tomlValue(toml, "ANCHOR_QUOTE_SERVER");

  const tomlFetchPassed = (result.probesPassed & probeBit("toml_fetch")) !== 0;
  const sep31Passed = (result.probesPassed & probeBit("sep31_info")) !== 0;
  const sep38Passed = (result.probesPassed & probeBit("sep38_quote")) !== 0;

  const verified = tomlFetchPassed && sep31Passed;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  let status_note: string | undefined;
  let endpoints_verified_at: string | undefined;

  if (verified) {
    endpoints_verified_at = today;
  } else {
    const failedProbes: string[] = [];
    for (const outcome of result.outcomes) {
      if (!outcome.passed) {
        failedProbes.push(outcome.probe);
      }
    }
    if (failedProbes.length === 0) {
      if (!tomlFetchPassed) failedProbes.push("toml_fetch");
      if (!sep31Passed) failedProbes.push("sep31_info");
    }
    status_note = `Unverified endpoints: failed probes: ${failedProbes.join(", ")}`;
  }

  // Determine receive assets
  let receiveAssets: readonly string[] | undefined =
    opts.receiveAssets ?? result.sep31ReceiveAssets ?? result.receiveAssets;
  if (!receiveAssets) {
    const sep31Outcome = result.outcomes.find((o) => o.probe === "sep31_info");
    if (sep31Outcome && sep31Outcome.detail.startsWith("receives ")) {
      receiveAssets = sep31Outcome.detail
        .replace(/^receives\s+/i, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      receiveAssets = [];
    }
  }

  let destAsset = opts.destAsset;
  if (!destAsset) {
    const iso = receiveAssets.find((a) => /^iso4217:/i.test(a));
    if (iso) {
      destAsset = iso;
    } else {
      destAsset = "TODO: specify destination asset (e.g. iso4217:EUR)";
    }
  }

  const sourceAsset = opts.sourceAsset ?? "USDC";
  const network = opts.network ?? "public";
  const quote_source = sep38Passed ? "sep38" : "external";

  let destCurrencyCode = "DEST";
  if (destAsset.startsWith("iso4217:")) {
    destCurrencyCode = destAsset.slice("iso4217:".length).toUpperCase();
  }

  const sourceCurrencyCode = sourceAsset === "USDC" ? "USD" : sourceAsset;
  const path = [sourceCurrencyCode, sourceAsset, destCurrencyCode];

  const asset_issuer =
    network === "testnet"
      ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
      : "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  const destJurisdiction =
    destCurrencyCode !== "DEST" ? destCurrencyCode.slice(0, 2).toUpperCase() : "US";

  const cleanId = result.domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const manifestObj: Record<string, unknown> = {
    id: cleanId,
    ...(status_note ? { status_note } : {}),
    source: {
      name: `${sourceCurrencyCode} Sending Anchor`,
      asset: sourceAsset,
      endpoints: {
        home_domain: "sending-anchor.example",
      },
    },
    dest: {
      name: `${result.domain} Receiving Anchor`,
      asset: destAsset,
      protocol: "sep31",
      endpoints: {
        home_domain: result.domain,
        ...(transfer_server_sep31 ? { transfer_server_sep31 } : {}),
        ...(web_auth ? { web_auth } : {}),
        ...(kyc_server ? { kyc_server } : {}),
        ...(quote_server ? { quote_server } : {}),
        ...(endpoints_verified_at ? { endpoints_verified_at } : {}),
      },
    },
    fx: {
      path,
      quote_source,
      who_holds_risk: "receiving_anchor",
      quote_ttl_seconds: 60,
    },
    compliance: {
      source_jurisdiction: "US",
      dest_jurisdiction: destJurisdiction,
      travel_rule_profile: "default",
    },
    settlement: {
      bridge_asset: "USDC",
      network,
      asset_issuer,
    },
    recovery: {
      max_retries: 3,
      timeout_seconds: 900,
      rollback: "refund_sender",
    },
  };

  return stringifyYaml(manifestObj);
}
