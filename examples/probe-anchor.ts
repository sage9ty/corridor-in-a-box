// Probe a live anchor and print the facts an attestation would carry.
//
//   pnpm probe:anchor testanchor.stellar.org
//
// A thin CLI over @corridor/probe. The probing itself lives in the package so
// the scheduled attester job and this command cannot drift apart — an
// attestation submitted on chain must be produced by exactly the logic you can
// inspect here.

import {
  decodeProbes,
  decodeSeps,
  formatProbeResultJson,
  parseProbeArgs,
  probeAnchor,
} from "@corridor/probe";

async function main(): Promise<void> {
  const { domain, json } = parseProbeArgs(process.argv.slice(2));
  if (!domain) {
    console.error("usage: pnpm probe:anchor <home-domain> [--json]");
    process.exit(2);
  }

  if (!json) {
    console.log(`probing ${domain}\n`);
  }
  const r = await probeAnchor(domain);

  if (json) {
    console.log(formatProbeResultJson(r));
    return;
  }

  for (const o of r.outcomes) {
    console.log(`  ${o.passed ? "✓" : "✗"} ${o.probe.padEnd(13)} ${o.detail}`);
  }

  const advertised = decodeSeps(r.seps);
  const failed = decodeProbes(r.probesRun).filter(
    (p) => !decodeProbes(r.probesPassed).includes(p),
  );

  console.log(`\n--- attestation for ${r.domain} ---`);
  console.log(`  advertises     ${advertised.map((n) => `SEP-${n}`).join(", ") || "none"}`);
  console.log(`  probes passed  ${decodeProbes(r.probesPassed).join(", ") || "none"}`);
  console.log(`  probes FAILED  ${failed.join(", ") || "none"}`);
  console.log(`  toml_hash      ${r.tomlHash}`);
  console.log(`\n  seps=${r.seps} probes_run=${r.probesRun} probes_passed=${r.probesPassed}`);
  console.log(`\nSubmit with: pnpm attest ${domain}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
