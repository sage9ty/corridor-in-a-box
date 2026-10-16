# corridor-in-a-box

[![CI](https://github.com/ezedike-evan/corridor-in-a-box/actions/workflows/ci.yml/badge.svg)](https://github.com/ezedike-evan/corridor-in-a-box/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](./.nvmrc)

An open, **manifest-driven engine for Stellar SEP-31 cross-border corridors**. A
corridor is _configuration, not code_: the engine runs `quote → comply → settle →
reconcile → recover` over any standards-compliant anchor pair, and adding a new
corridor is a new `*.corridor.yaml` file — not a fork.

**Live demo:** [corridor-in-a-box.vercel.app](https://corridor-in-a-box.vercel.app)
— the corridor dashboard and a payment walkthrough. **The walkthrough is a
simulation**: it drives a re-implementation of the state machine and never
touches the Stellar network. `ng-cowrie` is the one exception: its endpoints
were probed against Cowrie's production API on 2026-08-11 — SEP-10 signed a
challenge, SEP-12 answered, and SEP-31 `/info` returned a non-empty receive
list — so it renders `VERIFIED`. That means endpoints were checked, not that
money moved: Cowrie publishes no SEP-38 quote server, no payment has been
attempted, and no business relationship is in place. Every other shipped
manifest renders `UNVERIFIED` or `NOT RUNNABLE` (see [Liveness](#liveness-has-four-states-and-green-has-to-be-earned)).

This repo contains the **open, runnable corridor engine** and the `RouteResolver`
seam. The intended open-core design leaves room for a proprietary anchor
health/conformance dataset and route intelligence to be supplied through that
interface, but neither that component nor a separate private repo is included
here. The current default resolver lets the open repo run corridors on its own.
Everything in this repo is publishable as-is.

> No smart contract required. SEP-31 is off-chain orchestration of a single
> **native** Stellar payment (the settle leg). Soroban only ever enters as an
> optional, separate on-chain oracle for publishing corridor data — never as part
> of moving money.

## Quickstart

```bash
corepack enable && pnpm install
pnpm lint               # eslint + prettier
pnpm typecheck          # whole monorepo, one tsc pass
pnpm test               # vitest: engine, manifest, money, sep31, stellar, …
pnpm example            # run a payment end-to-end (mocked anchor + settle)
pnpm cli plan corridors/reference.corridor.yaml   # offline pre-flight / liveness check
CORRIDOR_SIGNER_SECRET=S… pnpm cli canary corridors/reference.corridor.yaml \
  --amount 1.00 --write                            # MOVES MONEY: canary + proof
```

See [CONTRIBUTING](./CONTRIBUTING.md), [SECURITY](./SECURITY.md), and the
[ROADMAP](./ROADMAP.md) for how to get involved and where this is headed.

`pnpm example` walks a payment through every state and proves idempotency:

```
created -> quoted -> compliant -> opened -> verifying -> settling -> settled -> reconciled -> completed
replay with same key -> idempotent return (state=completed)
```

## Architecture

```
packages/
  types/         Outcome<T> result type (no-throw) + Money/PaymentIntent
  manifest/      Zod schema for a corridor + loader  ← the abstraction lives here
  adapter-kit/   AnchorAdapter port + conformance probes + a mock adapter
  probe/         conformance probes for corridor/anchor behavior
  registry/      conformance registry client
  attester/      attestation writer for the conformance registry
  sep31/         ONE generic adapter for any standards-compliant SEP-31
                 anchor (SEP-10 auth + SEP-12 KYC; crypto behind an injected signer)
  stellar/       the only package on the money path that touches the chain;
                 @stellar/stellar-sdk-backed settlement submitter + SEP-10 signer
  router/        RouteResolver seam — open interface + two resolvers (Static + Registry)
  engine/        corridor-agnostic orchestration of the five verbs, with a
                 persisted state machine, crash-resume, recovery, audit trail,
                 metrics hooks, and a durable Postgres idempotency store
  service/       thin HTTP API over the engine (auth + rate limiting),
                 zero deps
  cli/           validate a manifest; print an offline runnability plan
corridors/       the manifests — ALL corridor-specifics live here,
                 nowhere else
contracts/       Soroban registry + attester contracts
scripts/         reference-anchor.sh + assert-testnet-corridor.ts
docs/            key management, "why not Anchor Platform", SEP coverage,
                 operations, …
examples/        runnable end-to-end demo
```

Three boundaries do the work:

1. **engine ↔ manifest** — `engine/` contains no string `"NGN"` or `"Cowrie"`.
   Corridor-specifics enter only through a validated manifest. Corridor #2 is a
   YAML file, not a code change.
2. **engine ↔ adapters** — the engine knows only the `AnchorAdapter` interface.
   Standards-compliant anchors share one adapter; bespoke exchange/OTC desks
   implement the same interface. Proprietary implementations could be maintained
   separately; none is included in this repo.
3. **router seam** — the open repo ships the `RouteResolver` interface plus two
   resolvers: `StaticRouteResolver` (trust the manifest) and
   `RegistryRouteResolver` (require a fresh on-chain attestation). A
   health-/rate-weighted resolver could be supplied separately; it is not
   included or injected by this repo. The interface is the seam for that
   possible future component.

## Corridor sequencing

Picking the destination is the binding constraint, not the code. SEP-31 needs a
_live receiving anchor_ on the destination side, so corridors ship in this order:

| Stage  | Corridor                                                                           | Why                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#0** | `reference.corridor.yaml` (Anchor Platform reference, testnet)                     | Run it yourself, no agreements. Proves the engine moves through all five verbs against a conformant SEP-31 server. **Start here.**                                                                       |
| **#1** | `ng-cowrie.corridor.yaml` (USD → NGN via Cowrie Exchange) — **VERIFIED endpoints** | First real lane. Endpoints confirmed 2026-08-11 via `@corridor/probe`. `quote_source: external` (no SEP-38). No payment attempted, no business relationship in place — see the manifest's `status_note`. |
| later  | `ng-cn.corridor.yaml` (Nigeria → China)                                            | The headline case study. Becomes runnable on the same engine the day a compliant RMB SEP-31 off-ramp exists — fill in `dest.endpoints`, nothing else.                                                    |

> **Template**: `mx-example.corridor.yaml` (Mexico) shows the _shape_ of a real
> corridor but **every endpoint in it is fictional** — `corridor plan` reports it
> `UNVERIFIED`. It becomes real when an anchor relationship exists: replace the
> URLs from the anchor's published `stellar.toml` and set `endpoints_verified_at`.

The CLI makes the constraint visible. `ng-cn` validates structurally, but:

```
$ pnpm cli plan corridors/ng-cn.corridor.yaml
liveness: ✗ NOT RUNNABLE — a required endpoint is missing.

liveness warnings:
  ! dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.
  ! fx.quote_source=sep38 but dest exposes no SEP-38 quote server — quotes will fail.
  ! dest has no SEP-12 KYC server — assuming 1:1 delivery with no per-customer KYC.
```

That warning _is_ the off-ramp scarcity, surfaced at build time instead of in
production.

### Liveness has four states, and green has to be earned

A manifest naming an endpoint is not evidence the endpoint exists — anyone can
type a URL into a YAML file. So `corridor plan` and the dashboard report:

| State          | Meaning                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `NOT RUNNABLE` | A required endpoint is missing outright. The lane cannot settle.                         |
| `UNVERIFIED`   | Endpoints are present but **nobody has confirmed they resolve**. Not runnable.           |
| `VERIFIED`     | Endpoints were checked against the anchor's published `stellar.toml` on a recorded date. |
| `PROVEN`       | A canary payment also completed through the lane, and that proof is still fresh.         |

`VERIFIED` requires `dest.endpoints.endpoints_verified_at` — a date a human sets
only after actually looking. `ng-cowrie` is `VERIFIED`: its endpoints were
probed on 2026-08-11, and SEP-10, SEP-12, and SEP-31 answered. This does not
mean money moved — Cowrie publishes no SEP-38 quote server, no payment has
been attempted, and no business relationship is in place. Every other shipped
manifest is currently `UNVERIFIED` or `NOT RUNNABLE`. Green has to be earned;
here, `VERIFIED` means endpoints were checked, not that a payment was made.

`PROVEN` additionally requires a `proof:` block, and it is the one field nobody
should hand-type: `corridor canary … --write` writes it only after the settlement
is read back from Horizon and its destination, amount and memo match the run.

```
$ pnpm cli canary corridors/ng-cowrie.corridor.yaml --amount 1.00 --write
canary: ng-cowrie on public
trail: created -> quoted -> compliant -> opened -> settling -> settled -> reconciled -> completed
proof:
  canary_completed_at: "2026-09-27"
  stellar_tx_hash: 9f2c…
  anchor_transaction_id: 7b1e…
  amount: "1.00"
  max_age_days: 30
  canary_max_amount: "1.00"
wrote proof to corridors/ng-cowrie.corridor.yaml
```

A failed, held or refunded run writes nothing at all — the manifest stays
byte-identical — and a proof older than `proof.max_age_days` drops the lane back
to `VERIFIED` with a staleness warning rather than quietly staying green.

## The anchor registry (on-chain)

The engine answers "can this corridor settle?". The registry answers the question
underneath it: **does this anchor actually do what its `stellar.toml` claims?**

Two Soroban contracts, live on testnet:

|          |                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| registry | [`CDFOVONWR3GGMGH2OC7YATRZE64RKSRAS7UMF7R2TSC6LNNO5G32RSX4`](https://stellar.expert/explorer/testnet/contract/CDFOVONWR3GGMGH2OC7YATRZE64RKSRAS7UMF7R2TSC6LNNO5G32RSX4) |
| attester | [`CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L`](https://stellar.expert/explorer/testnet/contract/CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L) |

The registry stores **facts**: which SEPs a domain advertises, the SHA-256 of the
`stellar.toml` they were read from, which conformance probes passed, and the
ledger someone last checked. No score, no ranking, no recommendation — those are
judgements, they depend on your risk appetite, and they belong in your
`RouteResolver`, not in a public record. **Verifiable facts are the public good;
the interpretation is the product.**

### Why it separates "advertises" from "works"

A live attestation of `testanchor.stellar.org`, produced by `pnpm probe:anchor`
and submitted on chain:

```
$ pnpm registry:read

testanchor.stellar.org
  advertises     SEP-1, SEP-6, SEP-10, SEP-12, SEP-24, SEP-31, SEP-38
  probes passed  toml_fetch, sep10_auth, sep38_quote, sep12_status
  probes FAILED  sep31_info
  attested at    ledger 4032636
  serves SEP-31  NO

usable SEP-31 off-ramps (attested + fresh): none
```

That anchor **advertises SEP-31 in its toml and returns an empty receive list**.
Anything reading the toml alone would call the lane runnable. `serves_sep31()`
returns `NO` because it requires the capability to be both advertised _and_
probed green — the same distinction the four-state liveness above enforces, now
as a public artifact anyone can check rather than a claim in this repo.

Every record carries `attested_ledger`, so staleness is visible on chain. An
attestation is never wrong, only old, and a consumer must be able to see the
difference without trusting the writer to have pruned it.

```bash
pnpm probe:anchor testanchor.stellar.org   # probe a live anchor, print the facts
pnpm registry:read                         # read the registry via @corridor/registry
cd contracts && cargo test                 # 21 contract tests
```

## Proof against a real SEP-31 anchor

`scripts/reference-anchor.sh up` stands up the SDF **Anchor Platform reference
server** locally under podman — a conformant SEP-31 counterparty, no agreements
and no credentials required. `pnpm fund:testnet` then gives the sending account a
USDC trustline and balance, and `pnpm testnet` drives a payment across it.

A captured run on **2026-08-08**, corridor `reference-testnet`:

```
created → quoted → compliant → opened → settling → settled → (polling reconcile)
```

Every leg below happened against the anchor and is visible in _its_ logs, not
just ours:

| Leg               | Standard | Evidence                                                                                                                                                                                                 |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth              | SEP-10   | challenge signed and exchanged for a JWT                                                                                                                                                                 |
| register sender   | SEP-12   | `GET /customer?id=…&type=sep31-sender`                                                                                                                                                                   |
| register receiver | SEP-12   | `GET /customer?id=…&type=sep31-receiver`                                                                                                                                                                 |
| quote             | SEP-38   | `GET /rate?type=firm&sell_asset=stellar:USDC:GBBD47IF…` → `quote_created`                                                                                                                                |
| open              | SEP-31   | `POST /transactions` → `transaction_created`, tx `06e721a9-96c3-49f0-86e2-83c02f75306c`                                                                                                                  |
| **settle**        | Horizon  | [`4aea2432…7f183897`](https://stellar.expert/explorer/testnet/tx/4aea2432696c43104662fea98c86cecdfb12e2e831426e3a90e616eb7f183897) — **10.0000000 USDC** to the anchor's deposit address, ledger 4030910 |

The settle memo is a `hash` memo whose base64 decodes to `06e721a9-96c3-49f0-86e2-83c02f75`
— the anchor's own transaction id, which is how it attributes the incoming payment.

**Where it stops, precisely.** `reconcile` did **not** reach `completed`. The
payment is on the ledger and correctly attributed, but the reference server's
Stellar observer never advanced past a stale cursor, so it never matched the
payment to its transaction and the transaction stayed `pending_sender`. That is
the anchor's back-office plumbing, not the engine — but it means **the
`reconcile → completed` leg is still unproven against a real counterparty**, and
the engine's timeout/recovery path is what actually ran. Closing that is the
remaining Phase-1 item.

**Update (2026-09-01): cursor seeding fixed in #65.** `reference-anchor.sh up`
now reseeds the observer cursor from Horizon's tip on every start (see [the
observer cursor](./docs/operations.md#the-observer-cursor)), #66 added a
cursor-lag check to `doctor`, and #67/#75 added `pnpm verify:corridor` plus the
scheduled [`reference-corridor`](https://github.com/ezedike-evan/corridor-in-a-box/actions/workflows/reference-corridor.yml)
workflow, which runs the whole corridor against the reference stack. The stale
cursor is no longer the known blocker. `reconcile → completed` stays **unproven**
until that workflow passes; it currently fails.

## Proof the settle leg is real

The settle leg has been executed against live Stellar testnet. Reproduce it in
one command — it funds throwaway keys via friendbot, so it costs nothing:

```bash
pnpm verify:settle
```

A captured run:

|           |                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tx hash   | [`855933c73b85b9071318ff0bfd9213096a1edfaef68417dea1c2e8fb08dfd245`](https://stellar.expert/explorer/testnet/tx/855933c73b85b9071318ff0bfd9213096a1edfaef68417dea1c2e8fb08dfd245) |
| ledger    | 4024693                                                                                                                                                                           |
| date      | 2026-08-07                                                                                                                                                                        |
| operation | `payment` 12.5000000 native → `GBHY4SAO…JC4EOWC6`                                                                                                                                 |
| memo      | `corridor-settle`                                                                                                                                                                 |

**Scope, precisely.** This proves `StellarSettlementSubmitter` really does build →
sign (through the `ExternalSigner` port) → submit → poll Horizon until the
transaction is in a ledger, against the live network. It is **not** a SEP-31
corridor run: there is no anchor in it, so no SEP-38 quote, no SEP-12 KYC, no
SEP-31 open/reconcile. Those legs need a conformant receiving anchor and are
still outstanding — see [ROADMAP](./ROADMAP.md) Phase 1 and
[docs/operations.md](./docs/operations.md) §1.

## Verifying a whole corridor run

`verify:settle` proves one leg. `verify:corridor` is the pass/fail gate for
**all** of them — quote → comply → open → settle → reconcile → completed —
against the local Anchor Platform reference server, which
[`scripts/reference-anchor.sh`](./scripts/reference-anchor.sh) stands up with no
commercial agreement required:

```bash
scripts/reference-anchor.sh up
CORRIDOR_SIGNER_SECRET=S… pnpm verify:corridor
```

It exits non-zero unless the run's terminal state is `completed`, printing the
full trail and the last error either way, so it can gate CI or a release. Before
opening a payment it runs `reference-anchor.sh doctor` — a run against a sick
stack ends in `RECONCILE_STALLED` after 10 identical consecutive polls (~20 s
with the default `stallThreshold=10` and `reconcilePollMs=2000`).
`SETTLEMENT_TIMEOUT` only fires when the anchor's status keeps _changing_ but
never reaches a terminal state within `recovery.timeout_seconds`.

The signer must be a **testnet** account holding the corridor's bridge asset
(`USDC` from the issuer the anchor quotes) with a trustline for it. The runner
refuses a `network: public` manifest outright — it drives payments at localhost,
so a mainnet corridor here is always a mistake rather than a decision. See
[docs/operations.md](./docs/operations.md) §1.

## Going live

Swap the mocks for the real implementations (both ship in this repo):

- `createMockAdapter()` → `new Sep31Adapter(corridor, { sep10: new StellarSep10Signer(keypair) })`
  — the SEP-31/38 HTTP shapes plus the SEP-10 challenge/response and SEP-12 KYC
  status check. The challenge-signing crypto is injected, so the adapter itself
  stays SDK-free.
- `createMockSubmitter()` → `new StellarSettlementSubmitter({ signerSecret, horizonUrl })`
  from `@corridor/stellar` — builds/signs/submits the native bridge-asset payment
  to the anchor deposit address and confirms it on Horizon.
- `new InMemoryIdempotencyStore()` → `new PostgresIdempotencyStore(pool)` for a
  durable, crash-resumable run log (run `migrate(pool)` once at startup).
- Optionally add a `health` store to stop retrying a dead anchor. Wrap
  `new PostgresCorridorHealthStore(pool)` in `MeteredCorridorHealthStore` and
  the engine halts a corridor after `recovery.breaker.consecutive_failures`
  consecutive lane failures (default 3) instead of spending a fee per retry;
  new payments get `CORRIDOR_HALTED` / 503 and a payment already past
  settlement still completes. It is opt-in — no store, no gate, no series.
  Manage it with `pnpm cli breaker status` and
  `pnpm cli breaker reset <id> --reason "…"`; see
  [docs/operations.md §7](./docs/operations.md).
- Pass an `audit` sink (and a `logger`) to `execute()` so every state transition
  is recorded.
- Provide `gate: defaultSep31Gate(...)` (or a custom `PreSettleGate`) to `execute()`.
  Pre-settle safety checks are mandatory by default before money moves on chain
  (`unsafeSkipPreSettleGate: true` is strictly an explicit opt-out for tests).

Then point a manifest at the testnet reference server and run it for real. The
open repo runs with its default `RouteResolver`; a proprietary implementation
could be supplied separately, but none is included in this archive.

## Verifying against a real anchor

The default `pnpm test` runs entirely against mocks. An **opt-in** integration
test exercises the adapter against a live SEP-31 server. It is read-only —
SEP-10 auth, a firm SEP-38 quote, and the conformance probes; it does **not**
move funds — and is skipped unless the anchor env vars are set (see
[`.env.example`](./.env.example)).

The command below runs it against the **SDF test anchor** (public, testnet, no
self-hosting needed) — last verified green 2026-07-12: real SEP-10
challenge/response, a firm quote with a future expiry, and a SEP-12 status
probe. Any [friendbot](https://friendbot.stellar.org)-funded testnet key works
as the signer.

```bash
ANCHOR_HOME_DOMAIN=testanchor.stellar.org \
ANCHOR_SEP31_TRANSFER_SERVER=https://testanchor.stellar.org/sep31 \
ANCHOR_SEP31_QUOTE_SERVER=https://testanchor.stellar.org/sep38 \
ANCHOR_SEP31_WEB_AUTH=https://testanchor.stellar.org/auth \
ANCHOR_SEP31_KYC_SERVER=https://testanchor.stellar.org/sep12 \
ANCHOR_ASSET_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
ANCHOR_DEST_ASSET=iso4217:USD \
CORRIDOR_SIGNER_SECRET=S...   # testnet only; enables SEP-10 auth
pnpm exec vitest run tests/integration/sep31-live.test.ts
```

The [`nightly-live-anchor`](./.github/workflows/nightly-live-anchor.yml) workflow
already re-runs this same read-only probe every night against the SDF test
anchor — it defaults `ANCHOR_HOME_DOMAIN` and friends to the public
`testanchor.stellar.org` values above, so it doesn't wait on repo secrets to
start probing. The one var that _is_ a real secret, `CORRIDOR_SIGNER_SECRET`,
gates the SEP-10/SEP-12 legs: without it configured as a repo secret those legs
skip (and the job says so via a `::warning::`) while the rest of the probe
still runs.

The full money-moving end-to-end capture (open → settle → reconcile against a
testnet anchor) is a manual step — the procedure is in
[docs/operations.md](./docs/operations.md). The **settle leg** itself is
live-verified on testnet, not just against mocks — see [Proof against a real
SEP-31 anchor](#proof-against-a-real-sep-31-anchor) above (ledger 4030910, 10
USDC to the anchor's deposit address) and [Proof the settle leg is
real](#proof-the-settle-leg-is-real) above (ledger 4024693). What's still
unproven against a real counterparty is `reconcile → completed` — see [where it
stops, precisely](#proof-against-a-real-sep-31-anchor) above — and that is the
one Phase-1 roadmap item still open.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
