// Read the on-chain anchor registry through @corridor/registry.
//
//   pnpm registry:read
//
// Hits the deployed testnet contract for real — no mocks, no fixtures. The
// addresses come from contracts/deployments.json so this and the dashboard
// always read the same registry the attester writes to.

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

  console.log(`registry ${cfg.registry} on ${network}\n`);

  const domains = await registry.domains();
  if (domains.length === 0) {
    console.log("no attestations yet.");
    return;
  }

  for (const domain of domains) {
    const a = await registry.getAnchor(domain);
    const failed = a.probesRun.filter((p) => !a.probesPassed.includes(p));
    console.log(domain);
    console.log(`  advertises     ${a.seps.map((n) => `SEP-${n}`).join(", ")}`);
    console.log(`  probes passed  ${a.probesPassed.join(", ") || "none"}`);
    console.log(`  probes FAILED  ${failed.join(", ") || "none"}`);
    console.log(`  toml sha256    ${a.tomlHash.slice(0, 32)}…`);
    console.log(
      `  attested at    ledger ${a.attestedLedger} (${await registry.staleness(domain)} ledgers ago)`,
    );
    console.log(`  serves SEP-31  ${(await registry.servesSep31(domain)) ? "YES" : "NO"}`);
    console.log();
  }

  const live = await registry.liveSep31Anchors();
  console.log(
    `usable SEP-31 off-ramps (attested + fresh): ${live.length ? live.join(", ") : "none"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
