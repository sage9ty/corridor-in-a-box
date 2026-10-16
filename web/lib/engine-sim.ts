// DEMO-ONLY simulation of @corridor/engine's execute(). It walks the same state
// machine and idempotency rules so the showcase runs with zero backend — but it
// is a re-implementation and CAN drift from the real engine. It is NOT a source
// of truth: for anything load-bearing, set CORRIDOR_SERVICE_URL so the API route
// (app/api/payments/route.ts) proxies to a real @corridor/service instead.

import { getCorridor, liveness } from "./corridors";

export type CorridorState =
  | "created"
  | "quoted"
  | "compliant"
  | "opened"
  | "verifying"
  | "settling"
  | "settled"
  | "reconciled"
  | "completed"
  | "refunded"
  | "held"
  | "failed";

export interface RunOutcome {
  ok: boolean;
  state: CorridorState;
  trail: CorridorState[];
  stellarTxHash?: string;
  error?: { code: string; message: string };
  idempotentReplay?: boolean;
}

// Server-side in-memory store, mirroring the engine's idempotency gate.
//
// Bounded, because the key is attacker-controlled and this Map lives for the
// lifetime of the process: an unbounded one is free memory growth for anyone who
// can POST. Oldest-first eviction (Map preserves insertion order) keeps the
// idempotent-replay demo working for recent keys, which is all it needs to do.
const MAX_RUNS = 500;
const store = new Map<string, RunOutcome>();

function remember(key: string, outcome: RunOutcome): void {
  store.set(key, outcome);
  while (store.size > MAX_RUNS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

function txHash(seed: number): string {
  return `mocktx${seed.toString().padStart(58, "0")}`;
}

export function runPayment(
  corridorId: string,
  amount: string,
  idempotencyKey: string,
): RunOutcome {
  const existing = store.get(idempotencyKey);
  if (existing && existing.state === "completed") {
    return { ...existing, idempotentReplay: true };
  }

  const corridor = getCorridor(corridorId);
  if (!corridor) {
    return { ok: false, state: "failed", trail: ["created", "failed"], error: { code: "MANIFEST_INVALID", message: `unknown corridor ${corridorId}` } };
  }

  // Mirrors isSettleableAmount() in @corridor/types: well-formed AND strictly
  // positive. The signed form let "-100.00" walk to `completed` here exactly as
  // it did in the engine.
  const t = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) {
    return { ok: false, state: "failed", trail: ["created", "failed"], error: { code: "AMOUNT_INVALID", message: `"${amount}" is not a positive decimal amount` } };
  }

  const live = liveness(corridor);
  const trail: CorridorState[] = ["created"];

  // quote
  trail.push("quoted");
  // comply
  trail.push("compliant");
  // open — fails if the destination has no SEP-31 server at all (the off-ramp
  // scarcity this project exists to surface).
  //
  // NOTE the gate is `not-runnable`, not `!live.runnable`. `live.runnable` is
  // true only for corridors whose endpoints have been VERIFIED against a
  // published stellar.toml, which is the right bar for the real engine but the
  // wrong one here: this is an openly-labelled simulation of what the engine
  // WOULD do, so an unverified lane still walks the happy path. The UI shows the
  // corridor's liveness state alongside the result so "simulated" is never
  // mistaken for "confirmed working".
  if (live.state === "not-runnable") {
    trail.push("failed");
    const outcome: RunOutcome = {
      ok: false,
      state: "failed",
      trail,
      error: { code: "ANCHOR_UNAVAILABLE", message: `${corridor.dest.name}: no SEP-31 transfer server configured` },
    };
    remember(idempotencyKey, outcome);
    return outcome;
  }
  trail.push("opened");
  // pre-settle gate
  trail.push("verifying");
  // settle + reconcile
  trail.push("settling");
  trail.push("settled");
  trail.push("reconciled");
  trail.push("completed");

  const outcome: RunOutcome = {
    ok: true,
    state: "completed",
    trail,
    stellarTxHash: txHash(store.size + 1),
  };
  remember(idempotencyKey, outcome);
  return outcome;
}
