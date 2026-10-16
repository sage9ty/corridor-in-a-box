import { describe, expect, it, vi } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { tomlHash } from "@corridor/probe";
import { tomlHashCheck } from "@corridor/stellar";
import type { GateContext } from "@corridor/engine";
import type { AttestationSource } from "@corridor/router";
import type { PaymentIntent } from "@corridor/types";

const DOMAIN = "anchor.example";
const TOML = 'VERSION = "2.0.0"\nDIRECT_PAYMENT_SERVER = "https://anchor.example/sep31"\n';

const intent: PaymentIntent = {
  idempotencyKey: "toml-hash-check",
  corridorId: "test",
  sender: { id: "sender" },
  recipient: { id: "recipient" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function corridor(domain = DOMAIN): Corridor {
  const parsed = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "source.example" } },
    dest: { name: "D", asset: "iso4217:ARS", endpoints: { home_domain: domain } },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  return parsed.value;
}

function context(domain = DOMAIN): GateContext {
  return {
    intent,
    corridor: corridor(domain),
    quote: {
      id: "quote-1",
      price: "1.0",
      expiresAt: Date.now() + 60_000,
      sourceAmount: { asset: "USDC", amount: "100.00" },
      destAmount: { asset: "ARS", amount: "100.00" },
      firm: true,
    },
    opened: { transactionId: "tx-1", depositAddress: "GDEPOSIT" },
    now: Date.now(),
    attempt: 0,
  };
}

function source(hash: string): AttestationSource {
  return {
    servesSep31: async () => true,
    staleness: async () => 0,
    tomlHash: async () => hash,
  };
}

const responseWith = (text: string, status = 200) => new Response(text, { status });

describe("tomlHash", () => {
  it("changes when only whitespace changes", () => {
    expect(tomlHash('VERSION = "2.0.0"\n')).not.toBe(tomlHash('VERSION  =  "2.0.0"\n'));
  });
});

describe("tomlHashCheck", () => {
  it("passes when the live TOML hash matches the attestation", async () => {
    const fetchImpl = vi.fn(async () => responseWith(TOML)) as unknown as typeof fetch;
    const result = await tomlHashCheck({ registry: source(tomlHash(TOML)), fetchImpl }).run(
      context(),
    );
    expect(result).toMatchObject({ name: "anchor.toml.hash", passed: true });
  });

  it("returns PRESETTLE_ANCHOR_DRIFT with safe prefixes when hashes differ", async () => {
    const attestedHash = tomlHash(TOML + "\n");
    const liveHash = tomlHash(TOML);
    const result = await tomlHashCheck({
      registry: source(attestedHash),
      fetchImpl: vi.fn(async () => responseWith(TOML)) as unknown as typeof fetch,
    }).run(context());

    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_ANCHOR_DRIFT");
    expect(result.detail).toContain(`attested=${attestedHash.slice(0, 10)}`);
    expect(result.detail).toContain(`live=${liveHash.slice(0, 10)}`);
    expect(result.detail).not.toContain(attestedHash);
    expect(result.detail).not.toContain(liveHash);
  });

  it("fails closed when fetch rejects", async () => {
    const result = await tomlHashCheck({
      registry: source(tomlHash(TOML)),
      fetchImpl: vi.fn(async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
    }).run(context());
    expect(result).toMatchObject({
      passed: false,
      code: "PRESETTLE_ANCHOR_DRIFT",
      detail: "stellar.toml fetch failed",
    });
  });

  it("allows an exactly listed unattested domain without registry or fetch access", async () => {
    const registry = source(tomlHash(TOML));
    const lookup = vi.spyOn(registry, "tomlHash");
    const fetchImpl = vi.fn(async () => responseWith(TOML)) as unknown as typeof fetch;
    const result = await tomlHashCheck({
      registry,
      fetchImpl,
      allowUnattestedDomains: [DOMAIN],
    }).run(context());
    expect(result).toMatchObject({ passed: true, detail: "unattested domain allowed" });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unsafe URL before fetch", async () => {
    const fetchImpl = vi.fn(async () => responseWith(TOML)) as unknown as typeof fetch;
    const result = await tomlHashCheck({
      registry: source(tomlHash(TOML)),
      fetchImpl,
    }).run(context("127.0.0.1"));
    expect(result).toMatchObject({ passed: false, code: "PRESETTLE_ANCHOR_DRIFT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
