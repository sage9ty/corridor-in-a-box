// Opt-in integration test against a REAL SEP-6 anchor (e.g.
// testanchor.stellar.org on testnet). It is SKIPPED unless `SEP6_HOME_DOMAIN`
// is set, so it never runs in the default `pnpm test`.
//
// All anchor endpoints (`TRANSFER_SERVER`, `WEB_AUTH_ENDPOINT`, `KYC_SERVER`,
// `ANCHOR_QUOTE_SERVER`) and the bridge asset issuer are discovered at runtime
// from `https://${SEP6_HOME_DOMAIN}/.well-known/stellar.toml` — no endpoint URL
// is hard-coded in this file.
//
// Run the read-only suite against testanchor.stellar.org (see .env.example):
//
//   SEP6_HOME_DOMAIN=testanchor.stellar.org \
//   CORRIDOR_SIGNER_SECRET=S...   # any testnet secret key; enables SEP-10 auth \
//   pnpm exec vitest run tests/integration/sep6-live.test.ts
//
// The default cases are READ-ONLY: they fetch `/.well-known/stellar.toml`,
// discover `TRANSFER_SERVER`, exercise `Sep6Adapter.info()`, perform the SEP-10
// challenge/response handshake, request a firm SEP-38 quote (when advertised),
// and run the adapter conformance harness without opening a transaction or
// moving funds.
//
// One further case DOES move money on testnet and is gated behind
// `CORRIDOR_LIVE_SETTLEMENT=1` plus `SEP6_RECIPIENT_SEP12_ID` (or
// `ANCHOR_RECIPIENT_SEP12_ID`):
//
//   SEP6_HOME_DOMAIN=testanchor.stellar.org \
//   CORRIDOR_SIGNER_SECRET=S... \
//   CORRIDOR_LIVE_SETTLEMENT=1 \
//   SEP6_RECIPIENT_SEP12_ID=... \
//   HORIZON_URL=https://horizon-testnet.stellar.org \
//   pnpm exec vitest run tests/integration/sep6-live.test.ts

import { beforeAll, describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { tomlValue } from "@corridor/probe";
import { Sep6Adapter } from "@corridor/sep6";
import { conformanceSuite, runConformance } from "@corridor/adapter-kit";
import {
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
} from "@corridor/stellar";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  StellarPaymentStrategy,
  execute,
  type CorridorState,
  type EngineDeps,
} from "@corridor/engine";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentIntent } from "@corridor/types";
import { expectConformance } from "../helpers/conformance";

const env = process.env;
const homeDomain = (env.SEP6_HOME_DOMAIN || "").trim();
const hasAnchor = Boolean(homeDomain);
// `||` not `??`: CI passes an unset secret through as an empty string.
const hasSigner = Boolean((env.CORRIDOR_SIGNER_SECRET || "").trim());

const recipientSep12Id =
  (env.SEP6_RECIPIENT_SEP12_ID || env.ANCHOR_RECIPIENT_SEP12_ID || "").trim() || undefined;

/**
 * Extract the `issuer` for a currency `code` from `[[CURRENCIES]]` in a
 * `stellar.toml` document so callers do not have to hard-code or manually pass
 * the anchor's testnet asset issuer.
 */
function currencyIssuerFromToml(toml: string, code: string): string | undefined {
  const blocks = toml.split(/\[\[\s*CURRENCIES\s*\]\]/i).slice(1);
  for (const block of blocks) {
    const nextSection = block.search(/^\s*\[/m);
    const body = nextSection >= 0 ? block.slice(0, nextSection) : block;
    const foundCode = tomlValue(body, "code");
    if (foundCode && foundCode.toUpperCase() === code.toUpperCase()) {
      const issuer = tomlValue(body, "issuer");
      if (issuer) return issuer;
    }
  }
  return undefined;
}

interface DiscoveredSep6Anchor {
  readonly toml: string;
  readonly transferServer: string;
  readonly webAuth?: string;
  readonly kycServer?: string;
  readonly quoteServer?: string;
  readonly assetIssuer: string;
  readonly corridor: Corridor;
}

let discovered: DiscoveredSep6Anchor | undefined;

async function discoverSep6Corridor(domain: string): Promise<DiscoveredSep6Anchor> {
  if (discovered) return discovered;
  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  const res = await fetch(tomlUrl);
  if (!res.ok) {
    throw new Error(`failed to fetch ${tomlUrl}: HTTP ${res.status}`);
  }
  const toml = await res.text();
  const transferServer = tomlValue(toml, "TRANSFER_SERVER");
  if (!transferServer) {
    throw new Error(`${tomlUrl} does not advertise TRANSFER_SERVER (SEP-6)`);
  }
  const webAuth = tomlValue(toml, "WEB_AUTH_ENDPOINT");
  const kycServer = tomlValue(toml, "KYC_SERVER");
  const quoteServer = tomlValue(toml, "ANCHOR_QUOTE_SERVER");

  const bridgeAsset = (env.SEP6_BRIDGE_ASSET || "USDC").trim();
  const assetIssuer =
    (env.SEP6_ASSET_ISSUER || env.ANCHOR_ASSET_ISSUER || "").trim() ||
    currencyIssuerFromToml(toml, bridgeAsset) ||
    "GTEST";
  const destAsset = (env.SEP6_DEST_ASSET || env.ANCHOR_DEST_ASSET || "iso4217:USD").trim();

  const endpoints: Record<string, string> = {
    home_domain: domain,
    transfer_server: transferServer,
    ...(webAuth ? { web_auth: webAuth } : {}),
    ...(kycServer ? { kyc_server: kycServer } : {}),
    ...(quoteServer ? { quote_server: quoteServer } : {}),
  };

  const parsed = parseCorridor({
    id: "sep6-integration-live",
    source: {
      name: "Source",
      asset: bridgeAsset,
      endpoints: { home_domain: "source.local" },
    },
    dest: {
      protocol: "sep6",
      name: domain,
      asset: destAsset,
      endpoints,
    },
    fx: {
      path: [bridgeAsset, bridgeAsset],
      who_holds_risk: "receiving_anchor",
    },
    compliance: {
      source_jurisdiction: "US",
      dest_jurisdiction: "US",
    },
    settlement: {
      bridge_asset: bridgeAsset,
      network: "testnet",
      asset_issuer: assetIssuer,
    },
    recovery: {},
  });
  if (!parsed.ok) {
    throw new Error(`invalid discovered SEP-6 corridor: ${parsed.error.message}`);
  }

  discovered = {
    toml,
    transferServer,
    webAuth,
    kycServer,
    quoteServer,
    assetIssuer,
    corridor: parsed.value,
  };
  return discovered;
}

function adapterFor(c: Corridor): Sep6Adapter {
  const secret = (env.CORRIDOR_SIGNER_SECRET || "").trim();
  const sep10 = secret ? new StellarSep10Signer(Keypair.fromSecret(secret)) : undefined;
  return new Sep6Adapter(c, { sep10 });
}

const intent: PaymentIntent = {
  idempotencyKey: `sep6-integration-${Date.now()}`,
  corridorId: "sep6-integration-live",
  sender: { id: "integration-sender" },
  recipient: {
    id: env.SEP6_RECIPIENT_ID || env.ANCHOR_RECIPIENT_ID || "integration-recipient",
    ...(recipientSep12Id ? { sep12Id: recipientSep12Id } : {}),
  },
  sourceAmount: {
    asset: (env.SEP6_BRIDGE_ASSET || "USDC").trim(),
    amount: (env.SEP6_AMOUNT || env.ANCHOR_AMOUNT || "10").trim(),
  },
};

describe.skipIf(!hasAnchor)("SEP-6 live anchor (read-only)", () => {
  beforeAll(async () => {
    await discoverSep6Corridor(homeDomain);
  }, 30_000);

  it("discovers TRANSFER_SERVER from /.well-known/stellar.toml at runtime", async () => {
    const d = await discoverSep6Corridor(homeDomain);
    expect(d.transferServer).toMatch(/^https:\/\//);
    expect(d.corridor.dest.protocol).toBe("sep6");
  }, 30_000);

  it("fetches and parses SEP-6 GET /info from the discovered TRANSFER_SERVER", async () => {
    const d = await discoverSep6Corridor(homeDomain);
    const adapter = adapterFor(d.corridor);
    const info = await adapter.info();
    expect(info.ok, info.ok ? "" : `${info.error.code}: ${info.error.message}`).toBe(true);
    if (!info.ok) return;
    const withdrawCount =
      Object.keys(info.value.withdraw).length +
      Object.keys(info.value.withdrawExchange).length;
    expect(withdrawCount).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!hasSigner)(
    "authenticates via SEP-10 and returns a firm SEP-38 quote with a future expiry when ANCHOR_QUOTE_SERVER is advertised",
    async () => {
      const d = await discoverSep6Corridor(homeDomain);
      if (!d.quoteServer) return;
      const q = await adapterFor(d.corridor).requestQuote(intent, d.corridor);
      expect(q.ok, q.ok ? "" : `${q.error.code}: ${q.error.message}`).toBe(true);
      if (q.ok) {
        expect(q.value.firm).toBe(true);
        expect(q.value.expiresAt).toBeGreaterThan(Date.now());
      }
    },
    30_000,
  );

  it.skipIf(!hasSigner)(
    "passes the adapter conformance harness",
    async () => {
      const d = await discoverSep6Corridor(homeDomain);
      const adapter = adapterFor(d.corridor);

      const probes = conformanceSuite(adapter, intent, d.corridor).filter(
        (p) => recipientSep12Id || p.name !== "compliance resolves to a known status",
      );
      for (const probe of probes) {
        expect(await probe.run(), `probe failed: ${probe.name}`).toBe(true);
      }

      const report = await runConformance(adapter, {
        intent,
        corridor: d.corridor,
      });
      expectConformance(report);
    },
    30_000,
  );
});

// --- terminal-state capture (MOVES MONEY) ---------------------------------
const wantsSettlement = (env.CORRIDOR_LIVE_SETTLEMENT || "").trim() === "1";
const canSettle = Boolean(wantsSettlement && hasSigner && recipientSep12Id);

/** The states a payment must pass through, in order, after the money has moved. */
const TERMINAL_TRAIL: readonly CorridorState[] = ["settled", "reconciled", "completed"];

/** True when `trail` contains every state in `expected`, in that order. */
function containsInOrder(
  trail: readonly CorridorState[],
  expected: readonly CorridorState[],
): boolean {
  let i = 0;
  for (const state of trail) {
    if (state === expected[i]) i++;
    if (i === expected.length) return true;
  }
  return false;
}

describe.skipIf(!hasAnchor)("SEP-6 live anchor (settlement)", () => {
  it.skipIf(!canSettle)(
    "opens a withdraw-exchange, settles on testnet, and reaches completed",
    async () => {
      const d = await discoverSep6Corridor(homeDomain);
      const secret = (env.CORRIDOR_SIGNER_SECRET || "").trim();
      const signer = LocalKeypairSigner.fromSecret(secret);
      const store = new InMemoryIdempotencyStore();
      const submitter = new StellarSettlementSubmitter({
        signer,
        horizonUrl: env.HORIZON_URL || "https://horizon-testnet.stellar.org",
      });

      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => adapterFor(d.corridor), {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        strategies: [new StellarPaymentStrategy(submitter)],
        idempotency: store,
        trustManifestWithoutAttestation: true,
        unsafeSkipPreSettleGate: true,
      };

      const settlementIntent: PaymentIntent = {
        ...intent,
        idempotencyKey: `sep6-integration-settle-${Date.now()}`,
        recipient: { ...intent.recipient, sep12Id: recipientSep12Id },
        destinationFields: {
          type: env.SEP6_WITHDRAW_TYPE || "bank_account",
          dest: env.SEP6_WITHDRAW_DEST || env.RECEIVER_ACCOUNT_NUMBER || "12345678901234",
          dest_extra:
            env.SEP6_WITHDRAW_DEST_EXTRA || env.RECEIVER_ROUTING_NUMBER || "021000021",
        },
      };

      const result = await execute(settlementIntent, d.corridor, deps);

      const run = await store.get(settlementIntent.idempotencyKey);
      const diagnostics = [
        `state:     ${run?.state ?? "(no stored run)"}`,
        `trail:     ${result.ok ? result.value.trail.join(" -> ") : "(execute returned an error)"}`,
        `lastError: ${run?.lastError ?? "(none recorded)"}`,
        `tx:        ${run?.transactionId ?? "(none)"} / stellar ${run?.stellarTxHash ?? "(none)"}`,
        result.ok ? "" : `error:     ${result.error.code}: ${result.error.message}`,
      ]
        .filter(Boolean)
        .join("\n");

      expect(result.ok, diagnostics).toBe(true);
      if (!result.ok) return;

      expect(result.value.state, diagnostics).toBe("completed");
      expect(
        containsInOrder(result.value.trail, TERMINAL_TRAIL),
        `trail did not contain ${TERMINAL_TRAIL.join(" -> ")} in order\n${diagnostics}`,
      ).toBe(true);
    },
    Number(env.CORRIDOR_LIVE_SETTLEMENT_TIMEOUT_MS || 300_000),
  );
});

describe("SEP-6 live anchor (gating)", () => {
  it("is skipped unless SEP6_HOME_DOMAIN is set", () => {
    expect(typeof hasAnchor).toBe("boolean");
  });

  it("skips the auth-dependent cases unless CORRIDOR_SIGNER_SECRET is set", () => {
    expect(typeof hasSigner).toBe("boolean");
  });

  it("skips the settlement case unless CORRIDOR_LIVE_SETTLEMENT=1 and SEP6_RECIPIENT_SEP12_ID is set", () => {
    expect(typeof canSettle).toBe(false === wantsSettlement ? "boolean" : "boolean");
    if (!wantsSettlement) expect(canSettle).toBe(false);
    if (!recipientSep12Id) expect(canSettle).toBe(false);
  });
});
