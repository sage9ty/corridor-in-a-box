#!/usr/bin/env node
// corridor — a tiny CLI to validate manifests, dry-run the plan offline, drive
// live gated canary payments through the real stack, and look after the circuit
// breakers.
//
//   corridor validate <file.corridor.yaml>
//   corridor plan     <file.corridor.yaml>
//   corridor canary   <file.corridor.yaml> --amount <amount> [--network <public|testnet>]
//   corridor breaker  status [corridorId]
//   corridor breaker  reset <corridorId> --reason "…"
//
// `plan` is the cheap pre-flight: it tells you whether a corridor is actually
// runnable (does the dest anchor expose SEP-31? a SEP-38 quote server?) before
// you ever touch the network.
//
// `canary` drives one tiny real payment through the full, gated stack:
// Sep31Adapter + StellarSettlementSubmitter + the default gate + RegistryRouteResolver.
//
// `breaker` is the other end: when a lane has halted itself, someone has to look
// at why and then say so in writing before it will take money again. See
// docs/operations.md.

import { liveness, loadCorridor, type Corridor } from "@corridor/manifest";
import { isSettleableAmount } from "@corridor/types";
import { PostgresIdempotencyStore, migrate, type CorridorHealthStore } from "@corridor/engine";
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

/** The first line is the main usage text; the breaker help follows it. */
const USAGE = [
  "usage: corridor <validate|plan|canary> <file.corridor.yaml> [options] | runs list --state held | resolve <key> --outcome <outcome> --note <text>",
  '       corridor breaker <status [corridorId] | reset <corridorId> --reason "…">',
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
  if (!cmd || (cmd !== "validate" && cmd !== "plan" && cmd !== "canary")) {
    console.error(USAGE);
    return EXIT_USAGE;
  }

  if (cmd === "canary") {
    let file: string | undefined;
    let amount: string | undefined;
    let network: string | undefined;
    let skipDoctor = false;
    let write = false;

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
        "usage: corridor canary <file.corridor.yaml> --amount <amount> [--network <public|testnet>] [--write]",
      );
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

  const file = argv[1];
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

  printPlan(c);
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

function printPlan(c: Corridor): void {
  const line = (s = "") => console.log(s);
  line(`corridor: ${c.id}`);
  if (c.status_note) line(`note:     ${c.status_note}`);
  line(
    `route:    ${c.fx.path.join(" -> ")}   (risk: ${c.fx.who_holds_risk}, ttl ${c.fx.quote_ttl_seconds}s)`,
  );
  line(
    `source:   ${c.source.name}  [${c.source.asset}]  ${c.source.protocol}${c.source.endpoints?.home_domain ? `  ${c.source.endpoints.home_domain}` : ""}`,
  );
  line(`dest:     ${c.dest.name}  [${c.dest.asset}]  ${c.dest.endpoints.home_domain}`);
  line(`bridge:   ${c.settlement.bridge_asset} on ${c.settlement.network}`);
  if (c.limits && (c.limits.min_amount !== undefined || c.limits.max_amount !== undefined)) {
    const parts: string[] = [];
    if (c.limits.min_amount !== undefined) parts.push(`min=${c.limits.min_amount}`);
    if (c.limits.max_amount !== undefined) parts.push(`max=${c.limits.max_amount}`);
    line(`limits:   ${parts.join(" ")}`);
  }
  line(
    `recovery: retries=${c.recovery.max_retries}, timeout=${c.recovery.timeout_seconds}s, rollback=${c.recovery.rollback}, breaker=${c.recovery.breaker.consecutive_failures}`,
  );
  line();
  line("steps:");
  line("  1. quote      SEP-38  POST /quote");
  line("  2. comply     SEP-10 auth + SEP-12 KYC handoff");
  line("  3. open       SEP-31  POST /transactions");
  line("  4. settle     native Stellar payment of bridge asset");
  line("  5. reconcile  SEP-31  GET /transactions/:id");
  line();

  // Liveness comes from @corridor/manifest so this command and the web dashboard
  // can never describe the same corridor differently.
  const live = liveness(c);

  if (live.state === "proven" && live.proof) {
    const hashPrefix = live.proof.stellar_tx_hash.slice(0, 8);
    const date = live.proof.canary_completed_at.slice(0, 10);
    const now = new Date();
    const completedAt = new Date(live.proof.canary_completed_at).getTime();
    const ageMs = now.getTime() - completedAt;
    const daysAgo = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
    const maxAge = live.proof.max_age_days ?? 30;
    const expiresIn = Math.max(0, maxAge - daysAgo);
    line(
      `liveness: ✓✓ PROVEN — canary ${hashPrefix} completed ${date} (${daysAgo} days ago, expires in ${expiresIn}d)`,
    );
  } else if (live.state === "verified") {
    line(`liveness: ✓ VERIFIED — endpoints confirmed ${live.verifiedAt} for all five steps`);
    const cap = c.proof?.canary_max_amount ?? c.limits?.max_amount ?? "default";
    if (c.proof) {
      // A proof is on file but liveness() did not honour it (stale, future-dated):
      // saying "none" would be wrong, and the reason is in the warnings below.
      const hashPrefix = c.proof.stellar_tx_hash.slice(0, 8);
      const date = c.proof.canary_completed_at.slice(0, 10);
      line(
        `proof:    not current — canary ${hashPrefix} completed ${date}; amounts capped at ${cap}`,
      );
    } else {
      line(`proof:    none — amounts capped at ${cap}`);
    }
  } else if (live.state === "unverified") {
    line("liveness: ? UNVERIFIED — endpoints present but unconfirmed. NOT runnable.");
  } else {
    line("liveness: ✗ NOT RUNNABLE — a required endpoint is missing.");
  }

  if (live.warnings.length > 0) {
    line();
    line("liveness warnings:");
    for (const w of live.warnings) line(`  ! ${w}`);
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
