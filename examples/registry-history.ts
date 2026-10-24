// Read the on-chain anchor attestation history through @corridor/registry.
//
//   pnpm registry:history <domain>
//
// Hits the deployed testnet contract for real — no mocks, no fixtures.
// The addresses come from contracts/deployments.json.

import { readFileSync } from "node:fs";
import { AnchorRegistry } from "@corridor/registry";

interface Deployments {
  [network: string]: {
    networkPassphrase: string;
    rpcUrl: string;
    registry: string | null;
    attester: string | null;
  };
}

async function main(): Promise<void> {
  const domain = process.argv[2];
  if (!domain) {
    console.error("usage: pnpm registry:history <home-domain>");
    process.exit(2);
  }

  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const deployments = JSON.parse(
    readFileSync(new URL("../contracts/deployments.json", import.meta.url), "utf8"),
  ) as Deployments;

  const cfg = deployments[network];
  if (!cfg?.registry) {
    console.error(`✗ no registry deployed on ${network} (see contracts/deployments.json)`);
    process.exit(1);
  }

  const registry = new AnchorRegistry({
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.registry,
    networkPassphrase: cfg.networkPassphrase,
  });

  const history = await registry.history(domain);

  console.log(`attestation history for ${domain} on ${network} (${cfg.registry})`);
  console.log(
    `covered ledger range: ${history.earliestLedgerCovered}..${history.latestLedger} (oldest available: ${history.oldestLedger})\n`,
  );

  if (history.attestations.length === 0) {
    console.log("no attestation events found in covered ledger range.");
    return;
  }

  for (const a of history.attestations) {
    const failed = a.probesRun.filter((p) => !a.probesPassed.includes(p));
    console.log(`ledger ${a.attestedLedger}:`);
    console.log(`  attester:      ${a.attester || "unknown"}`);
    console.log(`  toml sha256:   ${a.tomlHash ? a.tomlHash.slice(0, 32) + "…" : "none"}`);
    console.log(`  seps:          ${a.seps.map((n) => `SEP-${n}`).join(", ") || "none"}`);
    console.log(`  probes passed: ${a.probesPassed.join(", ") || "none"}`);
    console.log(`  probes failed: ${failed.join(", ") || "none"}`);
    console.log();
  }
}

void main().catch((e) => {
  console.error(`✗ error fetching history: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
