// Markdown report of the flaky-test quarantine, for the CI job summary.
//
// Lists every quarantine() call found in tests/ with its tracking issue, joined
// with the outcome from a vitest JSON report when one is given. A quarantined
// block that produced no results is reported as such, never as passing.
//
//   pnpm exec tsx scripts/quarantine-summary.ts [quarantine-report.json] >> "$GITHUB_STEP_SUMMARY"

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findQuarantineEntries, quarantineTitle } from "../tests/helpers/quarantine-scan";

interface AssertionResult {
  ancestorTitles: string[];
  status: string;
}
interface JsonReport {
  testResults: { assertionResults: AssertionResult[] }[];
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const entries = findQuarantineEntries(
  fileURLToPath(new URL("../tests", import.meta.url)),
  repoRoot,
);

const reportPath = process.argv[2];
const report: JsonReport | null =
  reportPath && existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as JsonReport)
    : null;
const results = report?.testResults.flatMap((f) => f.assertionResults) ?? [];

function outcome(name: string | null, issue: string | null): string {
  if (!report) return "no report";
  if (!name || !issue) return "not runnable";
  const title = quarantineTitle(name, issue);
  const mine = results.filter((a) => a.ancestorTitles.includes(title));
  if (mine.length === 0) return "no results";
  const failed = mine.filter((a) => a.status === "failed").length;
  const passed = mine.filter((a) => a.status === "passed").length;
  return failed > 0 ? `❌ ${failed} failed, ${passed} passed` : `✅ ${passed} passed`;
}

const out: string[] = ["## Quarantined tests", ""];
if (reportPath && !report)
  out.push(`> No report at \`${reportPath}\`: the run did not finish.`, "");
if (entries.length === 0) {
  out.push("Nothing is quarantined.");
} else {
  out.push("| Test | Location | Issue | Outcome (retry: 3) |", "| --- | --- | --- | --- |");
  for (const e of entries) {
    const name = e.name ?? "_(non-literal name)_";
    const issue = e.issue ?? "**missing**";
    out.push(`| ${name} | \`${e.file}:${e.line}\` | ${issue} | ${outcome(e.name, e.issue)} |`);
  }
}
console.log(out.join("\n"));
