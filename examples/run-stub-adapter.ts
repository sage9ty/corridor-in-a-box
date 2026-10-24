// Runnable end-to-end demo of a BESPOKE adapter. Run with: pnpm example:stub
//
// It wires the fictional HTTP-stub adapter + mock submitter + static router,
// loads the stub manifest, and runs a full payment through the engine. The
// orchestration is REAL; only the anchor's HTTP API and the on-chain submit
// are faked.
//
// This is the same engine run as `pnpm example` (the SEP-31 mock), with one
// thing changed: the receiving anchor speaks a proprietary HTTP API instead of
// SEP-31, so it is reached through a custom `AnchorAdapter` and the manifest
// declares `protocol: custom:http-stub`. No engine code is involved in the
// difference — that is the whole point of the adapter seam.
//
// Nothing here touches the network: the anchor's API is served in-process by
// `createStubFetchImpl()`, and the settlement leg goes to `createMockSubmitter()`.
//
// `docs/adapters.md` is the guide this example illustrates.

import { fileURLToPath } from "node:url";
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
import { HttpStubAdapter, bespokeBaseUrl } from "./adapters/http-stub/adapter";
import { createStubFetchImpl } from "./adapters/http-stub/stub-api";

const manifestPath = fileURLToPath(
  new URL("./adapters/http-stub/stub.corridor.yaml", import.meta.url),
);

async function main(): Promise<void> {
  const loaded = loadCorridor(manifestPath);
  if (!loaded.ok) {
    console.error(`manifest error: ${loaded.error.message}`);
    process.exit(1);
  }
  const corridor = loaded.value;

  const baseUrl = bespokeBaseUrl(corridor);
  if (!baseUrl) {
    console.error("manifest error: the dest anchor declares no base_url");
    process.exit(1);
  }

  const audit = new InMemoryAuditLog();
  const stubAdapter = new HttpStubAdapter({
    baseUrl,
    fetchImpl: createStubFetchImpl(),
  });
  const deps = {
    resolver: new StaticRouteResolver(() => stubAdapter, {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    audit,
    trustManifestWithoutAttestation: true,
    gate: defaultSep31Gate(),
  };

  const intent: PaymentIntent = {
    idempotencyKey: "stub-demo-0001",
    corridorId: corridor.id,
    sender: { id: "sender-1", jurisdiction: "US" },
    recipient: { id: "recipient-1", jurisdiction: "US" },
    // Deliberately small: a lane with no canary proof is capped by the engine's
    // unproven canary cap (10 by default), and this fictional lane has none.
    sourceAmount: { asset: "USDC", amount: "5.00" },
  };

  console.log(`running corridor "${corridor.id}" with intent ${intent.idempotencyKey}\n`);

  const result = await execute(intent, corridor, deps);

  if (result.ok) {
    console.log("✓ payment completed");
    console.log(`  state:       ${result.value.state}`);
    console.log(`  stellar tx:  ${result.value.stellarTxHash}`);
    console.log(`  trail:       ${result.value.trail.join(" -> ")}`);
    console.log(`  audit:       ${audit.entries.length} transitions recorded`);
  } else {
    console.log(`✗ payment failed: ${result.error.code} — ${result.error.message}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
