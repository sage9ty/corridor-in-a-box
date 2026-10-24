import {
  decodeProbes,
  decodeSeps,
  probeAnchor,
  probeBit,
  sepBit,
  type ProbeName,
  type ProbeOutcome,
  type ProbeResult,
  type SepNumber,
} from "./index";

export interface SweepReportEntry {
  readonly domain: string;
  readonly timestamp: string;
  readonly seps: readonly SepNumber[];
  readonly probesRun: readonly ProbeName[];
  readonly probesPassed: readonly ProbeName[];
  readonly probesFailed: readonly ProbeName[];
  readonly receiveAssets: readonly string[];
  readonly usableSep31: boolean;
  readonly usableSep31OffRamp: "yes" | "no";
  readonly tomlHash: string;
  readonly outcomes: readonly ProbeOutcome[];
  readonly raw: {
    readonly seps: number;
    readonly probesRun: number;
    readonly probesPassed: number;
  };
}

export interface SweepReportOptions {
  readonly timestamp?: string;
}

/**
 * Check whether an anchor is a usable SEP-31 off-ramp.
 * An anchor is usable for SEP-31 off-ramp if it both advertises SEP-31 and passed the sep31_info probe.
 */
export function isUsableSep31(result: ProbeResult): boolean {
  const advertisesSep31 = (result.seps & sepBit(31)) !== 0;
  const passedSep31Probe = (result.probesPassed & probeBit("sep31_info")) !== 0;
  return advertisesSep31 && passedSep31Probe;
}

/** Alias kept for callers that used the earlier name. */
export const isUsableSep31OffRamp = (result: ProbeResult): boolean => isUsableSep31(result);

/**
 * Extract received assets accepted by the anchor from the probe result.
 */
export function extractReceiveAssets(result: ProbeResult): string[] {
  const assets = result.sep31ReceiveAssets ?? result.receiveAssets;
  if (assets && assets.length > 0) {
    return [...assets];
  }
  const outcome = result.outcomes.find((o) => o.probe === "sep31_info" && o.passed);
  if (outcome?.detail.startsWith("receives ")) {
    return outcome.detail
      .slice("receives ".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Build a decoded SweepReportEntry from a raw ProbeResult.
 */
export function buildSweepReportEntry(
  result: ProbeResult,
  timestamp?: string,
): SweepReportEntry {
  const seps = decodeSeps(result.seps);
  const probesRun = decodeProbes(result.probesRun);
  const probesPassed = decodeProbes(result.probesPassed);
  const probesFailed = probesRun.filter((p) => !probesPassed.includes(p));
  const usable = isUsableSep31(result);

  return {
    domain: result.domain,
    timestamp: timestamp ?? new Date().toISOString(),
    seps,
    probesRun,
    probesPassed,
    probesFailed,
    receiveAssets: extractReceiveAssets(result),
    usableSep31: usable,
    usableSep31OffRamp: usable ? "yes" : "no",
    tomlHash: result.tomlHash,
    outcomes: result.outcomes,
    raw: {
      seps: result.seps,
      probesRun: result.probesRun,
      probesPassed: result.probesPassed,
    },
  };
}

/**
 * Build an array of SweepReportEntry objects from an array of ProbeResult objects.
 */
export function buildSweepReport(
  results: readonly ProbeResult[],
  options: SweepReportOptions = {},
): SweepReportEntry[] {
  const timestamp = options.timestamp ?? new Date().toISOString();
  return results.map((r) => buildSweepReportEntry(r, timestamp));
}

/**
 * Render the decoded report (`sweep-report.json`): SEPs and probes by name, receive
 * assets and a timestamp, with the raw bitmasks kept under `raw`. Meant for people and
 * dashboards. It is NOT what gets attested, see {@link renderSweepJson}.
 */
export function renderSweepReportJson(
  results: readonly ProbeResult[],
  options: SweepReportOptions = {},
): string {
  const report = buildSweepReport(results, options);
  return JSON.stringify(report, null, 2) + "\n";
}

export const buildSweepJson = renderSweepReportJson;

/**
 * Render the exact probe results (`sweep.json`). `pnpm attest --from sweep.json` reads
 * this file, so the attested bytes are the observed bytes: the bitmasks stay numeric
 * and nothing is re-derived from the decoded report.
 */
export function renderSweepJson(results: readonly ProbeResult[]): string {
  return JSON.stringify(results, null, 2) + "\n";
}

/**
 * Escape text for a GFM table cell. Backslashes go first: a detail containing `\|`
 * would otherwise turn our added escape into a literal backslash plus a live pipe.
 */
function escapeTableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Format failed probes and their failure details into a human-readable table cell.
 */
function formatFailedProbesDetail(result: ProbeResult): string {
  const failedOutcomes = result.outcomes.filter((o) => !o.passed);
  if (failedOutcomes.length === 0) {
    const unpassed = decodeProbes(result.probesRun).filter(
      (p) => !decodeProbes(result.probesPassed).includes(p),
    );
    return unpassed.length > 0 ? unpassed.join(", ") : "none";
  }

  return failedOutcomes.map((o) => `${o.probe}: ${escapeTableCell(o.detail)}`).join("; ");
}

/**
 * Render an array of ProbeResults into a GitHub-flavored Markdown report table (sweep.md).
 */
export function renderSweepMarkdown(
  results: readonly ProbeResult[],
  options: SweepReportOptions = {},
): string {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const lines: string[] = [
    "# Anchor Sweep Report",
    "",
    `Generated at: ${timestamp}`,
    "",
    "| Domain | Advertised SEPs | Passed Probes | Failed Probes (Detail) | Usable SEP-31 off-ramp |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const r of results) {
    const advertisedSeps = decodeSeps(r.seps);
    const advertisedStr = advertisedSeps.map((n) => `SEP-${n}`).join(", ") || "none";
    const passedProbes = decodeProbes(r.probesPassed);
    const passedStr = passedProbes.join(", ") || "none";
    const failedDetailStr = formatFailedProbesDetail(r);
    const usableStr = isUsableSep31(r) ? "yes" : "no";

    lines.push(
      `| ${r.domain} | ${advertisedStr} | ${passedStr} | ${failedDetailStr} | ${usableStr} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

export const buildSweepMarkdown = renderSweepMarkdown;

export interface ParsedSweepArgs {
  readonly domains: readonly string[];
  readonly outDir?: string;
  readonly concurrency?: number;
}

/**
 * Parse CLI arguments for sweep:anchors.
 */
export function parseSweepArgs(args: readonly string[]): ParsedSweepArgs {
  const domains: string[] = [];
  let outDir: string | undefined;
  let concurrency: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      outDir = args[++i];
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else if (arg === "--concurrency") {
      const c = parseInt(args[++i], 10);
      if (!Number.isNaN(c)) concurrency = c;
    } else if (arg.startsWith("--concurrency=")) {
      const c = parseInt(arg.slice("--concurrency=".length), 10);
      if (!Number.isNaN(c)) concurrency = c;
    } else if (!arg.startsWith("-")) {
      domains.push(arg);
    }
  }

  return { domains, outDir, concurrency };
}

export interface SweepOptions {
  readonly concurrency?: number;
  readonly probeFn?: (domain: string) => Promise<ProbeResult>;
  readonly onProgress?: (result: ProbeResult, index: number, total: number) => void;
}

const ZERO_HASH = "0".repeat(64);

/**
 * Sweep multiple anchors with bounded concurrency.
 * Anchors that fail will not throw; their failure is recorded and returned as a ProbeResult.
 */
export async function sweepAnchors(
  domains: readonly string[],
  options: SweepOptions = {},
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const probeFn = options.probeFn ?? probeAnchor;
  const results: ProbeResult[] = new Array(domains.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < domains.length) {
      const idx = nextIndex++;
      const domain = domains[idx];
      let res: ProbeResult;
      try {
        res = await probeFn(domain);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        res = {
          domain,
          seps: 0,
          probesRun: probeBit("toml_fetch"),
          probesPassed: 0,
          tomlHash: ZERO_HASH,
          outcomes: [{ probe: "toml_fetch", passed: false, detail }],
        };
      }
      results[idx] = res;
      options.onProgress?.(res, idx, domains.length);
    }
  }

  const workerCount = Math.min(concurrency, domains.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}
