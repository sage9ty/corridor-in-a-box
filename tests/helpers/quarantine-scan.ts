// Static view of the flaky-test quarantine, shared by the guard test
// (tests/quarantine.test.ts) and the CI summary (scripts/quarantine-summary.ts).
//
// Deliberately free of any vitest import: the summary script runs under plain
// tsx, outside the test runner.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Prefix every quarantined describe block carries; the quarantine run filters on it. */
export const QUARANTINE_TAG = "[quarantine]";

/** Set to "1" (by `pnpm test:quarantine`) to run quarantined blocks and nothing else. */
export const QUARANTINE_ENV = "CORRIDOR_QUARANTINE";

const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;

/** A quarantine must point at the GitHub issue tracking the flake. */
export function isIssueUrl(value: unknown): value is string {
  return typeof value === "string" && ISSUE_URL.test(value);
}

/** The describe title a quarantined block is registered under. */
export function quarantineTitle(name: string, issue: string): string {
  return `${QUARANTINE_TAG} ${name} <${issue}>`;
}

export interface QuarantineEntry {
  /** Repo-relative path, forward slashes. */
  file: string;
  line: number;
  /** null when the name is not a plain string literal. */
  name: string | null;
  /** null when the first argument is not a string literal issue URL. */
  issue: string | null;
}

// A call site: `quarantine(` not preceded by an identifier character or `.`,
// so `function quarantine(` and `foo.quarantine(` are not counted as calls.
const CALL = /(?<![\w$.])quarantine\s*\(/g;
const STRING_ARG = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*,/;

function walk(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== "node_modules" && ent.name !== "fixtures") walk(p, out);
    } else if (ent.name.endsWith(".ts")) {
      out.push(p);
    }
  }
}

/**
 * Every `quarantine(...)` call under `testsDir`, excluding the helpers that
 * define it and the guard test, whose deliberately bad calls are its fixtures.
 */
export function findQuarantineEntries(testsDir: string, repoRoot: string): QuarantineEntry[] {
  const files: string[] = [];
  walk(testsDir, files);
  const entries: QuarantineEntry[] = [];
  for (const file of files.sort()) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (rel.includes("/helpers/") || rel.endsWith("/quarantine.test.ts")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL)) {
      const at = m.index + m[0].length;
      const line = src.slice(0, m.index).split("\n").length;
      const first = STRING_ARG.exec(src.slice(at));
      const issue = first && first[1] !== "`" && isIssueUrl(first[2]) ? first[2] : null;
      const second = first ? STRING_ARG.exec(src.slice(at + first[0].length)) : null;
      entries.push({ file: rel, line, name: second ? second[2] : null, issue });
    }
  }
  return entries;
}
