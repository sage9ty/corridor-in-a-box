import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryIdempotencyStore } from "@corridor/engine";
import type { BreakerRecord, RunResult, SettlementRequest } from "@corridor/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveness, loadCorridor, type Corridor } from "@corridor/manifest";
import { ok } from "@corridor/types";
import type { SettlementFacts } from "@corridor/stellar";
import { finalizeCanary, type PaymentVerifier } from "../packages/cli/src/proof";
import {
  listHeldRuns,
  parseListArgs,
  parseResolveArgs,
  resolveHeldRun,
} from "../packages/cli/src/runs";
import {
  currentUser,
  formatBreakerRecord,
  formatBreakerReset,
  formatBreakerTable,
  parseBreakerArgs,
} from "../packages/cli/src/breaker";

// packages/cli/src/index.ts calls process.exit(main(...)) at module top level
// and has no vitest path alias, so importing it directly would kill the test
// worker. Spawn it as a child process instead — also a more honest way to
// test a CLI's actual argv/exit-code/stdio contract. Everything that does not
// need a process (argument parsing, rendering) lives in packages/cli/src/breaker
// and is imported directly below, because the interesting properties of those
// are types and strings, not exit codes.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Spawn `node node_modules/tsx/dist/cli.mjs` rather than `node_modules/.bin/tsx`.
// The `.bin` entry is a shell script (`tsx` / `tsx.cmd`) that cannot be spawned
// directly on Windows without a shell, which made every case in this file fail
// there with a null exit status. Going through the current interpreter and the
// bin target tsx itself declares is portable and needs no shell.
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // `process.env` minus DATABASE_URL by default: these cases must never
    // depend on whether the developer running them has one exported, and a test
    // that silently talks to a real database is worse than no test.
    env: { ...process.env, DATABASE_URL: "", ...env },
  });
}

// `currentUser` reads the OS account, and the interesting half of that is the
// fallback chain, which only runs when the OS lookup fails — as it does in a
// distroless container with no passwd entry for the running uid. That cannot be
// provoked from this box, where userInfo() always succeeds, so it is stubbed.
// Default state is "the real lookup succeeded", which is the production path.
const osUser = vi.hoisted(() => ({
  mode: "real" as "real" | "throw" | "empty",
  value: "ada",
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => {
      if (osUser.mode === "throw") {
        throw new Error("uv_os_get_passwd failed: no entry for this uid");
      }
      return { ...actual.userInfo(), username: osUser.mode === "empty" ? "" : osUser.value };
    },
  };
});

afterEach(() => {
  osUser.mode = "real";
  osUser.value = "ada";
});

function completedCanary(corridor: Corridor) {
  const result: RunResult = {
    idempotencyKey: "canary-test",
    state: "completed",
    transactionId: "anchor-tx-1",
    stellarTxHash: "a".repeat(64),
    trail: ["created", "completed"],
  };
  const settlement: SettlementRequest = {
    to: "GDESTINATION",
    memo: "memo-1",
    memoType: "text",
    amount: { asset: corridor.settlement.bridge_asset, amount: "1.00" },
    corridor,
  };
  return { result, settlement };
}

/** Horizon facts that exactly match what `completedCanary` submitted. */
function matchingFacts(hash: string): SettlementFacts {
  return {
    hash,
    successful: true,
    memo: "memo-1",
    memoType: "text",
    operations: [
      {
        type: "payment",
        to: "GDESTINATION",
        amount: "1.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
    ],
  };
}

const verifier: PaymentVerifier = {
  settlementFacts: async (hash) => ok(matchingFacts(hash)),
};

/** A throwaway copy of the comment-carrying fixture; --write mutates in place. */
function fixtureCopy(): string {
  const directory = mkdtempSync(join(tmpdir(), "corridor-canary-"));
  const manifestPath = join(directory, "verified.corridor.yaml");
  copyFileSync(join(REPO_ROOT, "tests/fixtures/verified.corridor.yaml"), manifestPath);
  return manifestPath;
}

describe("corridor CLI", () => {
  it("requires held state for run listing", () => {
    const r = run(["runs", "list", "--state", "completed"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corridor runs list --state held");
  });

  it("requires an outcome and note to resolve a run", () => {
    const r = run(["resolve", "some-key"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--outcome");
  });

  it("requires DATABASE_URL for run listing", () => {
    const r = run(["runs", "list", "--state", "held"], { DATABASE_URL: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL is required");
  });

  it("prints usage and exits 2 with no args", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor <validate|plan|canary>");
  });

  it("exits 2 on an unknown subcommand", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(2);
  });

  it("prints usage and exits 2 when the file arg is missing", () => {
    const r = run(["validate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor validate");
  });

  it("validate: exits 0 for a valid manifest", () => {
    const r = run(["validate", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('id="reference-testnet"');
  });

  it("validate: exits 1 for a structurally invalid manifest", () => {
    const r = run(["validate", "tests/fixtures/invalid.corridor.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MANIFEST_INVALID");
    expect(r.stderr).toContain("source");
  });

  it("validate: exits 1 for a nonexistent path", () => {
    const r = run(["validate", "corridors/does-not-exist.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read or parse");
  });

  // Liveness has three states. The distinction that matters: a corridor whose
  // endpoints are merely PRESENT must never be reported as runnable — that is
  // how tooling ends up certifying a lane nobody has checked.

  it("plan: reports VERIFIED with proof: none when endpoints_verified_at is set without proof", () => {
    const r = run(["plan", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-01-01");
    expect(r.stdout).toContain("proof:    none — amounts capped at default");
  });

  it("plan: reports PROVEN with canary hash and completion age for proven lane", () => {
    const r = run(["plan", "tests/fixtures/proven.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓✓ PROVEN");
    expect(r.stdout).toContain("canary a1b2c3d4 completed 2026-09-20");
    expect(r.stdout).toContain("days ago, expires in");
  });

  it("plan: reports VERIFIED with warning when proof is stale", () => {
    const r = run(["plan", "tests/fixtures/stale-proof.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    // A stale proof exists, so the plan must not claim there is none.
    expect(r.stdout).toContain("proof:    not current — canary a1b2c3d4 completed 2025-01-01");
    expect(r.stdout).not.toContain("proof:    none");
    expect(r.stdout).toContain("liveness warnings:");
    expect(r.stdout).toContain("proof is stale");
  });

  it("plan: reports UNVERIFIED for a fully-specified but unchecked corridor", () => {
    const r = run(["plan", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ? UNVERIFIED");
    expect(r.stdout).toContain("NOT runnable");
    // Regression guard for the claim that got the project rejected: a corridor
    // with unconfirmed endpoints must never carry the green marker.
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: never reports a placeholder-endpoint corridor as runnable", () => {
    const r = run(["plan", "corridors/mx-example.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNVERIFIED");
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: reports all three liveness warnings for a corridor missing dest endpoints", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.status).toBe(0); // warnings don't fail the command
    expect(r.stdout).toContain("NOT RUNNABLE");
    expect(r.stdout).toContain("quotes will fail");
    expect(r.stdout).toContain("no per-customer KYC");
  });

  it("plan: reports VERIFIED for ng-cowrie", () => {
    const r = run(["plan", "corridors/ng-cowrie.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-08-11");
  });

  it("plan: prints the status_note when present", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.stdout).toContain("PENDING");
  });

  it("canary: requires an explicit amount", () => {
    const r = run(["canary", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--amount");
  });

  it("canary --write preserves comments and records a re-parsable PROVEN proof", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const canary = completedCanary(loaded.value);
    const finalized = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;

    const written = readFileSync(manifestPath, "utf8");
    // Every hand-written comment in the fixture survives the rewrite.
    expect(written).toContain("# Fixture: a corridor whose dest endpoints carry");
    expect(written).toContain("# anchor's data or live network reachability.");
    expect(written).toContain("proof:");
    expect(written).toContain('canary_completed_at: "2026-01-01"');
    expect(written).toContain(`stellar_tx_hash: ${"a".repeat(64)}`);

    const reparsed = loadCorridor(manifestPath);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(liveness(reparsed.value, new Date("2026-01-01T12:00:00.000Z")).state).toBe(
        "proven",
      );
    }
  });

  it("canary --write refreshes the existing proof instead of appending a second block", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");

    await finalizeCanary({
      ...completedCanary(loaded.value),
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });

    const afterFirst = loadCorridor(manifestPath);
    if (!afterFirst.ok) throw new Error("fixture invalid");
    const second = await finalizeCanary({
      ...completedCanary(afterFirst.value),
      result: { ...completedCanary(afterFirst.value).result, stellarTxHash: "b".repeat(64) },
      corridor: afterFirst.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-20T12:00:00.000Z"),
    });
    expect(second.ok).toBe(true);

    const written = readFileSync(manifestPath, "utf8");
    expect(written.match(/^proof:/gm)).toHaveLength(1);
    expect(written).toContain(`stellar_tx_hash: ${"b".repeat(64)}`);
    expect(written).not.toContain("a".repeat(64));
    const reparsed = loadCorridor(manifestPath);
    if (!reparsed.ok) throw new Error("written manifest did not re-parse");
    expect(reparsed.value.proof?.canary_completed_at).toBe("2026-01-20");
  });

  it("canary refuses to write when the chain read contradicts the run", async () => {
    const manifestPath = fixtureCopy();
    const before = readFileSync(manifestPath, "utf8");
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");

    const mismatched: PaymentVerifier = {
      settlementFacts: async (hash) =>
        ok({ ...matchingFacts(hash), memo: "someone-elses-memo" }),
    };
    const finalized = await finalizeCanary({
      ...completedCanary(loaded.value),
      corridor: loaded.value,
      verifier: mismatched,
      manifestPath,
      write: true,
    });
    expect(finalized.ok).toBe(false);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("canary refuses a payment above the recorded proof ceiling", async () => {
    const manifestPath = fixtureCopy();
    const before = readFileSync(manifestPath, "utf8");
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");
    const canary = completedCanary(loaded.value);

    const finalized = await finalizeCanary({
      ...canary,
      settlement: {
        ...canary.settlement,
        amount: { asset: canary.settlement.amount.asset, amount: "25.00" },
      },
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
    });
    expect(finalized.ok).toBe(false);
    if (!finalized.ok) expect(finalized.error.message).toContain("ceiling");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  // Every non-completed terminal state must leave the file byte-identical, and
  // must not even reach the chain read: the guard is the first thing that runs.
  for (const state of ["failed", "held", "refunded"] as const) {
    it(`canary never writes a proof for a run that ended ${state}`, async () => {
      const manifestPath = fixtureCopy();
      const before = readFileSync(manifestPath, "utf8");
      const loaded = loadCorridor(manifestPath);
      if (!loaded.ok) throw new Error("fixture invalid");

      const canary = completedCanary(loaded.value);
      const exploding: PaymentVerifier = {
        settlementFacts: async () => {
          throw new Error("chain read must not happen for a non-completed run");
        },
      };
      const finalized = await finalizeCanary({
        ...canary,
        result: { ...canary.result, state },
        corridor: loaded.value,
        verifier: exploding,
        manifestPath,
        write: true,
      });
      expect(finalized.ok).toBe(false);
      if (!finalized.ok) expect(finalized.error.message).toContain("manifest was not changed");
      expect(readFileSync(manifestPath, "utf8")).toBe(before);
    });
  }
  describe("canary subcommand", () => {
    it("prints usage and exits 2 when the file arg is missing", () => {
      const r = run(["canary"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage: corridor canary");
    });

    it("argument validation: exits 2 when --amount is missing", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--amount <amount> is required");
    });

    it("argument validation: exits 2 when --amount has no value", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml", "--amount"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--amount requires a value");
    });

    it("argument validation: exits 2 when --amount is non-positive or malformed", () => {
      const r1 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "abc"]);
      expect(r1.status).toBe(2);
      expect(r1.stderr).toContain("positive decimal amount");

      const r2 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "-1.00"]);
      expect(r2.status).toBe(2);
      expect(r2.stderr).toContain("positive decimal amount");

      const r3 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "0"]);
      expect(r3.status).toBe(2);
      expect(r3.stderr).toContain("positive decimal amount");
    });

    it("argument validation: exits 2 when --network is invalid", () => {
      const r = run([
        "canary",
        "corridors/reference.corridor.yaml",
        "--amount",
        "1.00",
        "--network",
        "regtest",
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--network must be "public" or "testnet"');
    });

    it("mainnet refusal without flag: exits 3 when --network public is omitted", () => {
      const r = run(["canary", "corridors/ng-cowrie.corridor.yaml", "--amount", "1.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("settles on MAINNET");
      expect(r.stderr).toContain("Pass --network public explicitly");
    });

    it("over-cap refusal: exits 3 when amount exceeds default canary cap", () => {
      const r = run(["canary", "tests/fixtures/verified.corridor.yaml", "--amount", "25.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("exceeds canary cap");
    });

    it("over-cap refusal: exits 3 when amount exceeds proof.canary_max_amount", () => {
      const r = run([
        "canary",
        "tests/fixtures/canary-capped.corridor.yaml",
        "--amount",
        "6.00",
      ]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('exceeds canary cap "5.00"');
    });

    it("liveness refusal: exits 3 when corridor endpoints are UNVERIFIED", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml", "--amount", "1.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("liveness is UNVERIFIED");
      expect(r.stderr).toContain("must be VERIFIED to run canary");
    });
  });

  it("plan: prints limits min and max when set", () => {
    const r = run(["plan", "tests/fixtures/limits.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("limits:   min=10.00 max=500.00");
  });
});

describe("corridor runs (held-run operator commands)", () => {
  const seed = async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "held-1",
      corridorId: "ref",
      state: "held",
      version: 4,
      stellarTxHash: "abc123",
      lastError: "anchor stalled",
    });
    await store.put({
      idempotencyKey: "done-1",
      corridorId: "ref",
      state: "completed",
      version: 6,
    });
    return store;
  };
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m) => void err.push(String(m)));
    return { out, err };
  };
  afterEach(() => vi.restoreAllMocks());

  it("list prints a header and one tab-separated row per held run", async () => {
    const store = await seed();
    const { out } = capture();
    const code = await listHeldRuns(store, parseListArgs(["list", "--state", "held"])!);
    expect(code).toBe(0);
    expect(out).toEqual([
      "idempotency_key\tcorridor_id\tstate\tversion\tstellar_tx_hash\tlast_error",
      "held-1\tref\theld\t4\tabc123\tanchor stalled",
    ]);
  });

  it("resolve records the outcome for a held run and leaves the run held", async () => {
    const store = await seed();
    capture();
    const parsed = parseResolveArgs(["held-1", "--outcome", "written-off", "--note", "n"])!;
    expect(await resolveHeldRun(store, parsed, "op")).toBe(0);
    expect(await store.getResolution("held-1")).toMatchObject({
      outcome: "written-off",
      resolvedBy: "op",
    });
    expect((await store.get("held-1"))?.state).toBe("held");
  });

  it("resolve rejects a non-held run and an unknown key", async () => {
    const store = await seed();
    const { err } = capture();
    const parsed = (key: string) =>
      parseResolveArgs([key, "--outcome", "refunded-offchain", "--note", "n"])!;
    expect(await resolveHeldRun(store, parsed("done-1"), "op")).toBe(1);
    expect(await resolveHeldRun(store, parsed("missing"), "op")).toBe(1);
    expect(err.join("\n")).toContain("only an existing held run can be resolved");
    expect(await store.getResolution("done-1")).toBeUndefined();
  });

  it("resolve rejects a second resolution and keeps the first", async () => {
    const store = await seed();
    const { err } = capture();
    const first = parseResolveArgs([
      "held-1",
      "--outcome",
      "paid-out-manually",
      "--note",
      "a",
    ])!;
    const second = parseResolveArgs(["held-1", "--outcome", "written-off", "--note", "b"])!;
    expect(await resolveHeldRun(store, first, "op")).toBe(0);
    expect(await resolveHeldRun(store, second, "op2")).toBe(1);
    expect(err.join("\n")).toContain("already has an out-of-band resolution");
    expect(await store.getResolution("held-1")).toMatchObject({
      outcome: "paid-out-manually",
    });
  });
});

// --- corridor breaker -----------------------------------------------------
// A halt is only safe if reopening it is deliberate and recorded. These cases
// cover the two halves of that: the process contract (exit codes, messages) and
// the pure logic behind them (what parses, what renders).

describe("corridor breaker (process contract)", () => {
  // The headline case. A reset with no reason on record is indistinguishable,
  // months later, from somebody clearing alerts at 3am without reading the lane.
  it("reset without --reason exits 2 and says what is missing", () => {
    const r = run(["breaker", "reset", "ng-cn"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--reason");
    expect(r.stderr).toContain("requires");
  });

  it("reset with an empty --reason also exits 2", () => {
    const r = run(["breaker", "reset", "ng-cn", "--reason", "   "]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--reason");
  });

  it("reset with --reason but no DATABASE_URL exits 1, not 2", () => {
    // The arguments were fine; the environment is not. Collapsing these into one
    // code would tell an operator to fix their command when it is their env.
    const r = run(["breaker", "reset", "ng-cn", "--reason", "anchor restored"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("status without DATABASE_URL exits 1 and names the variable", () => {
    const r = run(["breaker", "status"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("exits 2 for a missing corridor id on reset", () => {
    const r = run(["breaker", "reset", "--reason", "why"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires a corridor id");
  });

  it("exits 2 on an unknown breaker subcommand", () => {
    const r = run(["breaker", "frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown breaker subcommand");
  });

  it("exits 2 on an unknown flag rather than treating it as a corridor id", () => {
    const r = run(["breaker", "reset", "ng-cn", "--reason", "why", "--force"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  it("exits 2 on more than one corridor id", () => {
    const r = run(["breaker", "status", "a", "b"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("at most one corridor id");
  });

  it("prints the breaker usage for `corridor breaker` with no subcommand", () => {
    const r = run(["breaker"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corridor breaker status");
    expect(r.stderr).toContain("--reason");
  });

  it("validate and plan keep working with no DATABASE_URL set", () => {
    // The breaker commands read a database; the manifest commands must not need
    // one, or a dev box without Postgres cannot check a manifest at all.
    expect(run(["validate", "corridors/reference.corridor.yaml"]).status).toBe(0);
    expect(run(["plan", "corridors/reference.corridor.yaml"]).status).toBe(0);
  });
});

describe("parseBreakerArgs", () => {
  it("accepts status with and without a corridor id", () => {
    expect(parseBreakerArgs(["status"])).toEqual({
      ok: true,
      command: { kind: "status", corridorId: undefined },
    });
    expect(parseBreakerArgs(["status", "ng-cn"])).toEqual({
      ok: true,
      command: { kind: "status", corridorId: "ng-cn" },
    });
  });

  it("accepts both --reason forms", () => {
    expect(parseBreakerArgs(["reset", "ng-cn", "--reason", "anchor restored"])).toEqual({
      ok: true,
      command: { kind: "reset", corridorId: "ng-cn", reason: "anchor restored" },
    });
    expect(parseBreakerArgs(["reset", "--reason=anchor restored", "ng-cn"])).toEqual({
      ok: true,
      command: { kind: "reset", corridorId: "ng-cn", reason: "anchor restored" },
    });
  });

  it("keeps a multi-word reason intact", () => {
    const r = parseBreakerArgs([
      "reset",
      "ng-cn",
      "--reason",
      "checked with the anchor on call",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.kind === "reset") {
      expect(r.command.reason).toBe("checked with the anchor on call");
    }
  });

  it("does not let a flag's value be mistaken for the corridor id", () => {
    // `--reason ng-cn` must not be read as the corridor; without this, a reset
    // aimed at the wrong lane would succeed silently.
    const r = parseBreakerArgs(["reset", "--reason", "why", "mx-example"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.kind === "reset") expect(r.command.corridorId).toBe("mx-example");
  });

  it("refuses a reason that is only whitespace", () => {
    const r = parseBreakerArgs(["reset", "ng-cn", "--reason", "  \t "]);
    expect(r.ok).toBe(false);
  });

  it("returns the usage text for --help instead of a command", () => {
    const r = parseBreakerArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("corridor breaker reset");
  });
});

describe("breaker status output", () => {
  const open: BreakerRecord = {
    corridorId: "ng-cn",
    state: "open",
    consecutiveFailures: 3,
    trippedAt: Date.parse("2026-09-28T12:00:00.000Z"),
    lastError: "RECONCILE_STALLED: anchor never reported a terminal status",
    updatedAt: Date.parse("2026-09-28T12:00:00.000Z"),
  };

  it("shows a halted lane with its mark, when it tripped and why", () => {
    const out = formatBreakerRecord(open, "ng-cn");
    expect(out).toContain("corridor: ng-cn");
    expect(out).toContain("OPEN");
    expect(out).toContain("2026-09-28T12:00:00.000Z");
    expect(out).toContain("RECONCILE_STALLED");
    expect(out).toContain("failures: 3 consecutive");
  });

  it("distinguishes a lane with no row from a healthy one", () => {
    // "No evidence" and "evidence of health" are different claims, and an
    // operator acting on the difference is the whole point of the command.
    const out = formatBreakerRecord(undefined, "brand-new");
    expect(out).toContain("UNKNOWN");
    expect(out).not.toContain("CLOSED");
  });

  it("shows a closed lane as accepting work", () => {
    const out = formatBreakerRecord(
      { corridorId: "ng-cn", state: "closed", consecutiveFailures: 0, updatedAt: 0 },
      "ng-cn",
    );
    expect(out).toContain("CLOSED");
    expect(out).toContain("accepting new runs");
  });

  it("never claims how close a lane is to tripping", () => {
    // The threshold is in the manifest, not the row. Reporting "1 short of
    // tripping" would be a guess, and a wrong one whenever the operator has
    // changed recovery.breaker.consecutive_failures. The count alone is honest.
    const out = formatBreakerRecord(
      { corridorId: "ng-cn", state: "closed", consecutiveFailures: 2, updatedAt: 0 },
      "ng-cn",
    );
    expect(out).toContain("failures: 2 consecutive");
    expect(out).toContain("still accepting new runs");
    expect(out).not.toContain("short of tripping");
  });

  it("lists every lane, halted ones first", () => {
    const closed: BreakerRecord = {
      corridorId: "aaa-closed",
      state: "closed",
      consecutiveFailures: 0,
      updatedAt: 0,
    };
    const out = formatBreakerTable([closed, open]);
    const lines = out.split("\n");
    // Header, rule, then rows. The halted lane must not be the second data row.
    expect(lines[0]).toContain("CORRIDOR");
    expect(lines[0]).toContain("STATE");
    expect(lines[2]).toContain("ng-cn");
    expect(lines[3]).toContain("aaa-closed");
  });

  it("says so plainly when nothing has failed anywhere", () => {
    expect(formatBreakerTable([])).toContain("no breaker state recorded");
  });

  it("confirms a reset with who did it, when and why", () => {
    const out = formatBreakerReset(
      {
        corridorId: "ng-cn",
        state: "closed",
        consecutiveFailures: 0,
        resetBy: "ezedike",
        resetReason: "anchor confirmed healthy",
        resetAt: 5000,
        updatedAt: 5000,
      },
      true,
    );
    expect(out).toContain("CLOSED");
    expect(out).toContain("by:       ezedike");
    expect(out).toContain("anchor confirmed healthy");
    // The lane really was halted, so there is no caveat to print.
    expect(out).not.toContain("not halted");
  });

  it("prints the name the store recorded, and 'unknown' when it recorded none", () => {
    const base = {
      corridorId: "ng-cn",
      state: "closed" as const,
      consecutiveFailures: 0,
      resetReason: "r",
      resetAt: 5000,
      updatedAt: 5000,
    };
    expect(formatBreakerReset({ ...base, resetBy: "recorded-name" }, true)).toContain(
      "by:       recorded-name",
    );
    expect(formatBreakerReset(base, true)).toContain("by:       unknown");
  });

  it("flags a reset of a lane that was not halted", () => {
    // Resetting a healthy lane usually means re-running a command someone
    // thought had failed. Saying "reopened" there would be a lie.
    const out = formatBreakerReset(
      {
        corridorId: "ng-cn",
        state: "closed",
        consecutiveFailures: 0,
        resetBy: "ezedike",
        resetReason: "why not",
        resetAt: 5000,
        updatedAt: 5000,
      },
      false,
    );
    expect(out).toContain("was not halted");
  });
});

// The reset is only auditable if the name in `reset_by` is the person who ran
// the command, so the function that produces it is worth pinning on its own.
// The plumbing that passes it to `store.reset` is covered by the store tests;
// what those cannot see is whether this function can lose the field entirely.
describe("currentUser", () => {
  it("prefers the OS account over the environment", () => {
    osUser.mode = "real";
    osUser.value = "ada";
    // Every variable is set: if the env were consulted first, or first-wins
    // were wrong, this would return something else and the recorded `reset_by`
    // would name the wrong person.
    expect(currentUser({ USER: "from-env", USERNAME: "from-env", LOGNAME: "from-env" })).toBe(
      "ada",
    );
  });

  it("falls back through USER, USERNAME and LOGNAME when the OS lookup fails", () => {
    // The distroless-container path: no passwd entry for the uid, so the audit
    // field survives on the environment instead of being lost.
    osUser.mode = "throw";
    expect(currentUser({ USER: "ada", USERNAME: "grace", LOGNAME: "alan" })).toBe("ada");
    expect(currentUser({ USERNAME: "grace", LOGNAME: "alan" })).toBe("grace");
    expect(currentUser({ LOGNAME: "alan" })).toBe("alan");
  });

  it("treats an empty OS username as no username", () => {
    osUser.mode = "empty";
    expect(currentUser({ USERNAME: "grace" })).toBe("grace");
  });

  it("returns 'unknown' only when every source is empty", () => {
    // The last resort, and it is a real value rather than a blank string: a
    // blank `reset_by` would read as a reset nobody was accountable for.
    osUser.mode = "throw";
    expect(currentUser({})).toBe("unknown");
    expect(currentUser({ USER: "", USERNAME: "", LOGNAME: "" })).toBe("unknown");
  });

  it("always returns a non-blank name on this machine", () => {
    osUser.mode = "real";
    osUser.value = "ada";
    const u = currentUser({});
    expect(u.length).toBeGreaterThan(0);
    expect(u.trim()).toBe(u);
  });
});
