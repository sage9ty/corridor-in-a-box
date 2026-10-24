import { describe, expect, it } from "vitest";
import { runEngineDemoPayment } from "../web/lib/engine-demo";

let runNumber = 0;

function run(scenario: "happy" | "quote-expired" | "settle-fails" | "reconcile-stall") {
  return runEngineDemoPayment(
    "reference-testnet",
    "1.00",
    `web-engine-demo-${++runNumber}`,
    scenario,
  );
}

describe("web payment engine demo", () => {
  it("returns the real engine trail for a completed payment", async () => {
    const result = await run("happy");

    expect(result.ok).toBe(true);
    expect(result.state).toBe("completed");
    expect(result.trail).toEqual([
      "created",
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "reconciled",
      "completed",
    ]);
  });

  it("shows the engine's expired-quote failure path", async () => {
    const result = await run("quote-expired");

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("QUOTE_EXPIRED");
    expect(result.trail).toEqual(["created", "failed"]);
  });

  it("shows retries and recovery when settlement repeatedly fails", async () => {
    const result = await run("settle-fails");

    expect(result.ok).toBe(false);
    expect(result.state).toBe("refunded");
    expect(result.trail).toContain("retrying");
    expect(result.trail).toContain("recovering");
  });

  it("shows a held run when reconciliation stalls and refund fails", async () => {
    const result = await run("reconcile-stall");

    expect(result.ok).toBe(false);
    expect(result.state).toBe("held");
    expect(result.trail).toContain("recovering");
    expect(result.trail).toContain("held");
  });

  it("marks a completed engine replay without resubmitting", async () => {
    const key = `web-engine-demo-replay-${++runNumber}`;
    await runEngineDemoPayment("reference-testnet", "1.00", key, "happy");
    const replay = await runEngineDemoPayment("reference-testnet", "1.00", key, "happy");

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.trail).toEqual(["completed"]);
  });
});
