#!/usr/bin/env node
// corridor — a tiny CLI to validate manifests, dry-run the plan offline, drive
// live gated canary payments through the real stack, and look after the circuit
// breakers.
//
//   corridor validate <file.corridor.yaml>
//   corridor plan     <file.corridor.yaml>
//   corridor canary   <file.corridor.yaml> --amount <amount> [--network <public|testnet>] [--dry-run]
//   corridor breaker  status [corridorId]
//   corridor breaker  reset <corridorId> --reason "…"
//
// `plan` is the cheap pre-flight: it tells you whether a corridor is actually
// runnable (does the dest anchor expose SEP-31? a SEP-38 quote server?) before
// you ever touch the network.
//
// `canary` drives one tiny real payment through the full, gated stack:
// Sep31Adapter + StellarSettlementSubmitter + the default gate + RegistryRouteResolver.
// With --dry-run it stops after the pre-settle gate and never submits a payment.
//
// `breaker` is the other end: when a lane has halted itself, someone has to look
// at why and then say so in writing before it will take money again. See
// docs/operations.md.

import { loadCorridor } from "@corridor/manifest";
import { isSettleableAmount } from "@corridor/types";
import { PostgresIdempotencyStore, migrate, type CorridorHealthStore } from "@corridor/engine";
import { newCommand } from "./new.js";
import {
  RESOLVE_USAGE,
  listHeldRuns,
  parseListArgs,
  parseResolveArgs,
  resolveHeldRun,
} from "./runs.js";
import { AccountInspector } from "@corridor/stellar";
import { finalizeCanary } from "./proof.js";
import { EXIT_NOT_COMPLETED, executeCanary } from "./wire.js";
import {
  BREAKER_USAGE,
  currentUser,
  formatBreakerRecord,
  formatBreakerReset,
  formatBreakerTable,
  openBreakerSession,
  parseBreakerArgs,
  type BreakerCommand,
} from "./breaker";
import { formatLintResult, lintCorridor } from "./lint";
import { buildPlan, formatPlan, parsePlanArgs } from "./plan.js";

/** The first line is the main usage text; the breaker help follows it. */
const USAGE = [
  "usage: corridor <validate|plan|lint|canary|new> <file.corridor.yaml|domain> [options] | runs list --state held | resolve <key> --outcome <outcome> --note <text>",
  "       corridor plan <file.corridor.yaml> [--json]",
  '       corridor breaker <status [corridorId] | reset <corridorId> --reason "…">',
  "       corridor new <domain> [--source-asset <asset>] [--network <public|testnet>] [--out <file>] [--allow-not-runnable]",
  "",
  "corridor breaker — inspect and reopen halted lanes (reads DATABASE_URL):",
  BREAKER_USAGE,
].join("\n");

// 0 = fine, 1 = it ran and failed, 2 = you asked for something impossible.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  if (cmd === "runs") {
    const parsed = parseListArgs(argv.slice(1));
    return parsed ? withStore((store) => listHeldRuns(store, parsed)) : 2;
  }
  if (cmd === "resolve") return resolveCommand(argv.slice(1));
  if (cmd === "breaker") return breakerCommand(argv.slice(1));
  if (cmd === "new") return newCommand(argv.slice(1));
  if (!cmd || (cmd !== "validate" && cmd !== "plan" && cmd !== "lint" && cmd !== "canary")) {
    console.error(USAGE);
    return EXIT_USAGE;
  }

  if (cmd === "canary") {
    let file: string | undefined;
    let amount: string | undefined;
    let network: string | undefined;
    let skipDoctor = false;
    let write = false;
    let dryRun = false;

    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--amount") {
        if (i + 1 >= rest.length || rest[i + 1].startsWith("--")) {
          console.error("error: --amount requires a value");
          return 2;
        }
        amount = rest[++i];
      } else if (arg.startsWith("--amount=")) {
        amount = arg.slice("--amount=".length);
      } else if (arg === "--network") {
        if (i + 1 >= rest.length || rest[i + 1].startsWith("--")) {
          console.error("error: --network requires a value");
          return 2;
        }
        network = rest[++i];
      } else if (arg.startsWith("--network=")) {
        network = arg.slice("--network=".length);
      } else if (arg === "--skip-doctor") {
        skipDoctor = true;
      } else if (arg === "--write") {
        write = true;
      } else if (arg === "--dry-run") {
        dryRun = true;
      } else if (arg.startsWith("--")) {
        console.error(`error: unknown option "${arg}"`);
        return 2;
      } else {
        if (!file) {
          file = arg;
        } else {
          console.error(`error: unexpected argument "${arg}"`);
          return 2;
        }
      }
    }

    if (!file) {
      console.error(
        "usage: corridor canary <file.corridor.yaml> --amount <amount> [--network <public|testnet>] [--write | --dry-run]",
      );
      return 2;
    }

    if (dryRun && write) {
      console.error("error: --write records a completed payment; a --dry-run makes none");
      return 2;
    }

    if (amount === undefined || amount === "") {
      console.error("error: --amount <amount> is required for canary");
      return 2;
    }

    if (!isSettleableAmount(amount)) {
      console.error(`error: --amount must be a positive decimal amount (got "${amount}")`);
      return 2;
    }

    if (network !== undefined && network !== "public" && network !== "testnet") {
      console.error(`error: --network must be "public" or "testnet" (got "${network}")`);
      return 2;
    }

    const loaded = loadCorridor(file);
    if (!loaded.ok) {
      console.error(`✗ ${loaded.error.code}: ${loaded.error.message}`);
      return 1;
    }

    const runResult = await executeCanary(loaded.value, {
      amount,
      network,
      skipDoctor,
      dryRun,
    });
    if (runResult.exitCode !== 0 || !runResult.run || !runResult.settlement) {
      return runResult.exitCode;
    }

    // Re-read the settlement from Horizon and print the proof block it earned;
    // with --write also record it in the manifest (comments preserved). A run
    // that did not complete returned above, so the file stays byte-identical.
    const finalized = await finalizeCanary({
      result: runResult.run,
      settlement: runResult.settlement,
      corridor: loaded.value,
      verifier: new AccountInspector({ horizonUrl: runResult.horizonUrl }),
      manifestPath: file,
      write,
    });
    if (!finalized.ok) {
      console.error(
        `✗ canary proof rejected: ${finalized.error.code} — ${finalized.error.message}`,
      );
      return EXIT_NOT_COMPLETED;
    }
    console.log(`\nproof (chain-verified):\n${finalized.value.yaml}`);
    if (finalized.value.written) console.log(`wrote proof to ${file}`);
    return 0;
  }

  let file = argv[1];
  let json = false;
  if (cmd === "plan") {
    const parsed = parsePlanArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      return EXIT_USAGE;
    }
    file = parsed.file;
    json = parsed.json;
  }
  if (!file) {
    console.error(`usage: corridor ${cmd} <file.corridor.yaml>`);
    return EXIT_USAGE;
  }

  const loaded = loadCorridor(file);
  if (!loaded.ok) {
    console.error(`✗ ${loaded.error.code}: ${loaded.error.message}`);
    return EXIT_FAILED;
  }
  const c = loaded.value;

  if (cmd === "validate") {
    console.log(`✓ ${file} is a valid corridor manifest (id="${c.id}")`);
    return EXIT_OK;
  }

  if (cmd === "lint") {
    try {
      const result = await lintCorridor(c);
      const output = formatLintResult(result);
      if (result.ok) {
        console.log(output);
        return EXIT_OK;
      }
      console.error(output);
      return EXIT_FAILED;
    } catch (e) {
      console.error(
        `✗ ${c.id} (${c.dest.endpoints.home_domain}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return EXIT_FAILED;
    }
  }

  const plan = buildPlan(c);
  console.log(json ? JSON.stringify(plan, null, 2) : formatPlan(c, plan));
  return EXIT_OK;
}

async function breakerCommand(argv: string[]): Promise<number> {
  const parsed = parseBreakerArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return EXIT_USAGE;
  }
  // Opened only after the arguments are known good, so a typo never reaches
  // for a database connection.
  const opened = await openBreakerSession();
  if (!opened.ok) {
    console.error(`✗ ${opened.error}`);
    return EXIT_FAILED;
  }
  const { store, close } = opened.session;
  try {
    const command = parsed.command;
    if (command.kind === "status") {
      return await breakerStatus(store, command);
    }
    return await breakerReset(store, command);
  } finally {
    // The pool keeps the process alive, so this is not optional tidiness: an
    // unfinished pool would hang the command after it had printed its answer.
    await close();
  }
}

async function breakerStatus(
  store: CorridorHealthStore,
  command: { corridorId?: string },
): Promise<number> {
  if (command.corridorId === undefined) {
    console.log(formatBreakerTable(await store.list()));
    return EXIT_OK;
  }
  // A lane with no row is a legitimate answer ("nothing has failed here"), not
  // an error, so `status` exits 0 for it and says why it is empty.
  console.log(formatBreakerRecord(await store.get(command.corridorId), command.corridorId));
  return EXIT_OK;
}

async function breakerReset(
  store: CorridorHealthStore,
  command: Extract<BreakerCommand, { kind: "reset" }>,
): Promise<number> {
  const before = await store.get(command.corridorId);
  const by = currentUser();
  const record = await store.reset(command.corridorId, by, command.reason);
  console.log(formatBreakerReset(record, before?.state === "open"));
  return EXIT_OK;
}

async function openStore(): Promise<
  { store: PostgresIdempotencyStore; close: () => Promise<void> } | undefined
> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("✗ DATABASE_URL is required for corridor run operations");
    return undefined;
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  await migrate(pool);
  return { store: new PostgresIdempotencyStore(pool), close: () => pool.end() };
}

async function resolveCommand(args: string[]): Promise<number> {
  const parsed = parseResolveArgs(args);
  if (!parsed) {
    console.error(RESOLVE_USAGE);
    return 2;
  }
  const resolvedBy = process.env.CORRIDOR_OPERATOR_ID?.trim();
  if (!resolvedBy) {
    console.error("✗ CORRIDOR_OPERATOR_ID is required to record who resolved the run");
    return 1;
  }
  return withStore((store) => resolveHeldRun(store, parsed, resolvedBy));
}

async function withStore(
  fn: (store: PostgresIdempotencyStore) => Promise<number>,
): Promise<number> {
  const opened = await openStore();
  if (!opened) return 1;
  try {
    return await fn(opened.store);
  } finally {
    await opened.close();
  }
}

void main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      `✗ corridor command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
