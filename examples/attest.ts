// Probe anchors and submit the results to the on-chain registry.
//
//   ATTESTER_SECRET=S... pnpm attest testanchor.stellar.org [more.example ...]
//   ATTESTER_SECRET=S... pnpm attest            # every domain in anchors.json
//
// This is the job the scheduled workflow runs. It probes for real and submits
// exactly what it found — the point of the registry is that nobody, including
// this script, gets to assert a capability that was not observed.
//
// The signing key must have been enrolled with `add_attester`. Reading the
// registry needs no key at all; see `pnpm registry:read`.

import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { probeAnchor, decodeProbes, decodeSeps } from "@corridor/probe";
import { AnchorAttester, AttesterContractError } from "@corridor/attester";

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
  if (!cfg?.attester) {
    console.error(`✗ no attester contract deployed on ${network}`);
    process.exit(1);
  }

  const secret = process.env.ATTESTER_SECRET;
  if (!secret) {
    console.error("✗ set ATTESTER_SECRET to an enrolled attester key");
    process.exit(2);
  }

  const domains =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : load<{ domains: string[] }>("../contracts/anchors.json").domains;

  const attester = new AnchorAttester({
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.attester,
    networkPassphrase: cfg.networkPassphrase,
    signer: Keypair.fromSecret(secret),
  });

  console.log(`attesting as ${attester.address} on ${network}`);
  console.log(`contract ${cfg.attester}\n`);

  let failures = 0;
  for (const domain of domains) {
    const result = await probeAnchor(domain);
    const passed = decodeProbes(result.probesPassed);
    const failed = decodeProbes(result.probesRun).filter((p) => !passed.includes(p));
    console.log(`${domain}`);
    console.log(
      `  advertises  ${
        decodeSeps(result.seps)
          .map((n) => `SEP-${n}`)
          .join(", ") || "none"
      }`,
    );
    console.log(`  passed      ${passed.join(", ") || "none"}`);
    console.log(`  failed      ${failed.join(", ") || "none"}`);

    const submitted = await attester.attest(result);
    if (submitted.ok) {
      console.log(
        `  ✓ attested  ${submitted.value.txHash} (ledger ${submitted.value.ledger})\n`,
      );
    } else {
      // A cooldown rejection is the system working, not a failure of the job —
      // don't fail the run over it.
      const cooldown = submitted.error.contractError === AttesterContractError.TooSoon;
      console.log(
        `  ${cooldown ? "•" : "✗"} ${submitted.error.code}: ${submitted.error.message}\n`,
      );
      if (!cooldown) failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`${failures} of ${domains.length} attestations failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
