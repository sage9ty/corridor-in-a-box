# RFC 0001: Protocol-agnostic corridors

- Status: proposed
- Issue: [#178](https://github.com/ezedike-evan/corridor-in-a-box/issues/178)
- Depends on: [#179](https://github.com/ezedike-evan/corridor-in-a-box/issues/179), [#182](https://github.com/ezedike-evan/corridor-in-a-box/issues/182)

## Summary

Keep the engine as the middleman and state-machine owner, but make the protocol on each side explicit in the manifest and move protocol-specific work behind adapters and strategies. The current SEP-31 lane remains the default-compatible first implementation. SEP-6 and bespoke integrations can be added incrementally without making their assumptions global.

## Vocabulary

- **Protocol**: the contract between a wallet/operator and an anchor (`sep31`, `sep6`, or `custom:<id>`).
- **Adapter**: implementation of the engine-facing anchor port for one protocol or bespoke API.
- **Capability**: an explicit statement of operations and settlement modes an adapter supports; absence means unsupported.
- **Settlement kind**: how value leaves the operator (`stellar_payment`, `claimable_balance`, or `adapter_reported`).
- **Quote source**: SEP-38, adapter-native, or an explicitly configured external provider.
- **Compliance method**: SEP-12, inline protocol fields, or a custom provider. PII remains outside engine persistence and logs.

## Verb mapping

| Engine verb | SEP-31                                                                         | SEP-6 (`withdraw-exchange`)                                                                        | Bespoke HTTP API                                                              | SEP-24                                                                                      |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| quote       | SEP-38 firm quote, bound to the transaction                                    | SEP-38 with `context=sep6`, otherwise adapter `/price`                                             | Adapter-native firm quote or configured external provider                     | Not an unattended quote: the interactive flow needs a user session                          |
| comply      | SEP-10 auth and SEP-12 KYC handoff                                             | SEP-10 and SEP-12 when advertised; otherwise fields required by `/withdraw`                        | Adapter-defined KYC/compliance port                                           | Hosted interactive KYC; excluded from unattended execution                                  |
| open        | SEP-31 `POST /transactions`; return deposit address and memo                   | SEP-6 `POST /withdraw-exchange`; return withdrawal instructions and transaction id                 | Adapter creates a payout/deposit request and returns typed instructions       | `POST /transactions` starts a hosted interactive session; no unattended completion contract |
| settle      | Operator submits Stellar payment to the SEP-31 deposit address with exact memo | Adapter reports whether settlement is on-chain or off-chain; don't assume a SEP-31 deposit address | `SettlementStrategy` chooses on-chain transfer or adapter-reported settlement | Excluded: user-controlled interactive session is not a deterministic engine step            |
| reconcile   | Poll SEP-31 `GET /transactions/:id` to terminal status                         | Poll SEP-6 `GET /transaction` and map status                                                       | Adapter polls its transaction endpoint and maps statuses                      | SEP-24 status polling follows an interactive flow and is not suitable for unattended runs   |

SEP-24 is excluded from unattended runs because it is explicitly a hosted, interactive deposit/withdrawal flow; a future operator-driven session integration can be designed separately. SEP-6 and SEP-24 transaction monitoring may use Stellar transaction details and memos; those assumptions do not make a claimable balance interchangeable with SEP-31's memo-correlated deposit.

## Manifest shape

`dest.protocol` is a discriminant: `sep31`, `sep6`, or `custom:<lowercase-id>`. Each branch owns only its endpoint names and required URLs. `source.protocol` uses the same discriminant to describe where the sender obtains the bridge asset. Existing untagged manifests parse as `sep31` during the compatibility period; explicit `protocol: sep31` is the canonical form for new manifests. Unknown values fail validation, never silently fall back.

Example:

```yaml
source:
  protocol: sep31
  name: Sending anchor
  asset: NGN
  endpoints:
    home_domain: source.example
    transfer_server_sep31: https://source.example/sep31
dest:
  protocol: sep6
  name: Receiving anchor
  asset: iso4217:ARS
  endpoints:
    home_domain: dest.example
    transfer_server: https://dest.example/sep6
```

The schema work and migration are tracked independently: [#179](https://github.com/ezedike-evan/corridor-in-a-box/issues/179), [#180](https://github.com/ezedike-evan/corridor-in-a-box/issues/180), [#181](https://github.com/ezedike-evan/corridor-in-a-box/issues/181), and source-side protocol support [#182](https://github.com/ezedike-evan/corridor-in-a-box/issues/182).

## Engine ports

1. Add `capabilities()` to `AnchorAdapter`; route checks use declared support rather than assuming SEP-31 ([#187](https://github.com/ezedike-evan/corridor-in-a-box/issues/187), [#188](https://github.com/ezedike-evan/corridor-in-a-box/issues/188)).
2. Replace `OpenTransaction` with a discriminated `DepositInstructions` union so an address+memo cannot be confused with off-chain instructions ([#183](https://github.com/ezedike-evan/corridor-in-a-box/issues/183)).
3. Extract `settle()` behind `SettlementStrategy`; strategies must return a typed settlement reference and declare whether funds moved ([#184](https://github.com/ezedike-evan/corridor-in-a-box/issues/184)). An adapter-reported/off-chain result needs a non-Stellar settlement reference ([#186](https://github.com/ezedike-evan/corridor-in-a-box/issues/186)).
4. Add `QuoteProvider` and `ComplianceStrategy` ports, preserving the existing SEP-38 and SEP-12 behavior as defaults ([#189](https://github.com/ezedike-evan/corridor-in-a-box/issues/189), [#193](https://github.com/ezedike-evan/corridor-in-a-box/issues/193)).
5. Add `SourceAnchorAdapter` only with the separate source-funding design; it is not a hidden responsibility of the destination adapter ([#214](https://github.com/ezedike-evan/corridor-in-a-box/issues/214), [#216](https://github.com/ezedike-evan/corridor-in-a-box/issues/216)).

Generic SEP adapters stay open source. A bespoke adapter may be private, but it must implement the same ports and conformance checks; private code cannot weaken engine invariants.

## Middleman and custody model

The operator receives source-side value, acquires/holds the bridge asset, then settles to the destination rail. Before source funds are confirmed, the sender bears funding risk. Once the engine submits an on-chain settlement, the operator has caused an irreversible ledger movement and the run must never return to `settling`; the receiving anchor then bears delivery risk. For adapter-reported settlement, the adapter's durable external reference is the evidence of movement, and the same no-double-submit rule applies. At every stage, the stored state must distinguish “not moved”, “movement ambiguous”, and “confirmed moved”.

## Invariants

- Preserve the transition table in [`packages/engine/src/state.ts`](../../packages/engine/src/state.ts): no path returns to `settling` after funds may have moved.
- Preserve idempotent resume from `settled` in [`packages/engine/src/run.ts`](../../packages/engine/src/run.ts): reconciliation resumes without another submit.
- Persist the strategy kind and settlement reference before any retry/resume decision that could otherwise submit again.
- A timeout after a potentially successful submit is ambiguous, not proof of failure; reconcile by reference before retrying.
- Do not persist customer PII in run records, alerts, or logs.

## Rollout

1. Agree this RFC and add the manifest union ([#179](https://github.com/ezedike-evan/corridor-in-a-box/issues/179)); preserve legacy SEP-31 parsing ([#180](https://github.com/ezedike-evan/corridor-in-a-box/issues/180)) and migrate checked-in manifests ([#181](https://github.com/ezedike-evan/corridor-in-a-box/issues/181)).
2. Add `source.protocol` ([#182](https://github.com/ezedike-evan/corridor-in-a-box/issues/182)), typed deposit instructions ([#183](https://github.com/ezedike-evan/corridor-in-a-box/issues/183)), adapter capabilities ([#187](https://github.com/ezedike-evan/corridor-in-a-box/issues/187), [#188](https://github.com/ezedike-evan/corridor-in-a-box/issues/188)), and settlement/quote/compliance ports ([#184](https://github.com/ezedike-evan/corridor-in-a-box/issues/184), [#186](https://github.com/ezedike-evan/corridor-in-a-box/issues/186), [#189](https://github.com/ezedike-evan/corridor-in-a-box/issues/189), [#193](https://github.com/ezedike-evan/corridor-in-a-box/issues/193)).
3. Ship SEP-6 incrementally: scaffold adapter ([#195](https://github.com/ezedike-evan/corridor-in-a-box/issues/195)), quote behavior ([#196](https://github.com/ezedike-evan/corridor-in-a-box/issues/196)), withdrawal instructions ([#197](https://github.com/ezedike-evan/corridor-in-a-box/issues/197)), status mapping ([#198](https://github.com/ezedike-evan/corridor-in-a-box/issues/198)), mock conformance ([#200](https://github.com/ezedike-evan/corridor-in-a-box/issues/200)), and opt-in live test ([#201](https://github.com/ezedike-evan/corridor-in-a-box/issues/201)).
4. Document SEP-24 exclusion ([#202](https://github.com/ezedike-evan/corridor-in-a-box/issues/202)); add bespoke adapter guidance ([#205](https://github.com/ezedike-evan/corridor-in-a-box/issues/205)).
5. Design and implement source funding separately ([#214](https://github.com/ezedike-evan/corridor-in-a-box/issues/214), [#216](https://github.com/ezedike-evan/corridor-in-a-box/issues/216)).

Each stage keeps the SEP-31 adapter as the default and requires protocol-specific tests before a corridor can be marked runnable.

## Decision

Adopt the explicit protocol/capability/strategy model. Implement SEP-31 first, SEP-6 as the next generic adapter, and support bespoke APIs through adapters. Do not add SEP-24 to unattended engine runs. Claimable-balance settlement is a separate settlement mode only where the anchor explicitly supports and observes it; it is not a replacement for the SEP-31 payment+memo contract (see [#177](https://github.com/ezedike-evan/corridor-in-a-box/issues/177)).
