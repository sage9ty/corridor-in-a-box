// Check on-chain registry staleness for all tracked anchors.
//
//   pnpm registry:staleness [testanchor.stellar.org ...]
//
// Reads the staleness of each domain in contracts/anchors.json from the
// on-chain registry contract. Fails (exit 1) if any domain was never attested
// or if its attestation exceeds MAX_STALENESS_LEDGERS (default 34,560 ledgers,
// ~2 days at 5s per ledger).
//
// Workflow step:
// Run as the final verification step in .github/workflows/attest-anchors.yml on
// scheduled runs (`github.event_name == 'schedule'`). Emits a GitHub Actions
// `::error::` annotation per stale or unattested domain, ensuring scheduled
// runs fail fast if attestations stop updating on chain.

import { readFileSync } from "node:fs";
import {
  AnchorRegistry,
  findStale,
  MAX_STALENESS_LEDGERS,
  type StalenessRecord,
} from "@corridor/registry";

interface Deployments {
  [network: string]: {
    networkPassphrase: string;
    rpcUrl: string;
    registry: string | null;
    attester: string | null;
  };
}

function load<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

async function main(): Promise<void> {
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const cfg = load<Deployments>("../contracts/deployments.json")[network];
  if (!cfg?.registry) {
    console.error(`✗ no registry contract deployed on ${network}`);
    process.exit(1);
  }

  const threshold = process.env.MAX_STALENESS_LEDGERS
    ? parseInt(process.env.MAX_STALENESS_LEDGERS, 10)
    : MAX_STALENESS_LEDGERS;

  const domains =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : load<{ domains: string[] }>("../contracts/anchors.json").domains;

  const registry = new AnchorRegistry({
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.registry,
    networkPassphrase: cfg.networkPassphrase,
  });

  console.log(`checking registry staleness on ${network} (threshold: ${threshold} ledgers)\n`);

  const records: StalenessRecord[] = [];
  for (const domain of domains) {
    try {
      const age = await registry.staleness(domain);
      console.log(`  ${domain.padEnd(30)} ${age} ledgers ago`);
      records.push({ domain, ledgersOld: age });
    } catch {
      console.log(`  ${domain.padEnd(30)} never attested`);
      records.push({ domain, ledgersOld: null, neverAttested: true });
    }
  }

  const stale = findStale(records, threshold);
  if (stale.length > 0) {
    console.error(`\n✗ ${stale.length} domain(s) are stale or unattested:`);
    for (const s of stale) {
      if (s.reason === "never-attested") {
        console.error(
          `::error::domain ${s.domain} has never been attested in the on-chain registry`,
        );
      } else {
        console.error(
          `::error::domain ${s.domain} is stale: last attested ${s.ledgersOld} ledgers ago (threshold: ${s.threshold} ledgers)`,
        );
      }
    }
    process.exit(1);
  }

  console.log(
    `\n✓ all ${records.length} domain(s) are fresh (threshold: ${threshold} ledgers)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
