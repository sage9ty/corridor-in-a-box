import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { CompositeGate, type GateCheck, type GateContext } from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: { max_retries: 2 },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "gate-test",
  corridorId: "test",
  sender: { id: "sender" },
  recipient: { id: "recipient" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function ctx(): GateContext {
  return {
    intent,
    corridor: corridor(),
    quote: {
      id: "quote-1",
      price: "1.0",
      expiresAt: Date.now() + 60_000,
      sourceAmount: { asset: "USDC", amount: "100.00" },
      destAmount: { asset: "ARS", amount: "100.00" },
      firm: true,
    },
    opened: {
      transactionId: "tx-1",
      instructions: { kind: "stellar_payment", to: "GDEPOSIT" },
      depositAddress: "GDEPOSIT",
    },
    now: Date.now(),
    attempt: 0,
  };
}

function passingCheck(name: string): GateCheck {
  return {
    name,
    async run() {
      return { name, passed: true, detail: "ok", durationMs: 1 };
    },
  };
}

function failingCheck(name: string): GateCheck {
  return {
    name,
    async run() {
      return {
        name,
        passed: false,
        code: "ANCHOR_UNAVAILABLE",
        detail: "not ready",
        durationMs: 1,
      };
    },
  };
}

function throwingCheck(name: string): GateCheck {
  return {
    name,
    async run() {
      throw new Error(`${name} blew up`);
    },
  };
}

function hangingCheck(name: string, ms: number): GateCheck {
  return {
    name,
    async run() {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { name, passed: true, detail: "eventually ok", durationMs: ms };
    },
  };
}

describe("CompositeGate", () => {
  it("passes when every check passes", async () => {
    const gate = new CompositeGate([passingCheck("a"), passingCheck("b")]);
    const { passed, results } = await gate.evaluate(ctx());
    expect(passed).toBe(true);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("fails overall when one check fails, but still reports every result", async () => {
    const gate = new CompositeGate([passingCheck("a"), failingCheck("b"), passingCheck("c")]);
    const { passed, results } = await gate.evaluate(ctx());
    expect(passed).toBe(false);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name).sort()).toEqual(["a", "b", "c"]);
    const b = results.find((r) => r.name === "b");
    expect(b?.passed).toBe(false);
    expect(b?.code).toBe("ANCHOR_UNAVAILABLE");
  });

  it("fails closed when a check throws, instead of rejecting the whole evaluation", async () => {
    const gate = new CompositeGate([passingCheck("a"), throwingCheck("b")]);
    const { passed, results } = await gate.evaluate(ctx());
    expect(passed).toBe(false);
    expect(results).toHaveLength(2);
    const b = results.find((r) => r.name === "b");
    expect(b?.passed).toBe(false);
    expect(b?.detail).toContain("blew up");
  });

  it("fails closed when a check exceeds timeoutMs", async () => {
    const gate = new CompositeGate([passingCheck("a"), hangingCheck("slow", 200)], {
      timeoutMs: 20,
    });
    const { passed, results } = await gate.evaluate(ctx());
    expect(passed).toBe(false);
    expect(results).toHaveLength(2);
    const slow = results.find((r) => r.name === "slow");
    expect(slow?.passed).toBe(false);
    expect(slow?.detail).toContain("exceeded 20ms");
  });

  it("results always contain every check, in an all-pass run too", async () => {
    const names = ["a", "b", "c", "d"];
    const gate = new CompositeGate(names.map((n) => passingCheck(n)));
    const { results } = await gate.evaluate(ctx());
    expect(results.map((r) => r.name).sort()).toEqual(names);
  });
});
