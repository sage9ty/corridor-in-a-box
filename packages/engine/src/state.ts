// The corridor state machine — the spine. Every payment walks these states in
// order; recover() is the only thing that moves backwards. Persist the state +
// a monotonic version after each transition so a crashed run can be resumed and
// reconciled rather than lost.

// Every state, as a runtime array the type is derived from, so tooling that
// needs the list (scripts/gen-web-data.ts) reads it instead of copying it.
export const ALL_STATES = [
  "created",
  "quoted",
  "compliant",
  "opened",
  "funding",
  "funded",
  "verifying",
  "settling",
  "retrying",
  "settled",
  "reconciled",
  "completed",
  "recovering",
  "refund_pending",
  "refunded",
  "held",
  "failed",
] as const;

export type CorridorState = (typeof ALL_STATES)[number];

const NEXT: Record<CorridorState, readonly CorridorState[]> = {
  created: ["quoted", "failed"],
  quoted: ["compliant", "recovering", "failed"],
  compliant: ["opened", "recovering", "failed"],
  opened: ["funding", "verifying", "recovering", "failed"],
  funding: ["funded", "recovering", "failed"],
  funded: ["verifying", "recovering", "failed"],
  verifying: ["settling", "recovering", "failed"],
  settling: ["settled", "retrying", "recovering", "failed"],
  // A settle attempt failed BEFORE money moved, so going round again is safe.
  // This is the only state that may re-enter `verifying`.
  retrying: ["verifying", "recovering", "failed"],
  settled: ["reconciled", "recovering", "failed"],
  reconciled: ["completed", "failed"],
  completed: [],
  // Terminal-bound. `recovering` is entered when a payment cannot proceed —
  // including AFTER settlement, when reconcile fails and funds are already on
  // the chain — so it must never lead back to `settling`.
  //
  // These were one state until a property test walked the graph and found that
  // `settled -> recovering -> settling` was reachable: a path that would
  // re-submit a payment that had already gone out. The engine's control flow
  // never took it, but this table is the guard that exists to catch a
  // control-flow bug, and it would not have caught that one. Splitting the two
  // kinds of recovery makes the double-spend unreachable by construction rather
  // than by careful reading of run.ts.
  recovering: ["refund_pending", "refunded", "held", "failed"],
  // An anchor-driven refund has been requested and the answer has not come
  // back yet. Not terminal: money is still in motion, and a run parked here
  // must keep looking unfinished until the anchor confirms (`refunded`),
  // rejects or we give up waiting (`held`), or something else goes wrong
  // (`failed`).
  //
  // `refund_pending` inherits `recovering`'s contract in full: it is entered
  // after money has left, so every successor is terminal and `settling` is
  // unreachable from here by construction — the same double-spend guard the
  // comment above exists to explain, enforced by this table rather than by
  // careful reading of run.ts.
  refund_pending: ["refunded", "held", "failed"],
  refunded: [],
  held: [],
  failed: [],
};

export function canTransition(from: CorridorState, to: CorridorState): boolean {
  return NEXT[from].includes(to);
}

export const TERMINAL: ReadonlySet<CorridorState> = new Set([
  "completed",
  "refunded",
  "held",
  "failed",
]);

export function isTerminal(s: CorridorState): boolean {
  return TERMINAL.has(s);
}
