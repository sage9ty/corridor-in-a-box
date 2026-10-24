# @corridor/adapter-kit

Anchor adapter interfaces, mock adapters, and conformance testing harness for corridor-in-a-box.

## Overview

`@corridor/adapter-kit` defines the interface between the core payment engine and Stellar anchors (`AnchorAdapter`), standardizes capability discovery (`AdapterCapabilities`), and provides tools to verify third-party adapter implementations.

## Conformance Harness for Third-Party Adapters

When implementing a bespoke or third-party adapter for an anchor (e.g., custom OTC desk, regional payment aggregator, or specialized SEP implementation), you can verify that your adapter satisfies the engine's protocol requirements using `runConformance()`.

### Running Conformance Probes

```ts
import { runConformance } from "@corridor/adapter-kit";
import { parseCorridor } from "@corridor/manifest";
import { MyCustomAdapter } from "./my-custom-adapter";

const corridor = parseCorridor(manifestYaml).value;
const intent = {
  idempotencyKey: "test_key",
  corridorId: corridor.id,
  sender: { id: "sender_1" },
  recipient: { id: "recipient_1" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

// Execute read-only conformance probes
const report = await runConformance(new MyCustomAdapter(), { intent, corridor });

if (!report.passed) {
  console.error("Adapter failed conformance checks:");
  for (const result of report.results) {
    if (!result.passed) {
      console.error(`- ${result.name}: ${result.detail}`);
    }
  }
} else {
  console.log("All conformance checks passed!");
}
```

### Probes Evaluated

1. **Capabilities Well-Formed**: Confirms `adapter.capabilities()` exports valid protocols, quote kinds, KYC modes, settlement instructions, and refund behaviors.
2. **Quote Kinds Match Capabilities**: Confirms `requestQuote()` honors advertised quote types and returns valid future expiries or clean Outcomes without throwing.
3. **Compliance Status Known**: Confirms `ensureCompliance()` returns a recognized status (`accepted`, `pending`, or `rejected`) wrapped in an `Outcome`.
4. **Open Transaction Compatibility**: When `allowNetworkWrites: true` is passed, ensures `openTransaction()` outputs deposit instructions consistent with advertised capabilities.
5. **Safe Error Handling**: Verifies `getTransaction()` on unknown IDs returns failure `Outcome`s rather than throwing uncaught exceptions.
6. **Resilience to Incomplete Corridors**: Verifies all methods fail gracefully via `Outcome` when passed unexpected or malformed corridor parameters.

### Vitest Test Integration

In unit and integration test suites, use the `expectConformance` helper:

```ts
import { expectConformance } from "./tests/helpers/conformance";

it("passes adapter conformance", async () => {
  const report = await runConformance(adapter, { intent, corridor });
  expectConformance(report);
});
```
