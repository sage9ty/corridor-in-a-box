# Bespoke HTTP-stub adapter (example)

A worked example of a **bespoke** `AnchorAdapter`: an anchor that speaks a
proprietary HTTP API instead of SEP-31.

| File                 | What it is                                                                  |
| -------------------- | --------------------------------------------------------------------------- |
| `adapter.ts`         | `HttpStubAdapter implements AnchorAdapter` — the whole adapter, ~200 lines. |
| `stub-api.ts`        | A fictional HTTP API served in-process by an injected `fetchImpl`.          |
| `stub.corridor.yaml` | A manifest for a fictional bespoke lane (`protocol: custom:http-stub`).     |

Run it end to end:

```sh
pnpm example:stub
```

which is `tsx examples/run-stub-adapter.ts` — it drives the real engine
(`quote → comply → open → gate → settle → reconcile`) against the stub anchor
and the mock submitter, and prints the trail.

## Everything here is fictional

No real anchor, host, endpoint or account appears in this directory. The
destination is `anchor.example` (RFC 2606 reserves `.example` for exactly
this), the routes are invented, the payout asset is a made-up ISO-4217 code,
and the Stellar-looking strings are shape-correct but meaningless. The example
demonstrates the _shape_ of a bespoke integration, not any anchor that exists.

`tests/http-stub-adapter.test.ts` enforces that: it fails if a URL in this
directory points at any host other than a reserved example domain.

## What the adapter demonstrates

- **A native quote.** The anchor prices the pair itself over its own API, so
  the manifest says `fx.quote_source: native` and the adapter reports
  `capabilities().quotes === ["native"]`. No SEP-38 quote server is involved.
- **Bespoke KYC.** `ensureCompliance` calls the partner's own compliance
  endpoint and reports `accepted` / `pending` / `rejected`. It is not SEP-12.
- **`stellar_payment` instructions.** The partner answers with a deposit
  account and a memo, which the adapter returns as `DepositInstructions` — so
  the on-chain leg still goes through the standard `StellarPaymentStrategy`.
- **Failing closed.** A malformed response, an HTTP error, or a manifest that
  names a different anchor than the adapter is bound to all produce a failure
  `Outcome` — never a throw, and never a guess.
- **Refusing what it cannot do.** `requestRefund` returns `REFUND_UNSUPPORTED`:
  this fictional API has no refund endpoint, and inventing one would be worse
  than saying so.

`docs/adapters.md` is the guide this example illustrates, and
`packages/adapter-kit/README.md` explains the conformance harness
(`runConformance`) that `tests/http-stub-adapter.test.ts` runs against it.
