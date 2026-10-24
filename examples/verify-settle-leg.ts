// Proves the SETTLE LEG against real Stellar testnet, with no anchor required.
//
//   pnpm verify:settle
//
// What this does and does not establish matters, so be precise about it:
//
//   IT PROVES   @corridor/stellar's StellarSettlementSubmitter really does
//               build → sign (through the ExternalSigner port) → submit → poll
//               Horizon until the transaction is in a ledger, against the live
//               testnet network. The output is a transaction hash anyone can
//               look up.
//
//   IT DOES NOT prove a SEP-31 corridor works. There is no anchor here: no
//               SEP-38 quote, no SEP-12 KYC, no SEP-31 open/reconcile. Those
//               legs need a conformant receiving anchor — see `pnpm testnet`
//               and docs/operations.md §1.
//
// Both accounts are throwaway keypairs funded by friendbot, so this costs
// nothing and touches no real value. Settlement is in native XLM to avoid
// trustline/issuance setup; the code path under test is identical for a credit
// asset (see bridgeAsset() in @corridor/stellar).

import { Keypair } from "@stellar/stellar-sdk";
import { LocalKeypairSigner, StellarSettlementSubmitter } from "@corridor/stellar";
import { loadCorridor } from "@corridor/manifest";
import type { Corridor } from "@corridor/manifest";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const AMOUNT = process.env.AMOUNT ?? "12.5000000";

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(`friendbot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  if (!HORIZON.includes("testnet")) {
    console.error(
      `✗ refusing to run against ${HORIZON} — this script funds throwaway keys ` +
        `via friendbot and is testnet-only.`,
    );
    process.exit(3);
  }

  const loaded = loadCorridor(
    new URL("../corridors/reference.corridor.yaml", import.meta.url).pathname,
  );
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(1);
  }
  const corridor: Corridor = {
    ...loaded.value,
    settlement: { ...loaded.value.settlement, bridge_asset: "XLM", network: "testnet" },
  };

  const source = Keypair.random();
  const dest = Keypair.random();
  console.log(`source:  ${source.publicKey()}`);
  console.log(`dest:    ${dest.publicKey()}`);
  console.log("funding both via friendbot…");
  await Promise.all([fund(source.publicKey()), fund(dest.publicKey())]);

  const submitter = new StellarSettlementSubmitter({
    signer: new LocalKeypairSigner(source),
    horizonUrl: HORIZON,
  });

  console.log(`submitting ${AMOUNT} XLM…\n`);
  const res = await submitter.submit({
    to: dest.publicKey(),
    memo: "corridor-settle",
    amount: { asset: "XLM", amount: AMOUNT },
    corridor,
  });

  if (!res.ok) {
    console.error(`✗ ${res.error.code}: ${res.error.message}`);
    process.exit(1);
  }

  if (res.value.kind !== "stellar") {
    console.error(`Unexpected settlement kind: ${res.value.kind}`);
    process.exit(1);
  }

  const { stellarTxHash, ledger } = res.value;
  console.log("✓ settled on testnet");
  console.log(`  tx hash: ${stellarTxHash}`);
  console.log(`  ledger:  ${ledger}`);
  console.log(`  explorer: https://stellar.expert/explorer/testnet/tx/${stellarTxHash}`);

  // Re-read the transaction straight from Horizon rather than trusting our own
  // return value — the claim being made is "this is on the public ledger", so
  // the check should come from the ledger.
  const verify = (await (await fetch(`${HORIZON}/transactions/${stellarTxHash}`)).json()) as {
    successful?: boolean;
    ledger?: number;
    memo?: string;
  };
  console.log(
    `\nindependently confirmed via Horizon: successful=${verify.successful} ` +
      `ledger=${verify.ledger} memo=${verify.memo}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
