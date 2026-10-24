// Quarantine for flaky tests: keep a timing- or network-dependent test in the
// tree, out of the blocking `pnpm test` run, without skipping it silently.
//
//   quarantine("https://github.com/ezedike-evan/corridor-in-a-box/issues/123", "socket 413", () => {
//     it("rejects a body over the cap", async () => { ... });
//   });
//
// The main run skips the block. `pnpm test:quarantine` runs only quarantined
// blocks, with retry: 3, and the non-blocking `quarantine` CI job reports each
// one next to its issue. Blocks run sequentially (never describe.concurrent):
// concurrency is the usual source of the flake being quarantined.

import { describe } from "vitest";
import { isIssueUrl, QUARANTINE_ENV, quarantineTitle } from "./quarantine-scan";

export { QUARANTINE_ENV, QUARANTINE_TAG } from "./quarantine-scan";

export function quarantineMode(): boolean {
  return process.env[QUARANTINE_ENV] === "1";
}

export function quarantine(issue: string, name: string, fn: () => void): void {
  if (!isIssueUrl(issue)) {
    throw new Error(
      `quarantine("${name}"): first argument must be the GitHub issue URL tracking the flake ` +
        `(https://github.com/<owner>/<repo>/issues/<n>), got ${JSON.stringify(issue)}`,
    );
  }
  describe(quarantineTitle(name, issue), { sequential: true, skip: !quarantineMode() }, fn);
}
