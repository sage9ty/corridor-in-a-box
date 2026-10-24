// Probe every tracked anchor and emit JSON + markdown reports.
//
//   pnpm sweep:anchors --out /tmp/sweep                 (alias: pnpm probe:sweep)
//   pnpm sweep:anchors testanchor.stellar.org cowrie.exchange --out /tmp/sweep
//   pnpm sweep:anchors --out sweep.json                 (a .json path names the results file)
//   pnpm sweep:anchors                                  (print the markdown table only)
//
// Credential-free and read-only: anyone can run this without keys to answer
// "across every anchor we track, what works today?". Each domain is probed exactly
// once, with bounded concurrency (`--concurrency`, default 4).
//
// `--out <dir>` writes three files:
//   sweep.json         the exact ProbeResults. `pnpm attest --from` reads this one, so
//                      what is attested is what was observed, not a second probe.
//   sweep.md           one table row per domain, for humans and the Actions summary.
//   sweep-report.json  the decoded view: SEPs and probes by name, receive assets, timestamp.
//
// A domain that cannot be probed at all is recorded as a failed `toml_fetch`, like any
// other unreachable anchor. The script exits 1 only if the sweep itself could not run.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  loadFleet,
  parseSweepArgs,
  renderSweepJson,
  renderSweepMarkdown,
  renderSweepReportJson,
  sweepAnchors,
} from "@corridor/probe";

async function main(): Promise<void> {
  const { domains: cliDomains, outDir, concurrency } = parseSweepArgs(process.argv.slice(2));

  let domains = cliDomains;
  if (domains.length === 0) {
    try {
      domains = [...loadFleet().domains];
    } catch (e) {
      console.error("✗ failed to load contracts/anchors.json:", e);
      process.exit(1);
    }
  }

  if (domains.length === 0) {
    console.error("✗ no domains to sweep");
    process.exit(1);
  }

  console.log(
    `Sweeping ${domains.length} anchor(s) with concurrency ${concurrency ?? 4}...\n`,
  );

  const results = await sweepAnchors(domains, {
    concurrency,
    onProgress: (r, idx, total) => {
      console.log(`[${idx + 1}/${total}] ${r.domain}: probes passed=${r.probesPassed}`);
    },
  });

  const timestamp = new Date().toISOString();
  const mdReport = renderSweepMarkdown(results, { timestamp });

  if (!outDir) {
    console.log("\n" + mdReport);
    return;
  }

  // `--out foo.json` names the results file; anything else is a directory.
  const asFile = outDir.endsWith(".json");
  const dir = asFile ? dirname(outDir) : outDir;
  const jsonPath = asFile ? outDir : join(dir, "sweep.json");
  const mdPath = asFile ? outDir.replace(/\.json$/, ".md") : join(dir, "sweep.md");
  const reportPath = asFile
    ? outDir.replace(/\.json$/, "-report.json")
    : join(dir, "sweep-report.json");

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonPath, renderSweepJson(results), "utf8");
    writeFileSync(mdPath, mdReport, "utf8");
    writeFileSync(reportPath, renderSweepReportJson(results, { timestamp }), "utf8");
    console.log(`\n✓ Wrote reports to:\n  ${jsonPath}\n  ${mdPath}\n  ${reportPath}`);
  } catch (e) {
    console.error(`✗ failed to write report files to ${outDir}:`, e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("✗ sweep failed:", e);
  process.exit(1);
});
