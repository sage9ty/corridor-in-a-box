// corridor lint — compare a manifest's pinned dest endpoints against the live
// stellar.toml published at `https://<dest.endpoints.home_domain>/.well-known/stellar.toml`.
//
// `AnchorEndpointsSchema` checks URL shape, not whether the anchor actually
// publishes those URLs. `lintCorridor` closes that gap:
//   - mismatch: manifest sets an endpoint whose toml key is absent
//   - mismatch: manifest and toml values differ (after stripping trailing `/`)
//   - warning:  toml publishes an endpoint that the manifest omits
//
// Localhost (`reference.corridor.yaml`) and RFC 2606 `.invalid` / `.example`
// placeholder domains are skipped with an explicit "skipped: placeholder domain"
// message so linting a directory of corridors never fails on templates.

import type { Corridor } from "@corridor/manifest";
import { isSafeUrl, TOML_ENDPOINTS, tomlValue } from "@corridor/probe";

export type LintFindingKind = "missing_in_toml" | "value_mismatch" | "omitted_in_manifest";
export type LintSeverity = "error" | "warning";

export interface LintFinding {
  readonly severity: LintSeverity;
  readonly kind: LintFindingKind;
  readonly field: string;
  readonly tomlKey: string;
  readonly manifestValue?: string;
  readonly tomlValue?: string;
  readonly message: string;
}

export interface LintResult {
  readonly corridorId: string;
  readonly homeDomain: string;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly ok: boolean;
  readonly findings: readonly LintFinding[];
}

export interface LintOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface EndpointMapping {
  readonly field: string;
  readonly tomlKey: string;
}

const SEP_TO_TOML_KEY = new Map<number, string>(
  TOML_ENDPOINTS.map(({ sep, key }) => [sep, key]),
);

const SEP31_MAPPINGS: readonly EndpointMapping[] = [
  { field: "transfer_server_sep31", tomlKey: SEP_TO_TOML_KEY.get(31)! },
  { field: "web_auth", tomlKey: SEP_TO_TOML_KEY.get(10)! },
  { field: "kyc_server", tomlKey: SEP_TO_TOML_KEY.get(12)! },
  { field: "quote_server", tomlKey: SEP_TO_TOML_KEY.get(38)! },
];

const SEP6_MAPPINGS: readonly EndpointMapping[] = [
  { field: "transfer_server", tomlKey: SEP_TO_TOML_KEY.get(6)! },
  { field: "web_auth", tomlKey: SEP_TO_TOML_KEY.get(10)! },
  { field: "kyc_server", tomlKey: SEP_TO_TOML_KEY.get(12)! },
  { field: "quote_server", tomlKey: SEP_TO_TOML_KEY.get(38)! },
];

function normalizeEndpointUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * True when `homeDomain` is a local dev address (`localhost`, `localhost:8080`,
 * `127.0.0.1`) or an RFC 2606 / example placeholder (`*.invalid`, `*.example`,
 * `*.example.mx`, `example.*`).
 */
export function isPlaceholderDomain(homeDomain: string): boolean {
  const host = homeDomain.trim().toLowerCase().replace(/:\d+$/, "");
  if (!host) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    return true;
  }
  const labels = host.split(".");
  if (
    labels.includes("invalid") ||
    labels.includes("example") ||
    labels.includes("localhost")
  ) {
    return true;
  }
  return false;
}

function mappingsForDest(corridor: Corridor): readonly EndpointMapping[] {
  if (corridor.dest.protocol === "sep6") return SEP6_MAPPINGS;
  return SEP31_MAPPINGS;
}

/** Pure comparison between a parsed corridor manifest and raw `stellar.toml` text. */
export function compareManifestToToml(corridor: Corridor, toml: string): LintResult {
  const homeDomain = corridor.dest.endpoints.home_domain;
  const endpoints = corridor.dest.endpoints as Record<string, string | undefined>;
  const mappings = mappingsForDest(corridor);
  const findings: LintFinding[] = [];

  for (const { field, tomlKey } of mappings) {
    const manifestVal = endpoints[field];
    const tomlVal = tomlValue(toml, tomlKey);

    if (manifestVal !== undefined) {
      if (tomlVal === undefined) {
        findings.push({
          severity: "error",
          kind: "missing_in_toml",
          field,
          tomlKey,
          manifestValue: manifestVal,
          message: `dest.endpoints.${field} is "${manifestVal}", but ${tomlKey} is absent in stellar.toml`,
        });
      } else if (normalizeEndpointUrl(manifestVal) !== normalizeEndpointUrl(tomlVal)) {
        findings.push({
          severity: "error",
          kind: "value_mismatch",
          field,
          tomlKey,
          manifestValue: manifestVal,
          tomlValue: tomlVal,
          message: `dest.endpoints.${field} ("${manifestVal}") does not match ${tomlKey} ("${tomlVal}")`,
        });
      }
    } else if (tomlVal !== undefined) {
      findings.push({
        severity: "warning",
        kind: "omitted_in_manifest",
        field,
        tomlKey,
        tomlValue: tomlVal,
        message: `stellar.toml publishes ${tomlKey} ("${tomlVal}"), which is omitted in dest.endpoints.${field}`,
      });
    }
  }

  const hasError = findings.some((f) => f.severity === "error");
  return {
    corridorId: corridor.id,
    homeDomain,
    skipped: false,
    ok: !hasError,
    findings,
  };
}

/**
 * Fetch `https://<dest.endpoints.home_domain>/.well-known/stellar.toml` and
 * compare its published endpoints against `corridor.dest.endpoints`.
 */
export async function lintCorridor(
  corridor: Corridor,
  opts: LintOptions = {},
): Promise<LintResult> {
  const homeDomain = corridor.dest.endpoints.home_domain;
  if (isPlaceholderDomain(homeDomain)) {
    return {
      corridorId: corridor.id,
      homeDomain,
      skipped: true,
      skipReason: `skipped: placeholder domain (${homeDomain})`,
      ok: true,
      findings: [],
    };
  }

  const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
  if (!isSafeUrl(tomlUrl)) {
    throw new Error(`refusing to fetch unsafe url: ${tomlUrl}`);
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const res = await doFetch(tomlUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`failed to fetch ${tomlUrl}: HTTP ${res.status}`);
  }
  const toml = await res.text();
  return compareManifestToToml(corridor, toml);
}

export function formatLintResult(result: LintResult): string {
  if (result.skipped) {
    return `${result.corridorId} (${result.homeDomain}): ${result.skipReason ?? "skipped: placeholder domain"}`;
  }
  const lines: string[] = [];
  const errors = result.findings.filter((f) => f.severity === "error");
  const warnings = result.findings.filter((f) => f.severity === "warning");

  if (errors.length === 0) {
    lines.push(
      `✓ ${result.corridorId} (${result.homeDomain}): all manifest endpoints match published stellar.toml`,
    );
  } else {
    lines.push(
      `✗ ${result.corridorId} (${result.homeDomain}): ${errors.length} endpoint mismatch(es) against published stellar.toml`,
    );
  }

  for (const f of errors) {
    lines.push(`  ✗ ${f.message}`);
  }
  for (const f of warnings) {
    lines.push(`  ! warning: ${f.message}`);
  }
  return lines.join("\n");
}
