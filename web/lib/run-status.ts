// What a payment run says about itself in words.
//
// The trail on /payments is drawn with colour, a tick and an opacity change, none
// of which reach a screen reader, and the outcome appears below the controls with
// nothing announcing it. These helpers produce the text for both: a status per
// step that does not depend on colour, and one sentence for the live region.
//
// Pure and self-contained on purpose (no imports from the rest of web/, structural
// types only) so the wording is unit-tested from the repo's root test suite.

export type StepStatus = "reached" | "failed" | "pending";

/** The parts of a run outcome these helpers read; `RunOutcome` satisfies it. */
export interface RunLike {
  ok: boolean;
  state: string;
  error?: { code: string; message: string };
  stellarTxHash?: string;
  idempotentReplay?: boolean;
}

/**
 * The state a failed run got to before dying: the last entry in the trail that
 * isn't the terminal "failed" marker itself.
 */
export function lastReachedBefore<S extends string>(reached: S[]): S | undefined {
  const withoutTerminal = reached.filter((s) => s !== "failed");
  return withoutTerminal[withoutTerminal.length - 1];
}

/** Where one step of the state machine stands, for the list and for its text. */
export function stepStatus<S extends string>(
  state: S,
  reached: S[],
  result: RunLike | null,
): StepStatus {
  // The step the run died on: the last state it reached before "failed".
  const failedAt = result && !result.ok ? lastReachedBefore(reached) : undefined;
  if (state === failedAt) return "failed";
  return reached.includes(state) ? "reached" : "pending";
}

/** Read out after a step's name, so its status is not carried by colour alone. */
export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  reached: "reached",
  failed: "failed here",
  pending: "not reached",
};

/**
 * The one sentence a live region announces for a run: nothing before the first
 * run, a short note while it walks the trail (so the trail's steps are not read
 * out one by one), and the outcome once it is known.
 */
export function announceRun<S extends string>(
  running: boolean,
  result: RunLike | null,
  reached: S[],
): string {
  if (running) return "Running payment…";
  if (!result) return "";

  const replay = result.idempotentReplay ? " (idempotent replay)" : "";
  if (result.ok) {
    const tx = result.stellarTxHash ? ` Stellar transaction ${result.stellarTxHash}.` : "";
    return `Payment ${result.state}${replay}.${tx}`;
  }

  const at = lastReachedBefore(reached);
  const where = at ? ` after ${at}` : "";
  const code = result.error?.code ? `${result.error.code}: ` : "";
  return `Payment failed${where}${replay}. ${code}${result.error?.message ?? "No further detail."}`;
}
