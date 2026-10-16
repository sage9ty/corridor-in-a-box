import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { quoteWindowCheck, type GateContext } from "@corridor/engine";
import type { Quote } from "@corridor/adapter-kit";

// Fixed clock: every case states its arithmetic relative to this, so nothing
// here can flake on a slow CI worker.
const NOW = 1_900_000_000_000;

function corridorWithMargin(marginSeconds: number, ttlSeconds = 120): Corridor {
  const r = parseCorridor({
    id: "t",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: {
      path: ["ARS", "USDC", "ARS"],
      who_holds_risk: "receiving_anchor",
      quote_ttl_seconds: ttlSeconds,
      min_quote_remaining_seconds: marginSeconds,
    },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "testnet", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error(`fixture invalid: ${JSON.stringify(r.error)}`);
  return r.value;
}

function ctxWith(quote: Partial<Quote>, marginSeconds = 45): GateContext {
  return {
    intent: {
      idempotencyKey: "k1",
      corridorId: "t",
      sender: { id: "sender-1" },
      recipient: { id: "recip-1" },
      sourceAmount: { asset: "USDC", amount: "100" },
    },
    corridor: corridorWithMargin(marginSeconds),
    quote: {
      id: "q1",
      sourceAmount: { asset: "USDC", amount: "100" },
      destAmount: { asset: "iso4217:ARS", amount: "10000" },
      price: "100",
      expiresAt: NOW + 60_000,
      firm: true,
      ...quote,
    },
    opened: {
      transactionId: "tx-1",
      depositAddress: "GDEST",
      memo: "memo123",
      memoType: "text",
    },
    now: NOW,
    attempt: 1,
  };
}

describe("quoteWindowCheck (quote.window)", () => {
  it("has the name 'quote.window'", () => {
    expect(quoteWindowCheck().name).toBe("quote.window");
  });

  it("passes when remaining time exceeds the margin", async () => {
    const result = await quoteWindowCheck().run(ctxWith({ expiresAt: NOW + 46_000 }, 45));
    expect(result.passed).toBe(true);
    expect(result.name).toBe("quote.window");
    expect(result.detail).toContain("46s left");
  });

  it("passes when remaining time equals the margin exactly", async () => {
    const result = await quoteWindowCheck().run(ctxWith({ expiresAt: NOW + 45_000 }, 45));
    expect(result.passed).toBe(true);
  });

  it("fails when remaining time is below the margin", async () => {
    // 2s left is exactly the incident shape from the issue: alive now,
    // dead before Horizon confirmation could possibly land.
    const result = await quoteWindowCheck().run(ctxWith({ expiresAt: NOW + 2_000 }, 45));
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_QUOTE_WINDOW");
    expect(result.detail).toContain("below the 45s settle+confirm margin");
  });

  it("fails when the quote has already expired", async () => {
    const result = await quoteWindowCheck().run(ctxWith({ expiresAt: NOW - 1_000 }, 45));
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_QUOTE_WINDOW");
    expect(result.detail).toContain("expired");
  });

  it("passes a non-firm quote as indicative", async () => {
    // Even one that would fail the window if it were firm.
    const result = await quoteWindowCheck().run(ctxWith({ firm: false, expiresAt: NOW - 1 }));
    expect(result.passed).toBe(true);
    expect(result.detail).toBe("indicative quote");
  });

  it("refuses at a later attempt's evaluation once backoff ate the window", async () => {
    // The retry-loop shape: the same quote passes at attempt 1, then a
    // backoff consumes the window and the next evaluation refuses. Until the
    // engine wires the gate into execute() this is the check-level pin of
    // that scenario.
    const check = quoteWindowCheck();
    const expiresAt = NOW + 50_000;
    const first = await check.run({ ...ctxWith({ expiresAt }, 45), now: NOW, attempt: 1 });
    expect(first.passed).toBe(true);
    const second = await check.run({
      ...ctxWith({ expiresAt }, 45),
      now: NOW + 30_000,
      attempt: 2,
    });
    expect(second.passed).toBe(false);
    expect(second.code).toBe("PRESETTLE_QUOTE_WINDOW");
  });
});
