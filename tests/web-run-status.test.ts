import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STEP_STATUS_TEXT,
  announceRun,
  lastReachedBefore,
  stepStatus,
  type RunLike,
} from "../web/lib/run-status";

const ok: RunLike = { ok: true, state: "completed", stellarTxHash: "mocktx0001" };
const failed = (code: string, message: string): RunLike => ({
  ok: false,
  state: "failed",
  error: { code, message },
});

describe("lastReachedBefore", () => {
  it("is the last state before the terminal failed marker", () => {
    expect(lastReachedBefore(["created", "quoted", "failed"])).toBe("quoted");
  });

  it("ignores a trail that never got past the marker", () => {
    expect(lastReachedBefore(["failed"])).toBeUndefined();
    expect(lastReachedBefore([])).toBeUndefined();
  });
});

describe("stepStatus", () => {
  const trail = ["created", "quoted", "compliant"];

  it("marks what a run reached and what it did not, without needing colour", () => {
    expect(stepStatus("quoted", trail, ok)).toBe("reached");
    expect(stepStatus("settled", trail, ok)).toBe("pending");
  });

  it("marks the step a failed run died on, and only that one", () => {
    const run = failed("ANCHOR_UNAVAILABLE", "no SEP-31 server");
    const reached = [...trail, "failed"];

    expect(stepStatus("compliant", reached, run)).toBe("failed");
    expect(stepStatus("quoted", reached, run)).toBe("reached");
    expect(stepStatus("opened", reached, run)).toBe("pending");
  });

  it("does not mark a failure while the run is still in flight", () => {
    expect(stepStatus("compliant", trail, null)).toBe("reached");
  });

  it("has words for every status", () => {
    expect(STEP_STATUS_TEXT).toEqual({
      reached: "reached",
      failed: "failed here",
      pending: "not reached",
    });
  });
});

describe("announceRun", () => {
  it("says nothing before the first run", () => {
    expect(announceRun(false, null, [])).toBe("");
  });

  it("says one thing while the trail animates, not one thing per step", () => {
    const early = announceRun(true, null, []);
    const later = announceRun(true, null, ["created", "quoted", "compliant"]);

    expect(early).toBe("Running payment…");
    expect(later).toBe(early);
  });

  it("announces a completed run with its transaction", () => {
    expect(announceRun(false, ok, ["created", "completed"])).toBe(
      "Payment completed. Stellar transaction mocktx0001.",
    );
  });

  it("says when a run was an idempotent replay", () => {
    expect(announceRun(false, { ...ok, idempotentReplay: true }, [])).toBe(
      "Payment completed (idempotent replay). Stellar transaction mocktx0001.",
    );
  });

  it("announces a failure with the step it died on, its code and its message", () => {
    const run = failed("ANCHOR_UNAVAILABLE", "no SEP-31 transfer server configured");

    expect(announceRun(false, run, ["created", "quoted", "compliant", "failed"])).toBe(
      "Payment failed after compliant. ANCHOR_UNAVAILABLE: no SEP-31 transfer server configured",
    );
  });

  it("announces a failure that never started a trail", () => {
    const run = failed("REQUEST_FAILED", "could not reach the API");

    expect(announceRun(false, run, [])).toBe(
      "Payment failed. REQUEST_FAILED: could not reach the API",
    );
  });

  it("does not drop a failure that carries no error detail", () => {
    expect(announceRun(false, { ok: false, state: "failed" }, [])).toBe(
      "Payment failed. No further detail.",
    );
  });
});

describe("the payment form's controls are associated with their labels", () => {
  // A label with no `for` and a control with no id is not a label to a screen
  // reader. The page has no component tests, so this guards the wiring directly.
  const source = readFileSync(
    resolve(process.cwd(), "web/components/PaymentRunner.tsx"),
    "utf8",
  );

  it("gives every <label> an htmlFor", () => {
    const labels = source.match(/<label\b[^>]*>/g) ?? [];

    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const tag of labels) expect(tag, tag).toContain("htmlFor=");
  });

  it("gives every form control an id", () => {
    const controls = source.match(/<(?:input|select)\b[^>]*>/g) ?? [];

    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const tag of controls) expect(tag, tag).toMatch(/\bid=/);
  });

  it("keeps a live region for the outcome", () => {
    // <output> carries the implicit ARIA role "status", so either form is a live region.
    expect(source).toMatch(/role="status"|<output\b/);
    expect(source).toMatch(/aria-live="polite"/);
  });
});
