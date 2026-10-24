import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quarantine } from "./helpers/quarantine";
import {
  findQuarantineEntries,
  isIssueUrl,
  QUARANTINE_TAG,
  quarantineTitle,
} from "./helpers/quarantine-scan";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const testsDir = fileURLToPath(new URL(".", import.meta.url));

describe("quarantine: every entry names its issue", () => {
  it("has an issue URL on every quarantine() call in tests/", () => {
    const missing = findQuarantineEntries(testsDir, repoRoot).filter((e) => !e.issue);
    expect(missing.map((e) => `${e.file}:${e.line}`)).toEqual([]);
  });

  it("refuses to register a quarantine without an issue URL", () => {
    expect(() => quarantine("", "no issue", () => {})).toThrow(/issue URL/);
    expect(() => quarantine("#284", "bare number", () => {})).toThrow(/issue URL/);
    expect(() =>
      quarantine("https://github.com/o/r/pull/1", "a PR, not an issue", () => {}),
    ).toThrow(/issue URL/);
  });
});

describe("quarantine: issue URL check", () => {
  it("accepts GitHub issue URLs only", () => {
    expect(isIssueUrl("https://github.com/ezedike-evan/corridor-in-a-box/issues/284")).toBe(
      true,
    );
    expect(isIssueUrl("http://github.com/o/r/issues/1")).toBe(false);
    expect(isIssueUrl("https://github.com/o/r/issues/")).toBe(false);
    expect(isIssueUrl("https://github.com/o/r/issues/1#x")).toBe(false);
    expect(isIssueUrl(undefined)).toBe(false);
  });

  it("tags the describe title so the quarantine run can select it", () => {
    expect(quarantineTitle("socket", "https://github.com/o/r/issues/1")).toBe(
      `${QUARANTINE_TAG} socket <https://github.com/o/r/issues/1>`,
    );
  });
});

describe("quarantine: source scan", () => {
  it("flags a call whose issue is missing, non-literal, or not an issue URL", () => {
    const root = mkdtempSync(join(tmpdir(), "quarantine-scan-"));
    try {
      const dir = join(root, "tests");
      mkdirSync(join(dir, "helpers"), { recursive: true });
      writeFileSync(
        join(dir, "helpers", "quarantine.ts"),
        "export function quarantine(issue: string) {}\n",
      );
      writeFileSync(
        join(dir, "a.test.ts"),
        [
          `quarantine("https://github.com/o/r/issues/7", "good", () => {});`,
          `quarantine("", "empty", () => {});`,
          `quarantine(ISSUE, "variable", () => {});`,
          `quarantine(\`https://github.com/o/r/issues/8\`, "template", () => {});`,
          `quarantine("https://example.com/7", "elsewhere", () => {});`,
        ].join("\n"),
      );
      const entries = findQuarantineEntries(dir, root);
      expect(entries).toEqual([
        {
          file: "tests/a.test.ts",
          line: 1,
          name: "good",
          issue: "https://github.com/o/r/issues/7",
        },
        { file: "tests/a.test.ts", line: 2, name: "empty", issue: null },
        { file: "tests/a.test.ts", line: 3, name: null, issue: null },
        { file: "tests/a.test.ts", line: 4, name: "template", issue: null },
        { file: "tests/a.test.ts", line: 5, name: "elsewhere", issue: null },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
