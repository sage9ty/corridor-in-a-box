// The bespoke HTTP-stub adapter is the worked example the docs point at, so it
// is tested like one: the conformance harness has to pass, the engine has to
// drive it to `completed`, and the example must not name a real anchor.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runConformance } from "@corridor/adapter-kit";
import { loadCorridor } from "@corridor/manifest";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  defaultSep31Gate,
  execute,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";
import { HttpStubAdapter, bespokeBaseUrl } from "../examples/adapters/http-stub/adapter";
import { createStubFetchImpl } from "../examples/adapters/http-stub/stub-api";
import { expectConformance } from "./helpers/conformance";

const EXAMPLE_DIR = fileURLToPath(new URL("../examples/adapters/http-stub/", import.meta.url));
const MANIFEST_PATH = join(EXAMPLE_DIR, "stub.corridor.yaml");

const loaded = loadCorridor(MANIFEST_PATH);
if (!loaded.ok) throw new Error(`stub manifest failed to load: ${loaded.error.message}`);
const CORRIDOR = loaded.value;
const declaredBaseUrl = bespokeBaseUrl(CORRIDOR);
if (!declaredBaseUrl) throw new Error("stub manifest declares no base_url");
// A plain `string`: narrowing a module-level const does not reach the helper functions below.
const BASE_URL: string = declaredBaseUrl;

const INTENT: PaymentIntent = {
  idempotencyKey: "stub-test-0001",
  corridorId: CORRIDOR.id,
  sender: { id: "sender-1", jurisdiction: "US" },
  recipient: { id: "recipient-1", jurisdiction: "US" },
  sourceAmount: { asset: "USDC", amount: "5.00" },
};

function adapter(opts: { pollsBeforeSettled?: number } = {}): HttpStubAdapter {
  return new HttpStubAdapter({
    baseUrl: BASE_URL,
    fetchImpl: createStubFetchImpl(opts),
  });
}

describe("HttpStubAdapter", () => {
  it("advertises native quotes, bespoke KYC and stellar_payment settlement", () => {
    const caps = adapter().capabilities();
    expect(caps.quotes).toEqual(["native"]);
    expect(caps.kyc).toBe("bespoke");
    expect(caps.settlement).toEqual(["stellar_payment"]);
    expect(caps.refunds).toBe("none");
  });

  it("passes the adapter conformance harness", async () => {
    const report = await runConformance(
      adapter(),
      { intent: INTENT, corridor: CORRIDOR },
      {
        allowNetworkWrites: true,
      },
    );
    expectConformance(report);
  });

  it("opens a transaction with stellar_payment instructions", async () => {
    const a = adapter();
    const quote = await a.requestQuote(INTENT, CORRIDOR);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;

    const opened = await a.openTransaction(INTENT, quote.value, CORRIDOR);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.instructions.kind).toBe("stellar_payment");
  });

  it("refuses to refund, because this API has no refund endpoint", async () => {
    const result = await adapter().requestRefund(
      "stub_order_1",
      {
        asset: "USDC",
        amount: "5.00",
      },
      "test",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REFUND_UNSUPPORTED");
  });

  it("fails closed when the manifest names a different anchor", async () => {
    const mismatched = new HttpStubAdapter({
      baseUrl: "https://other.example",
      fetchImpl: createStubFetchImpl(),
    });
    const result = await mismatched.requestQuote(INTENT, CORRIDOR);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MANIFEST_INVALID");
  });

  it("drives a payment through the engine to completed", async () => {
    const audit = new InMemoryAuditLog();
    const stubAdapter = adapter();
    const deps = {
      resolver: new StaticRouteResolver(() => stubAdapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      trustManifestWithoutAttestation: true,
      gate: defaultSep31Gate(),
      sleep: async () => {},
    };

    const result = await execute(INTENT, CORRIDOR, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("completed");
    expect(result.value.trail).toContain("completed");
    expect(result.value.stellarTxHash).toBeDefined();
    expect(audit.entries.length).toBeGreaterThan(0);
  });
});

describe("the http-stub example", () => {
  function filesIn(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? filesIn(full) : [full];
    });
  }

  it("names no real anchor: every URL in the example is a reserved example host", () => {
    const allowed = new Set([
      "anchor.example",
      "sender.example",
      "other.example",
      "example.com",
      "example.org",
      "example.net",
      "localhost",
    ]);
    const files = [
      ...filesIn(EXAMPLE_DIR),
      fileURLToPath(new URL("../examples/run-stub-adapter.ts", import.meta.url)),
    ];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/https?:\/\/([^\s"'`/)]+)/g)) {
        expect(
          allowed.has(match[1]),
          `${file} references the non-example host "${match[1]}"`,
        ).toBe(true);
      }
    }
  });

  it("declares the bespoke protocol in its manifest", () => {
    expect(CORRIDOR.dest.protocol).toBe("custom:http-stub");
    expect(BASE_URL).toBe("https://anchor.example");
  });
});
