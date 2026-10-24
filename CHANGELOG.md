# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches
1.0. While pre-1.0, minor versions may contain breaking changes.

## [Unreleased]

### Fixed — Prometheus exposition conformance (#274)

- Added HELP metadata to emitted metric families and changed timing metrics from
  incomplete millisecond summaries to parser-compatible histograms measured in
  seconds, with configurable cumulative buckets.
- **Breaking metrics change:** timing families now use
  `<name>_seconds_bucket`, `<name>_seconds_sum`, and
  `<name>_seconds_count` instead of the previous `<name>_ms_count` and
  `<name>_ms_sum` samples. Update dashboards and alert rules accordingly.
- Added parser-based regression coverage for family types, HELP text, histogram
  buckets, aggregation, and escaped labels.

### Added — `PostgresAuditSink`: a durable, append-only audit trail ([#272](https://github.com/ezedike-evan/corridor-in-a-box/issues/272))

The audit trail used to live only in memory, so the service lost it on every
restart, even when `DATABASE_URL` gave it Postgres.

- `PostgresAuditSink` in `@corridor/engine` writes one `corridor_audit` row per
  state transition. A unique key on `(idempotency_key, version, to_state)` makes
  a retried write a no-op. Route trust, fees and gate checks are kept in a
  `detail` JSON column.
- `listAudit(idempotencyKey)` returns a payment's trail, oldest first.
- `migrate()` creates the table. `examples/run-service.ts` uses the sink
  whenever `DATABASE_URL` is set.
- `docs/operations.md` documents a service role with `SELECT`/`INSERT` only on
  the table. It also documents what happens when an audit write fails: the
  payment stops before its next step and resumes later, and the missed entry
  shows up as a gap in `version`.
- The CI `integration-postgres` job now also runs
  `tests/integration/audit-pg.test.ts`.

### Added — flaky-test quarantine (2026-10-21)

A flaky test can be quarantined instead of deleted or silently skipped
([#284](https://github.com/ezedike-evan/corridor-in-a-box/issues/284)):

- `quarantine(issueUrl, name, fn)` in `tests/helpers/quarantine.ts` wraps a
  sequential describe block tagged `[quarantine]`. The main `pnpm test` run
  skips it.
- `pnpm test:quarantine` runs only quarantined blocks, with `retry: 3`.
- New non-blocking `quarantine` CI job (`continue-on-error: true`). Its job
  summary lists each quarantined test, its issue, and the outcome.
- `tests/quarantine.test.ts` fails if a `quarantine()` call has no GitHub issue URL.

### Maintenance — removed the unused `turbo.json`

- Turborepo was never installed or invoked: `pnpm typecheck` is one `tsc` pass
  and `pnpm test` is one `vitest run`. `turbo.json` and the `.turbo` entries in
  `.gitignore`, `.prettierignore` and `eslint.config.js` are gone, so nobody
  assumes there is task caching
  ([#285](https://github.com/ezedike-evan/corridor-in-a-box/issues/285)).

### Added — every service request carries an `X-Request-Id` into the logs and the audit trail ([#269](https://github.com/ezedike-evan/corridor-in-a-box/issues/269))

Engine logs and audit entries only carried `idempotencyKey` and `corridorId`,
and the service neither assigned nor returned a request id — so an operator
handed a `500` and a log file had no way to tie the two together.

- `packages/service`: `server()` accepts an inbound `X-Request-Id` and echoes
  it back on every response, including the transport-owned ones (413, 400 from
  invalid JSON, 401, 404, 429, 500). An inbound id is used only if it is
  `[A-Za-z0-9._-]{1,128}`; anything else is replaced with a fresh
  `crypto.randomUUID()`, so a client cannot inject a log line or a header.
- `packages/service`: `RouteResponse` gained `headers`, and `RouteRequest`
  gained `requestId` / `traceparent`, so `route()` stays a pure function that
  can be driven without a socket.
- `packages/service`: a W3C `traceparent` is validated and passed through as a
  field on the response and on every log line (full tracing is a separate
  concern).
- `packages/engine`: `ExecuteOptions.requestId` / `traceparent` scope the run —
  `Logger.child(fields)` (new optional member, with `childLogger()` falling back
  to merging for third-party loggers) and `scopedAuditSink()` wrap the deps once,
  so _every_ emit site of a run inherits the id: transitions, the pre-settle
  gate detail, reconcile polls, halt notices. `AuditEntry` and `AuditDetail`
  gained optional `requestId` / `traceparent`.

### Breaking — `StellarSettlementSubmitter` refuses mainnet unless it is opted in ([#275](https://github.com/ezedike-evan/corridor-in-a-box/issues/275))

The "don't move real money by accident" check lived only in the example
launchers (`examples/run-testnet.ts`, `examples/run-service.ts`,
`scripts/assert-testnet-corridor.ts`), so an embedder wiring the library
together themselves inherited no guard at all: the submitter picked the network
straight from the manifest and signed whatever `settlement.network` said.

- `packages/stellar`: `StellarSubmitterOptions.allowedNetworks`
  (`readonly ("public" | "testnet")[]`) **defaults to `["testnet"]`**. A
  corridor on a network that is not listed is refused with a non-retryable
  `SETTLEMENT_FAILED` before `loadAccount()`, so a refusal costs no sequence
  number, no signature and no transaction. **Embedders that settle on public
  must now pass `allowedNetworks: ["testnet", "public"]`** — that is the whole
  point, but it is a breaking construction-time change.
- `packages/stellar`: a `LocalKeypairSigner` (including one built from
  `signerSecret`) is refused on public unless `allowLocalSignerOnMainnet: true`
  is also passed, per docs/key-management.md: a seed living in the application
  process is a testnet convenience, not a mainnet custody model.
- `packages/stellar`: the Horizon endpoint's own `network_passphrase` is read
  from its root resource once, lazily, and compared with the corridor's
  network — a testnet manifest pointed at a mainnet Horizon (or the reverse)
  is refused rather than signed. An endpoint that cannot be reached fails
  retryably; nothing was submitted, so retrying is safe. `fetchHorizonRoot` is
  the test seam; the check is skipped when a fake `horizonServer` is injected
  without it.
- `examples/run-service.ts` and `examples/run-testnet.ts`: the submitter is
  constructed with `allowedNetworks` derived from `CORRIDOR_ALLOW_MAINNET=1`,
  so the launcher's opt-in and the signer's guard cannot drift apart.
- `tests/stellar.test.ts`: public corridor without opt-in → refused with no
  `loadAccount` call; local signer on public refused even with the network
  allowed; explicit ack settles; endpoint/corridor passphrase mismatch refused
  (root read once); unverifiable endpoint retryable.

### Added — `tests/service-http.test.ts`: the service transport, tested over a socket ([#281](https://github.com/ezedike-evan/corridor-in-a-box/issues/281))

`tests/service.test.ts` drives the pure `route()` in-process, which is the right
way to test routing — but the transport in `server()` was mostly invisible to
it: JSON parsing, the lowercasing of inbound headers, `resolveClientIp()` /
`trustProxy`, the content types written on the way out, and the catch-all that
turns an unexpected throw into a 500. Only the two body-size cases went through
a real socket.

- New black-box suite: mock adapters, mock submitter, a server on port 0, and
  assertions on status bytes, headers and response bodies. It covers POST
  `/payments` → 200 and reading that key back, 401 without a key, a mixed-case
  `Authorization` still authenticating, a cross-tenant `GET /payments/:key` →
  404, 429 after the token bucket drains, `/metrics` served as
  `text/plain; version=0.0.4` verbatim and unmetered, a forged
  `X-Forwarded-For` ignored by default and honoured under `trustProxy`, invalid
  JSON → 400, and a rejecting store → 500 with the same server still answering
  the next request.
- Servers are closed through `gracefulShutdown()` in `afterEach`, not
  `server.close()`, so nothing outlives the test.
- 12 tests, ~0.3 s. No production code changed.

### Fixed — `web/` reads corridor data and the state list from the repo, not hand copies ([#293](https://github.com/ezedike-evan/corridor-in-a-box/issues/293))

`web/lib/corridors.ts` had hand-copied four of the six manifests and kept its
own copy of `liveness()`, which still treated every lane as SEP-31. The
payment runner hand-listed the engine's states.

- `pnpm gen:web-data` (`scripts/gen-web-data.ts`) loads every
  `corridors/*.corridor.yaml` with `@corridor/manifest` and reads the state
  machine from `@corridor/engine`. It writes
  `web/lib/generated/{corridors,states}.json`, which are committed.
- `web/` imports those files and calls `@corridor/manifest`'s own `liveness()`,
  so the site now shows all six corridors and reports SEP-6 lanes correctly.
  Liveness is computed at render time, not generated: proof freshness depends
  on today's date.
- `@corridor/engine` exports `ALL_STATES`, and `CorridorState` is derived from it.
- `tests/web-data.test.ts` and a CI step fail when the generated files are
  stale.

### Fixed — `RegistryRouteResolver` checks the protocol the corridor declares, not SEP-31 ([#211](https://github.com/ezedike-evan/corridor-in-a-box/issues/211))

The registry-backed resolver asked every lane the same question — "is this
anchor attested as serving SEP-31?" — and refused any answer that was not yes.
A `protocol: sep6` corridor could therefore never clear the gate, and the
tempting way to unblock it (adding the anchor to `allowUnattestedDomains`)
would have quietly turned the evidence check off for that lane.

- `packages/router`: `AttestationSource` now exposes
  `serves(domain, protocol)` instead of `servesSep31(domain)`, and
  `resolve()` asks about `protocolOf(corridor.dest)`. A SEP-6 lane is checked
  against the SEP-6 probe, and the refusal message names the protocol
  ("not attested as serving SEP-6 receive-side").
- `packages/router`: `asAttestationSource()` adapts a source that only
  implements `servesSep31`, answering `false` for every other protocol rather
  than guessing — a source that cannot speak for a protocol is not evidence
  that the anchor serves it. `AttestationSourceLike` is the union both shapes
  are accepted as, so an embedder that already wired a source up keeps working.
- `packages/router`: a bespoke `custom:<id>` lane has no on-chain probe at all,
  so it now fails closed with a message that names the protocol and says why
  ("no on-chain attestation probe"), instead of being refused for a SEP-31
  reason it never had.
- `packages/router`: `UnattestedAnchorError` carries the protocol it refused.
- `packages/cli` and `examples/resolvers/allowlist-resolver.ts`: the
  "no registry deployed" fallback source answers every protocol with the same
  error, so an unconfigured deployment still fails closed.
- `packages/stellar`: `tomlHashCheck` takes either shape of attestation source
  (it only reads `tomlHash`).
- `tests/registry-resolver.test.ts`: a SEP-6 corridor passes when
  `serves(domain, "sep6")` is true and fails when only SEP-31 is attested; a
  bespoke lane fails closed unless it is allowlisted; a SEP-31-only source
  cannot wave a SEP-6 lane through. The existing cases run through the
  compatibility adapter.

### Added — a worked example of a bespoke HTTP anchor adapter ([#206](https://github.com/ezedike-evan/corridor-in-a-box/issues/206))

`examples/adapters/http-stub/` is a complete, runnable `AnchorAdapter` for an
anchor that speaks a proprietary HTTP API instead of SEP-31. `HttpStubAdapter`
reports `native` quotes, `bespoke` KYC and `stellar_payment` deposit
instructions, and drives the real engine end to end against a fictional API
served in-process by an injected `fetchImpl`. `pnpm example:stub` runs it.

Nothing in the example names a real anchor, host, endpoint or account: the
destination is `anchor.example` (RFC 2606 reserves `.example` for exactly
this), the routes are invented, and `tests/http-stub-adapter.test.ts` fails if
a URL in the example points anywhere but a reserved example domain. The same
test runs the conformance harness (`runConformance`) against the adapter, so a
third party has a worked reference for the wiring _and_ the checks.

The lane's manifest declares `protocol: custom:http-stub` and
`endpoints.base_url`, so a bespoke destination is configuration rather than
code: the engine needed no change to route through it, and
`RegistryRouteResolver` still refuses it for want of an on-chain attestation
probe unless the domain is explicitly allow-listed.

### Fixed — the attester rejects a domain that is not in canonical form ([#246](https://github.com/ezedike-evan/corridor-in-a-box/issues/246))

`attest` checked only that a domain was non-empty and `<= 253` bytes, so the
registry — which keys records by the raw string and appends every key to the
bounded `Domains` list — accepted `Cowrie.Exchange`, `cowrie.exchange.` and
`https://cowrie.exchange/` as three permanent records for one anchor, each
wasting one of 512 slots nobody can reclaim.

`contracts/attester` now requires the canonical spelling: labels of lowercase
letters and digits with `-` inside a label only, joined by single dots. A leading,
trailing or doubled dot, a leading or trailing hyphen, uppercase, a scheme, a
path, whitespace or any non-ASCII byte is `Error::InvalidDomain`. Ports are
rejected deliberately, and the reason is documented on `is_canonical_domain`: a
home domain is an origin, not a listener.

`isCanonicalDomain` in `@corridor/probe` mirrors the rule byte for byte, and
`AnchorAttester.attest` refuses a non-canonical domain before it loads the
account or simulates, so `pnpm attest` fails on the spelling instead of paying to
be reverted on chain. The same list of spellings is pinned in
`contracts/attester/src/test.rs` and `tests/domain.test.ts`;
`docs/operations.md` §0 states the rule where a fleet entry is added.

### Added — `describeResolverContract`: the RouteResolver contract, executable ([#260](https://github.com/ezedike-evan/corridor-in-a-box/issues/260))

A private resolver is written outside this repo against the `RouteResolver`
interface, and until now nothing shipped with it that could tell its author
whether it honours the documented contract — `tests/router.test.ts` and
`tests/registry-resolver.test.ts` test the built-ins and are not reusable.

`@corridor/router/testing` exports `describeResolverContract(name,
makeResolver)`, which registers four cases: a decision carries a receiving
anchor; the same intent twice yields the same anchor domain (resume safety);
failure behaviour matches what the resolver documents, declared per resolver via
`unresolvable` — `RegistryRouteResolver` refuses, `StaticRouteResolver` documents
that it trusts the manifest; and `split`, if present, sums to 1. The suite hands
the factory the fixtures it will resolve, so a third party wires its fakes to the
domains it is actually tested against.

`checkResolverContract` returns the report without registering anything and
`expectResolverContract` throws naming each failed clause, which is how
`tests/router.test.ts` proves — with `it.fails` — that a deliberately broken
resolver really fails the suite. Both built-ins and
`examples/resolvers/allowlist-resolver.ts` run it; `docs/route-resolver.md`
documents it for out-of-repo authors. vitest is a peer dependency of the
`./testing` subpath only.

### Added — observed receive assets and a declared country on registry records ([#242](https://github.com/ezedike-evan/corridor-in-a-box/issues/242), design in [#241](https://github.com/ezedike-evan/corridor-in-a-box/issues/241))

The registry could already answer "does this anchor serve SEP-31", but not "what
does it actually receive", which is the question a corridor is built around. Two
kinds of fact are recorded, and the distinction is the design:
`receive_assets` is OBSERVED (the codes a SEP-31 `/info` response listed when the
probe ran) and `country` is DECLARED (the anchor's own
`[DOCUMENTATION] ORG_PHYSICAL_ADDRESS`, verified by nobody).

- `docs/registry-metadata.md` records the decisions: its own `Meta(String)`
  storage key rather than new fields on `Anchor`, a separate `attest_meta` write
  with its own cooldown so a deployed attester keeps working and a sweep can
  write both halves in one ledger, the bounds (32 assets, 32 characters per
  code, 2 uppercase letters for a country), and why an empty list and an absent
  one are different findings.
- `contracts/registry`: `put_meta`, `get_meta`, `receives_asset`, an
  `AnchorMeta` record, a `MetaAttested` event, and errors `TooManyAssets`,
  `InvalidAssetCode`, `DuplicateAsset`, `InvalidCountry`. A domain with no
  metadata reads `NotFound`, so a record written before this upgrade still
  decodes and reports nothing invented. `bump` keeps the metadata entry alive
  beside the record it describes.
- `contracts/attester`: `attest_meta` gates on enrolment and cooldown, checks the
  same bounds before relaying (so a caller sees the attester's error numbers
  rather than a cross-contract revert), and `DataKey::LastMeta` holds its
  cooldown separately from the bitmap write's.
- `packages/probe`: `declaredCountry` maps an address line's last segment to
  ISO-3166-1 alpha-2 through an allowlist of names and alpha-3 codes, and
  returns nothing rather than guessing; `tomlValue` is still not a TOML parser.
  `ProbeResult.country` is set only when the toml declared one.
- `packages/attester`: `attestMeta` refuses locally when `sep31_info` produced no
  observed list, so an empty list can only ever mean "asked, receives nothing".
  Encodes `Option<String>` as Void/`String` and the asset list element-wise.
- `packages/registry`: `AnchorAttestation.receiveAssets` / `.country` (absent, not
  empty, when unrecorded), `getMeta` (null only for `NotFound`), `receivesAsset`,
  `getAnchor(domain, { meta: true })`, and `RegistryContractError`.
- `pnpm attest` submits both halves per domain; `pnpm registry:read` prints
  "not recorded" beside "nothing — asked and it accepts no asset" as two lines
  that mean different things.

The testnet contracts are not redeployed by this change: `upgrade()` needs the
enrolled operator key, so `contracts/deployments.json` still records the wasm
that is live, and the hashes change when that job runs.

### Added — `justfile` for the day-to-day commands ([#288](https://github.com/ezedike-evan/corridor-in-a-box/issues/288))

`install`, `check`, `contracts`, `web`, `pg-test`, `anchor-up` / `anchor-down` /
`anchor-doctor`, `secret-scan` and `ci`, each calling the same commands
`.github/workflows/ci.yml` calls, so the local gate and CI cannot drift.
`pg-test` starts and removes the Postgres container CI gets from a service, and
`just --list` documents every recipe. CONTRIBUTING.md now points at `just ci`.

### Added — Zeam (South Africa) probed and added as the second VERIFIED lane ([#225](https://github.com/ezedike-evan/corridor-in-a-box/issues/225))

`corridors/zeam.corridor.yaml` — USD → ZAR over `mint.zeam.money`, probed
2026-10-17 with `@corridor/probe`: SEP-10 signed a challenge and got a JWT,
SEP-38 returned a firm quote, SEP-12 answered, and SEP-31 `/info` receives USDC
(toml sha256 `92a309791b0eefff…`). Unlike Cowrie, Zeam publishes
`ANCHOR_QUOTE_SERVER`, so this lane keeps `fx.quote_source: sep38`.
`contracts/anchors.json` now probes the domain on the scheduled attester job.

The payout currency is ZAR, not the KES the issue assumed: Zeam's toml anchors
`ZARZ` (fiat ZAR) and `GBPZ`, and its Anchor Directory entry lists the
Democratic Republic of the Congo, Malawi, South Africa, Zambia and Zimbabwe.

### Added — `@corridor/sep6`: a SEP-6 withdrawal adapter on the same port ([#197](https://github.com/ezedike-evan/corridor-in-a-box/issues/197))

`packages/sep6` implements `AnchorAdapter` for a `dest.protocol: sep6` corridor,
so the engine's `quote → comply → open → settle → reconcile` run needs no
changes to drive a SEP-6 anchor: `openTransaction` returns `stellar_payment`
`instructions` (the anchor's `withdraw_anchor_account` and memo), and the
on-chain leg still goes through `StellarPaymentStrategy`. The `/info` discovery
(`info()`, `parseSep6Info`) from the scaffold is kept; before `info()` has run
`capabilities().settlement` is `["stellar_payment"]`, and it becomes empty if
`/info` omits or disables the dest asset.

- `GET {transfer_server}/withdraw-exchange` with query params, per SEP-6
  v4.3.0. The issue text named `POST /transactions/withdraw-exchange`, a path no
  version of the spec defines; verified live against
  `testanchor.stellar.org` (`TRANSFER_SERVER = https://testanchor.stellar.org/sep6`),
  where GET returns 200 `{"id": …}` and POST returns "Request method 'POST' is
  not supported".
- Because that response carries no account, `openTransaction` follows up with
  exactly one authenticated `GET /transaction?id=` and reads
  `withdraw_anchor_account` / `withdraw_memo` / `withdraw_memo_type`. If the
  anchor still names no account the adapter refuses instead of returning an
  empty address — non-retryable on purpose, since SEP-6 has no idempotent
  re-open and an automatic retry would initiate a second withdrawal.
- The KYC-shaped answers are refusals, not instructions:
  `non_interactive_customer_info_needed` → `KYC_REQUIRED` listing the fields,
  `customer_info_status` denied → `KYC_REJECTED`, pending/unknown →
  `KYC_REQUIRED`. Matched on the body's `type` before the status code.
- `SEP-10` auth is fail-closed and cached like `@corridor/sep31`, and
  `mapSep6Status` keeps the fail-open-to-polling discipline while adding
  `pending_user_transfer_start`/`_complete`, `pending_user`, `pending_trust`,
  `on_hold` and the `no_market`/`too_small`/`too_large` terminals.
- Deliberate floors, each naming the issue that owns the design: `requestQuote`
  is minimal and refuses without a `quote_server` (#196), `ensureCompliance`
  refuses without a `kyc_server` rather than assuming a KYC-less lane (#193),
  and `requestRefund` returns `REFUND_UNSUPPORTED` without a network call, as
  SEP-6 defines no sender-initiated refund.

### Added — chaos suite: no money moves unless the gate passed ([#300](https://github.com/ezedike-evan/corridor-in-a-box/issues/300))

`tests/chaos.test.ts` injects one failure at a time into every step — route
resolution, the four adapter verbs, all seven pre-settle gate checks,
`gate.evaluate`, settle, reconcile — across `throw` / `retryable` /
`non_retryable` / `timeout`, sweeping the three rollback policies where recovery
differs. Per cell it asserts `submit()` was never reached when a step before
settle failed, that money moved at most once and only after the last gate
evaluation fully passed, and that the persisted state matches the runbook's
terminal set. Four crash-and-resume cases cover the idempotency conflicts and
prove a resume never re-settles. A fake clock drives every timeout, so the suite
adds no real waiting.

Two tests record a documented discrepancy rather than papering over it: a throw
from an adapter verb or from `submit()` is not caught by `run.ts`, so `execute()`
rejects and the stored row stays non-terminal — only gate throws are fail-closed.

### Fixed — dashboard accessibility pass (#295)

- `/payments`: every label is associated with its control (`useId`), the refused-amount error is tied to the field with `aria-invalid` and `aria-describedby` and focus moves to it, and each step of the state machine carries its status as text, not only colour or opacity.
- The outcome of a run is announced through a `role="status"` live region (one note while it runs, the result once known).
- Decorative icons are hidden from assistive technology or paired with text; headings, `nav` landmarks, `aria-current` and the theme toggle's pressed state are added; link text that repeats ("Run a payment") says which corridor.
- A visible focus indicator, scroll padding under the sticky header, and text colours that keep 4.5:1 contrast in both themes.
- The wording lives in `web/lib/run-status.ts` and is covered by `tests/web-run-status.test.ts`.

### Added

- Engine dry-run mode (#298). `execute(intent, corridor, deps, { dryRun: true })` runs quote, comply, open and the pre-settle gate against the real anchor, then stops before `settling` without calling `SettlementSubmitter.submit()` or `findExisting()`. A run that passes the gate is persisted as `failed` with the new `DRY_RUN_COMPLETE` code. Its gate results go on the audit trail and in the error's `cause` (`DryRunReport`). The code is breaker-neutral and maps to HTTP 409. Exposed as `corridor canary --dry-run` (exit `0`; rejected with `--write`) and `--dry-run` on `pnpm example` / `pnpm testnet`. The opened SEP-31 transaction is never funded and expires on the anchor's side.
- Dashboard freshness (#296). `fetchAttestations()` returns `readAt` and the RPC's `latestLedger`. The Attested anchors section shows "Read from <network> registry at <time> · ledger N · <age> ago · refreshes every 1 hour", with the age worked out in the browser and a warning style once it passes the revalidate window. Per-anchor staleness shows an approximate duration (~5 s/ledger) next to the ledger count.
- `mykobo.co` joins the attester anchor list in `contracts/anchors.json`. Its `stellar.toml` advertises SEP-6, SEP-24 and SEP-31, but the host it publishes for those APIs (`stellar.mykobo.co`) does not resolve, so the SEP-10 and SEP-31 probes fail and no corridor manifest is written. The probe outcome is recorded in the file's `$comment` (#226).

### Added — QuoteProvider abstraction: SEP-38, adapter-native, and external pricing (#189)

- Introduces `Sep38QuoteProvider` and `AdapterQuoteProvider` implementing `QuoteProvider`.
- Refactors `Sep31Adapter.requestQuote` to delegate to `Sep38QuoteProvider`.
- Extends corridor manifest `fx.quote_source` enum with `"native"`.
- Adds `EngineDeps.quoteProvider` allowing operators to inject custom quote providers or factories `(corridor, adapter) => QuoteProvider`.
- Engine validates adapter capabilities when `quote_source: "native"` is configured and dispatches quoting to `AdapterQuoteProvider`.

### Added — Engine: read adapter capabilities instead of assuming SEP-31 behaviour (#188)

- Engine executes `checkCompatibility(corridor, caps, strategies)` before external adapter calls.
- Adds `CAPABILITY_MISMATCH` to `CorridorErrorCode` (mapped to HTTP 422 in service layer and documented in API docs).
- Fails execution with `CAPABILITY_MISMATCH` if corridor requires quotes (e.g. `sep38`) but adapter capabilities report `quotes: ["none"]`, or if adapter settlement capabilities are empty or have unsupported settlement kinds not covered by available settlement strategies.
- Skips compliance / KYC step during execution and resume when adapter capabilities declare `kyc: "none"`.

### Added — `OpenTransaction.instructions` discriminated union (#183)

- Add `DepositInstructions` discriminated union (`stellar_payment`, `claimable_balance`, `adapter_settled`) to `@corridor/adapter-kit`.
- Update `OpenTransaction` to carry `instructions: DepositInstructions` while retaining deprecated optional `depositAddress`, `memo`, and `memoType` fields and adding `toLegacy()` helper for single-release backward compatibility.
- Update `Sep31Adapter` and `createMockAdapter` to return `instructions` with `kind: "stellar_payment"`.
- Update `settle()` in `@corridor/engine` to switch on `instructions.kind` and fail closed (`SETTLEMENT_FAILED`, non-retryable) on unhandled instruction kinds before attempting payment submission.

### Added — `--json` flag to `pnpm probe:anchor` (#232)

- Adds `--json` flag parsing to `examples/probe-anchor.ts` accepted in any argv position.
- Suppresses banner and human logs when `--json` is supplied, streaming only the serialized JSON probe result to stdout.
- Introduces `formatProbeResultJson` and `parseProbeArgs` in `@corridor/probe`, formatting raw bitmasks alongside decoded SEP numbers and executed/passed probe lists.

### Added: SEP-6 adapter scaffold with GET /info discovery

`@corridor/sep6` implements the receiving-side `AnchorAdapter` for SEP-6
anchors. It parses `GET {transfer_server}/info` (the `withdraw` and
`withdraw-exchange` sections), caches the result on the adapter instance, and
derives `capabilities()` from it. The transfer verbs fail closed with
`ANCHOR_UNAVAILABLE` until their issues land (#196, #197, #198). SEP-10 auth is
deliberately not wired here; it waits on the shared client from #194.

### Fixed — a resumed recovery run reports its real cause to the circuit breaker

After a restart, a run resumed from `recovering` or `refund_pending` used to be
judged by a synthesized `RECONCILE_MISMATCH` ("receiving transaction … was
refunded"), so the lane's stored `lastError` never showed what actually went
wrong. The run's persisted `lastError` ("CODE: message") is now read back and
used when its code is one the breaker already counts as a lane failure. Anything
else (no `lastError`, one that does not parse, a neutral code) falls back to the
old behaviour, so a resume is never judged more leniently than before.

### Maintenance — remaining valid test fixtures declare `protocol: sep31`

`canary-capped`, `limits`, `proven` and `stale-proof` now state their
destination protocol explicitly, so parsing them no longer yields the legacy
deprecation warning. `invalid.corridor.yaml` is left as it was, on purpose.

### Added — pre-settle gate results are logged per check and copied into the audit trail ([#142](https://github.com/ezedike-evan/corridor-in-a-box/issues/142))

Building on `AuditEntry.checks`, each gate check on the transition out of
`verifying` is now also logged as `corridor.gate.check` — `info` when it
passed, `warn` when it failed — and the audit entry takes a copy of the
`checks` array, so a caller mutating its array afterwards cannot change what was
recorded. `CheckResult.detail` is documented as PII-free: ids, amounts, asset
codes, G-addresses and statuses only.

### Added — Legacy flat SEP-31 dest endpoints: deprecation warning (#180)

- `parseCorridor` / `loadCorridor` now return `warnings: string[]` on success (additive; still assignable to `Outcome<Corridor>`).
- A destination with no `protocol` (legacy flat SEP-31 endpoints) still parses as `sep31` and now yields a deprecation warning.
- A destination with no `protocol` but a `transfer_server` or `base_url` endpoint is rejected with guidance to set `protocol: sep6` or `protocol: custom:<name>`.

### Added — `fx.quote_source: external` path (#190)

- `ExternalQuoteProvider` and `EngineDeps.externalQuote`: operators inject a
  pricing function for corridors with no SEP-38 server. Quotes are `firm: false`;
  no SEP-38 call is made. `external` + `who_holds_risk: receiving_anchor` is
  refused before `open` unless the adapter reports `native` quotes.
- Minimal shim for #187/#189: `AdapterCapabilities` and `AnchorAdapter.capabilities()`
  (implemented by `Sep31Adapter` and the mock, which takes `capabilities` overrides)
  and the `QuoteProvider` interface. `capabilities()` is now required on
  `AnchorAdapter`, a breaking change for out-of-tree adapters.

### Added — `AccountInspector` reads live reserve/fee and our payment history (2026-09-30)

`AccountInspector` in `@corridor/stellar` is now the one read-only Horizon
seam every chain-facing check reuses
([#149](https://github.com/ezedike-evan/corridor-in-a-box/issues/149)):

- `baseReserve()` and `baseFee()` read the latest ledger (stroops converted
  with BigInt, never floats) instead of returning constants. The
  `baseReserve`/`baseFee` constructor options still pin a value.
- New `paymentsFrom(source, { to?, sinceLedger? })` returns our outgoing
  payments, newest first, each joined with its transaction's memo and memo type.
  It reads at most `maxPages` pages and reports `truncated` when it stopped
  early, so a duplicate-send check can tell "not found" from "didn't look".
- The constructor takes a narrowed, structural `InspectorHorizonLike` fake;
  a real `Horizon.Server` satisfies it without a cast.
- A trustline whose authorization Horizon doesn't report now reads as
  `is_authorized: false` (was `true`). Only a 404 / `NotFoundError` means
  "account does not exist"; an error whose message merely says "not found"
  is now a retryable failure.

### Added — verify the settle payment on-chain before reconcile

- New optional `EngineDeps.chainVerifier`. After `settled` (and on resume from
  `settled`) the engine re-checks the payment; a mismatch is a non-retryable
  `RECONCILE_MISMATCH` routed through the manifest's `hold` / `refund_sender`
  policy. `@corridor/stellar` provides `createChainVerifier(new AccountInspector(...))`,
  `AccountInspector.settlementFacts(hash)` and `verifySettlementFacts()` (one
  payment op; destination, amount, asset and memo/memo type must match).
- Runs now record the `settlement` request so a resumed run can re-verify;
  Postgres stores add a nullable `settlement` column (added by `migrate()`).

### Fixed — operations.md §1 step 4 described output a reader could never see (closes #129)

`docs/operations.md` step 4 instructed readers to run
`pnpm cli plan corridors/reference.corridor.yaml` and said it "must report the lane
runnable (no liveness warnings)". The reference corridor points at `localhost` and
has no `endpoints_verified_at` by design — setting that field on a localhost manifest
would be meaningless — so `plan` always prints `UNVERIFIED` plus a warning about
unconfirmed endpoints. Step 4 was therefore impossible to pass as written, which
stopped readers dead.

The step now shows the actual expected output and explains what the pre-flight is
really checking: that the manifest parses (exit 0), that liveness is **not** `NOT
RUNNABLE` (all required endpoint fields are present), and that it is **not**
`✓ VERIFIED` (a localhost manifest reporting verified would be the lie to catch).
The live readiness check — containers up, SEP-31 receiving, observer cursor in range
— is `reference-anchor.sh doctor`, and the step now points there explicitly.

### Changed — anchor-side terminal failure after settle enters `refund_pending`

- Under `rollback: refund_sender`, when money has moved and the anchor reports a
  terminal failure, the run now goes `recovering -> refund_pending` and waits for
  the anchor's refund report instead of calling `submitter.refund` (which the real
  submitter always refuses). `reconcileUntil` now carries the terminal
  `TransactionStatus` on the error's `cause` (`anchorTerminalStatus()`). Timeouts,
  stalls, the no-hash path and the `hold` / `manual` policies are unchanged.

### Added — per-corridor reconcile cadence

- Manifests can set `recovery.reconcile: { poll_seconds?, stall_polls? }`
  (`stall_polls: 0` disables stall detection). Resolution order is manifest,
  then `EngineDeps.reconcilePollMs` / `stallThreshold`, then 2s / 10 polls; it
  applies to resumed runs too. `liveness()` warns when
  `poll_seconds x stall_polls` is not below `timeout_seconds`.

### Added — `source.protocol` declares how the sending side is reached (#182)

`source` now takes an optional `protocol`: `prefunded` (default; the operator
already holds the bridge asset, needs only `name`/`asset`), `sep6` (requires
`endpoints.transfer_server`), `sep24` (requires `endpoints.transfer_server_sep24`
and `endpoints.web_auth`), or `custom:<id>` (requires `endpoints.base_url`).
Schema only; the engine does not act on it yet. Manifests that omit `protocol`
parse as `prefunded`, so existing corridors are unchanged. `corridor plan` now
prints the source protocol.

### Added - Per-corridor circuit breaker with a CLI and Prometheus counters (#165)

Repeated settlement failures against one anchor are one broken anchor, not N
incidents, and each retry spends another fee to relearn the same fact. After
`recovery.breaker.consecutive_failures` consecutive lane failures (default `3`)
the corridor is **halted**: new payments are refused with `CORRIDOR_HALTED`
(HTTP 503) before a run is created, so nothing reaches the anchor. A run already
past settlement still reconciles and completes — a halt blocks new work, never
money the anchor is holding. A halt is sticky: only an explicit reset reopens it.

- `@corridor/manifest`: optional `recovery.breaker.consecutive_failures`.
- `@corridor/engine`: `CorridorHealthStore` port, `InMemoryCorridorHealthStore`,
  `PostgresCorridorHealthStore` (one atomic upsert, so concurrent failures cannot
  lose a count or double-claim a trip), and `MeteredCorridorHealthStore`. The
  `corridor_breakers` table ships from the existing `migrate()` entry point.
  This replaces #366's unwired stub store (`health-pg.ts`); the public names
  `CorridorHealthStore` and `PostgresCorridorHealthStore` now come from the
  breaker implementation.
- **Table migration:** databases that ran `migrate()` since #366 already hold an
  older `corridor_breakers` (states `up`/`down`, no `reset_at`). `migrate()` now
  adds `reset_at`, changes the `state` default to `closed`, and maps legacy
  `up` -> `closed` and `down` -> `open`. All statements are idempotent; re-run
  `migrate()` once on upgrade.
- A lane failure is counted when a run resolves to `refunded` or `held` (using the
  original settlement/reconcile cause), not when it parks in `refund_pending`.
- Metrics: `corridor_breaker_tripped` (once per halt), `corridor_breaker_refused`
  (traffic turned away) and `corridor_breaker_reset`, each labelled `corridor`.
  Opt-in — with no `deps.health` there is no gate, no state, and no series.
- `corridor breaker status [corridorId]` and `corridor breaker reset <id>
--reason "…"`, reading the same `DATABASE_URL` the engine uses. The reason is
  mandatory and stored with the OS user who ran it; there is no `--force`.
- Runbook and alerting in `docs/operations.md` §7.

### Added — `corridor canary` records a chain-verified proof in the manifest (2026-09-27)

`corridor canary <file> --amount <decimal> [--write]` drives one tiny real
payment and, on `completed`, prints the `proof:` block it earned. With
`--write` it also records that block in the manifest through the `yaml` Document
API, so every hand-written comment in the file survives the edit.

The proof is chain-verified, not engine-asserted: before any write,
`AccountInspector.settlementFacts()` reads the settlement back from Horizon and
`verifySettlementFacts()` checks destination, amount, asset and memo
against the run. A `failed`, `held` or `refunded` run returns before the
manifest is even read, leaving it byte-identical.

Liveness gains a fourth state, `PROVEN`, for a corridor whose `proof` is still
inside `proof.max_age_days` (default 30). A stale proof drops the lane back to
`VERIFIED` with a warning; a proof on a lane whose endpoints were never verified
never promotes it. `canary_max_amount` (default `10.00` until recorded) caps
future canaries. `proof` is optional, so every existing manifest still parses.

### Added — corridor canary CLI command (#161) (2026-09-30)

Added `corridor canary <file.corridor.yaml> --amount <amount> [--network public]` CLI subcommand
and shared wiring module (`@corridor/cli/wire`):

- Drives one full, gated payment through the real stack (`Sep31Adapter`, `StellarSettlementSubmitter`, pre-settle gate, `RegistryRouteResolver`).
- Refuses unless amount ≤ `proof.canary_max_amount` (defaults to `10.00`) and corridor liveness is at least `verified`.
- Requires `--network public` to run on mainnet; default refuses mainnet manifests.
- Pre-settle gate (`balanceCheck`) verifies sender balances and reserve before on-chain settlement.
- Engine: added optional `gate` to `EngineDeps` and evaluate before advancing to `settling`.
- Manifest: added optional `proof.canary_max_amount` to `CorridorSchema`.
- Reused wiring in both CLI canary subcommand and `examples/verify-corridor.ts`.

### Docs — `web/README.md` matches the app again: three liveness states, six docs pages, own workspace root (#126) (2026-09-29)

`web/README.md` described the app it documents in three stale ways: it called the
dashboard's build-time liveness "runnable / not runnable" when the dashboard has
three states — `verified` / `unverified` / `not runnable`, and only `verified`
counts as runnable — it listed five of the six shipped docs pages (omitting "Why
not Anchor Platform?"), and it called the app "not part of the pnpm workspace"
although `web/` has been its own pnpm workspace root since #80
(`web/pnpm-workspace.yaml`, with its own lockfile and its own CI job).
Documentation only — no code, no behaviour change.

### Added — Gate check: re-read receiver SEP-12 status and require ACCEPTED (#156) (2026-09-30)

Added `receiverKycCheck(adapter)` GateCheck (name `sep12.receiver`) in `@corridor/sep31`:

- Calls `adapter.ensureCompliance(intent, corridor)` right before settlement to verify receiver status is still accepted.
- Fails closed with `PRESETTLE_RECEIVER_NOT_ACCEPTED` on `PROCESSING`, `NEEDS_INFO`, `REJECTED`, or anchor errors (e.g. HTTP 500).
- For corridors without a `kyc_server`, passes with `detail: "no SEP-12 server"` so the audit trail clearly distinguishes unverified lanes from verified ones.
- Added `PRESETTLE_RECEIVER_NOT_ACCEPTED` to `CorridorErrorCode` in `@corridor/types`.

### Maintenance — ESLint 10 landed

- `eslint` 10 landed in [#37](https://github.com/ezedike-evan/corridor-in-a-box/pull/37).
  The older deferred-upgrade note below records the state at the time; the
  `vitest` major-version upgrade remains deferred.
- Until a `v0.1.0` tag exists, [Unreleased] links to repository commit history
  rather than a release comparison. The historical 0.1.0 section below remains
  unlinked until its release commit can be tagged.

### Added — Pre-settle gate and corridor-halt error codes (#139) (2026-09-25)

Added 9 dedicated pre-settle gate and circuit breaker error codes to `CorridorErrorCode`:

- `PRESETTLE_ANCHOR_DRIFT` — live /info or stellar.toml no longer matches what was verified
- `PRESETTLE_TX_MISMATCH` — the opened anchor transaction is not what we are about to pay
- `PRESETTLE_DESTINATION_UNSAFE` — destination missing, no trustline, or not authorized
- `PRESETTLE_INSUFFICIENT_FUNDS` — our balance cannot cover amount + fee + reserve
- `PRESETTLE_QUOTE_WINDOW` — firm quote will not survive settle + confirm
- `PRESETTLE_AMOUNT_OUT_OF_RANGE` — outside anchor or manifest min/max
- `PRESETTLE_RECEIVER_NOT_ACCEPTED` — SEP-12 status is no longer ACCEPTED
- `CORRIDOR_UNPROVEN` — amount above the canary cap on a non-PROVEN lane
- `CORRIDOR_HALTED` — per-corridor circuit breaker is open

Added helper `isPreSettleCode(code): boolean` in `@corridor/types` and mapped the error codes in `@corridor/service` HTTP router.

### Added — `TransactionStatus` carries the anchor's expected amount, deposit account and memo (2026-09-26)

`Sep31Adapter.getTransaction` read only `status`, `amount_in`,
`amount_in_asset` and `refunds` off `GET /transactions/:id`, so the opened
transaction could not be cross-checked against the payment about to be sent.

`TransactionStatus` now has optional `amountIn` (`Money`), `depositAddress`,
`memo` and `memoType`, parsed from `amount_in`/`amount_in_asset`,
`stellar_account_id`, `stellar_memo` and `stellar_memo_type`. As with
`refunds`, each is read on its own and anything malformed — including a numeric
`amount_in` — is omitted, never guessed; status classification is unchanged.
`createMockAdapter` reports back what each opened transaction was given. The
change is additive: other adapters may leave the fields undefined.

### Changed — web/ migrated to Next.js 16 and TypeScript 7 (#85) (2026-09-02)

`web/`'s `next` 15 → 16 bump landed in #11 as a dependency change only; the
migration itself is now done. `web/tsconfig.json` sets the React automatic
runtime and the generated route-type include that Next 16 mandates (it was being
rewritten by `next build` on every run, leaving the checked-in file out of step
with what was compiled), and `web/next.config.ts` pins `outputFileTracingRoot`
to the repo root so the workspace-root warning is gone with it. No application
source changed.

### Added — `reference-corridor` CI job runs a whole corridor (#75) (2026-09-02)

`.github/workflows/reference-corridor.yml` drives one payment through every leg
— quote → comply → open → settle → reconcile → completed — against the Anchor
Platform reference stack, on its own schedule. `scripts/reference-anchor.sh
doctor` and `pnpm verify:corridor` gate the job up front, so a missing or
renamed prerequisite is reported in seconds rather than four minutes into a
container.

### Added — reconcile stall detection: `RECONCILE_STALLED` (HTTP 504) (#71) (2026-09-01)

`reconcileUntil` can now tell an anchor that is slowly progressing apart from
one whose observer is stuck on the same status. When `stallThreshold` is set
(production default 10 consecutive polls; `0` disables it) and that many polls
return an identical status, the engine fails early with the new public error
code **`RECONCILE_STALLED`**, carrying the stuck status and the consecutive
count, and recovers (refund / hold / give-up) instead of waiting out the whole
corridor deadline. `RECONCILE_STALLED` maps to **HTTP 504** in
`@corridor/service`, alongside `SETTLEMENT_TIMEOUT`.

### Changed — every reconcile poll is logged and counted (#69) (2026-09-01)

`reconcileUntil` was silent between "submitted" and "settled". The engine's
injectable `Logger` and `Metrics` are now threaded through it, and each poll
emits a `debug` log (`corridor.reconcile.poll` with `transactionId`,
`status`, `poll` and `elapsedMs` — never full transaction bodies) plus a
counter metric tagged with `corridor` and `status`. `LogLevel` gains
`"debug"` for this.

### Changed — `SETTLEMENT_TIMEOUT` carries poll count, elapsed, and first/last status (#70) (2026-09-01)

The timeout error used to name only the last observed status, which made a slow
anchor indistinguishable from one that never updated. It now carries the poll
count, elapsed milliseconds, and both the first and last observed status, and
stays non-retryable so a timeout can never re-settle a payment.

### Added — anchor-driven refunds on the `AnchorAdapter` port (#72) (2026-09-01)

A payment credited to a third-party anchor cannot be reversed unilaterally
on-chain, so refunds are modelled as an anchor-driven operation.
`AnchorAdapter` gains `requestRefund(transactionId, amount, reason)` and the
`RefundPayment` / `RefundStatus` / `RefundRef` types; an anchor that does not
support refunds rejects with `REFUND_UNSUPPORTED`. The engine wiring that polls
an anchor-driven refund is deliberately not part of this change.

### Added — mock adapter can simulate refund outcomes (#77) (2026-09-01)

`MockAdapterOptions` gains a `refund` flag so tests can choose a branch: the
anchor accepts and completes a refund, accepts and leaves it pending, or rejects
it. Defaults are unchanged, so existing tests and engine behaviour are untouched.

### Tests — live-anchor run asserts `completed`, not merely `settled` (#73) (2026-09-01)

The SEP-31 live suite exercised SEP-10, SEP-38 and the conformance probes but
never asserted the terminal state. A new env-gated case runs a full `execute()`
for one payment and asserts the run reaches `completed` and that the trail
contains `settled → reconciled → completed` in order. On failure it prints the
stored state, trail, `lastError`, anchor transaction id and Stellar tx hash
instead of a diff.

### Tests — engine coverage for the refund path (#74) (2026-09-01)

`refundAndStop` had no tests of its own even though every branch in it runs
after something has already gone wrong. Six new cases cover which terminal state
is reached, which reason is recorded, and whether the chain was touched. The
anchor-driven `refund_pending` polling path stays uncovered until the engine
wires it up.

### Tests — crash-resume integration test never double-settles (#76) (2026-09-01)

An env-gated integration test runs a payment to `completed`, simulates a crash
by winding the persisted run back to `settled`, then resumes with the same
idempotency key and asserts the run completes through
`settled → reconciled → completed` with exactly one on-chain payment ever
submitted.

### Changed — `web/` is its own pnpm workspace root (#80) (2026-09-01)

Dependabot could never update `web/pnpm-lock.yaml`: with no workspace marker of
its own, a resolver starting in `web/` walked up to the root workspace, saw
`web` was not an importer there, and wrote no lockfile, so every `/web` PR
failed `ERR_PNPM_OUTDATED_LOCKFILE`. Adding `web/pnpm-workspace.yaml` makes
`web/` a standalone workspace root.

### Changed — dependency bumps (#78, #79, #81, #82, #11) (2026-09-01)

Dependabot bumps: `github/codeql-action` to v4.37.6 (#78), `@types/node` to
^26.4.0 in `/web` (#79), `react-markdown` 9.1.0 → 10.1.0 in `/web` (#81),
`lucide-react` 0.456.0 → 1.24.0 in `/web` (#82), and the `next` 15.5.19 →
16.3.3 bump in `/web` (#11, migration finished in #85).

### Changed — attester rejections carry a typed contract error code (2026-09-24)

`AnchorAttester.attest` turned an attester-contract revert into a message such
as "too soon: this domain was attested within the cooldown window (contract
error #3)", and `examples/attest.ts` decided whether to fail the job by
checking that message for the word "cooldown". Rewording the message would
have silently turned every cooldown hit into a job failure (or the reverse).

`@corridor/attester` now exports `AttesterContractError` (mirroring the
contract's `enum Error`: `NotInitialised = 1`, `NotAnAttester = 2`,
`TooSoon = 3`, `InvalidDomain = 4`) and an `AttesterError` type: when the
contract itself rejected the attestation, the error carries its number as
`contractError`. `explain()` is exported and returns `{ code?, message }`.
`examples/attest.ts` now checks `contractError === AttesterContractError.TooSoon`.
The error `code` and message text are unchanged, so existing callers keep
working.

### Breaking — Pre-settle gate mandatory by default with explicit named opt-out (2026-09-25)

The pre-settle gate is now mandatory before settlement execution. In `EngineDeps`, callers must supply either `gate: PreSettleGate` (e.g. `defaultSep31Gate()`) or explicitly opt out with `unsafeSkipPreSettleGate: true`. If neither is provided, `execute()` fails fast immediately with error code `ENGINE_MISCONFIGURED` before claiming the idempotency key (ensuring no run row is persisted).

When opted out via `unsafeSkipPreSettleGate: true`, the engine passes through the `verifying` state, emits a warning log, and records a synthetic `gate.skipped` check on the transition audit entry. The `CompositeGate` runs checks concurrently, fail-closed, recording results on the `AuditEntry` and incrementing the `corridor.gate.check` metric.

### Added — `verifying` state between `opened` and `settling` (2026-09-25)

The engine moved straight from `opened` to `settling`, so a pre-settle gate done
inside `opened` would have been invisible in the trail — `opened -> failed` could
mean either "the anchor rejected the open" or "we refused to pay" — and it would
have run only once, while a retry re-entered `settling` after a backoff during
which balances, quote validity and anchor status can all change.

`verifying` makes the gate an auditable fact and, more importantly, an
unskippable one. `settling` is now reachable ONLY from `verifying`, so a
control-flow bug in `run.ts` cannot bypass it — the same "unreachable by
construction" argument the recovery states already make. `opened` and `retrying`
lost their direct edges into `settling`; every attempt walks
`opened -> verifying -> settling` on the first pass and
`retrying -> verifying -> settling` after a retry. A refusal is `failed`, never
`recovering`, because no money has moved and there is nothing to unwind. The
state and engine wiring shipped with the pre-settle gate (#353); this entry adds
the property tests that pin the invariant (#138).

### Added — Gate check: balance covers amount, fee and minimum reserve (#151) (2026-09-25)

Added `balanceCheck(inspector, signerPublicKey, opts?)` GateCheck (name `chain.balance`) in `@corridor/stellar`:

- Minimum reserve = `(2 + subentry_count + num_sponsoring − num_sponsored) × base_reserve`, computed strictly with `@corridor/types` decimal money helpers, never floats.
- Exposes `fee` from `StellarSettlementSubmitter` rather than duplicating `BASE_FEE`.
- Refuses before signing unless bridge asset balance − selling liabilities ≥ amount, and XLM balance − selling liabilities − minimum reserve ≥ fee (plus amount when bridge asset is XLM).
- Reports `PRESETTLE_INSUFFICIENT_FUNDS` with required vs available in `detail`.
- Added `AccountInspector` read-only Horizon inspector and typed account facts in `@corridor/stellar`.

### Security — soroban-sdk 25 → 27 clears GHSA-x57h-xx53-v53w (2026-08-31)

`contracts/Cargo.lock` pinned `stellar-xdr@25.0.0`, which carries a moderate
advisory ([GHSA-x57h-xx53-v53w](https://github.com/advisories/GHSA-x57h-xx53-v53w):
`StringM::from_str` accepts strings past the declared max length instead of
rejecting them). It was failing `dependency-review` on every PR.

It could not be patched in place. `soroban-sdk-macros` pins
`stellar-xdr = "=25.0.0"` exactly, and every 25.x release of the SDK locks to
that same vulnerable version, so neither `cargo update -p soroban-sdk` nor
`cargo update -p stellar-xdr --precise 25.0.1` could move it. The fix exists only
from soroban-sdk 26 onwards.

`soroban-sdk` moves to `"27"` (resolving 27.0.6), which brings `stellar-xdr`
27.0.0. **No contract source changed** — the 25 → 27 API surface used by these
contracts is unchanged, and all 21 tests, `cargo fmt --check`, `cargo clippy
--all-targets -D warnings` and the `wasm32v1-none` release build pass untouched.

`contracts/deployments.json` is deliberately left alone. The SDK bump changes
the compiled WASM, so the testnet contracts no longer match a `main` build
byte-for-byte, but nothing in the contracts calls the affected code: they handle
only `soroban_sdk::String` host handles, never `stellar-xdr` directly, and never
`StringM::from_str`. Redeploying testnet is worth doing to keep the recorded
addresses matching a `main` build, but it needs the deployer key and is a
maintainer decision rather than part of clearing the advisory.

### Added — `pnpm verify:corridor` (2026-08-31)

`pnpm verify:settle` proves the settle leg on live testnet. There was no
equivalent for a whole corridor run — quote → comply → open → settle → reconcile
→ completed — against the local reference server, so "does the full corridor
work end to end" was a manual, undocumented procedure.

`examples/verify-corridor.ts` drives one payment through every leg against the
Anchor Platform reference server and exits non-zero unless the terminal state is
`completed`. It is a gate rather than a capture: distinct exit codes let CI tell
"the stack was not ready" from "the corridor ran and did not complete", and the
trail is printed on both paths — reconstructed from the audit sink, so the
FAILING run gets one too, which is the case worth reading.

It fails early rather than hanging: `reference-anchor.sh doctor` runs before a
payment is opened, and the bridge asset is checked against the anchor's SEP-38
`/info` (its own statement of what it will quote) so a wrong issuer is named up
front instead of surfacing well after the quote. Every leg is pinned to the local
reference server regardless of what the manifest says, and a `network: public`
manifest is refused outright with no override — this runner drives payments at
localhost, so mainnet here is always a mistake rather than a decision.

### Added — `reference-anchor.sh doctor` (2026-08-31)

When the reference anchor's observer falls behind, the symptom is a corridor run
that reaches `settled`, polls for the whole of `recovery.timeout_seconds` and
then fails with `SETTLEMENT_TIMEOUT` — minutes spent discovering something that
was knowable before the run started.

`doctor` checks the stack up front and exits non-zero, naming the failing check,
so it can gate a CI job or a `verify:corridor` run: every expected container is
running, SEP-1 serves, SEP-31 `/info` advertises a non-empty receive list (the
asset codes are printed, since "which asset can I receive today" is the question
§1 tells you to ask), and the observer's cursor lag against Horizon.

The lag is reported as a number of ledgers rather than a boolean, because the
borderline cases are the ones worth seeing. It fails past
`CURSOR_LAG_FAIL_LEDGERS`, defaulting to 180 — the default
`recovery.timeout_seconds` of 900s at testnet's ~5s close time, past which an
observer cannot catch up to a fresh payment before the engine stops waiting.

### Fixed — reference anchor started its observer on a stale cursor (2026-08-31)

`scripts/reference-anchor.sh up` started the Stellar observer with whatever
cursor was already in the platform DB. When that cursor was behind the ledger
the settle leg landed in, the observer never matched the incoming payment and
the transaction sat at `pending_sender` until the engine gave up with
`SETTLEMENT_TIMEOUT` — the one full-stack attempt so far failed exactly this
way, and it read as an engine bug rather than the harness bug it was.

The cursor is not a config value: Anchor Platform 2.x keeps it in the platform
DB (`stellar_payment_observer_page_token`, one row keyed `SINGLETON_ID`) and
only falls back to Horizon's latest cursor when that row is absent, so a row
left over from an earlier run is precisely how a stale value leaks into a fresh
start. `up` now clears that row and reseeds it from Horizon's current ledger
minus a safety margin, and prints the ledger it chose. Three ordering details
that all turned out to matter:

- The observer is started **after** the platform server rather than alongside
  it, because the table being seeded is created by that server's Flyway
  migration.
- Any running observer is **stopped before** the seed. A live observer writes
  its own paging token back to that row as it streams, so seeding underneath
  one is overwritten within milliseconds and the new cursor never takes effect.
- The observer container is recreated on every `up`, so it cannot resume from
  the position a previous run left behind.

`START_LEDGER`, `CURSOR_MARGIN_LEDGERS` and `HORIZON_URL` override the
behaviour; see the script header and `docs/operations.md` §1.

Two further fixes in the same path, both of which made the above unverifiable
until they were dealt with:

- Config extraction aborted `up` outright when its first `podman exec` raced
  the container's start, because `set -e` plus `pipefail` treats the failed
  command substitution as fatal. The probe is now guarded, which is what the
  surrounding retry loop always intended.
- The readiness-failure path dumped logs from a container named `ap`, which
  this script has never created, so a failed `up` printed nothing useful. It
  reads `ap-sep` now.

### Fixed — refunded runbook implied a reversal that never happens (2026-08-29)

`docs/operations.md`'s `refunded` section said the engine "reversed (or had
nothing to reverse)" the payment. With the real `StellarSettlementSubmitter`
the engine never reverses anything — `refund()` always fails and the run
escalates to `held` — so `refunded` is reachable only when no on-chain payment
ever went out. The old wording could send an operator away satisfied while
money sat with an anchor. The section now states the precondition plainly
(`stellar_tx_hash` must be unset; if set, treat as `held` and file a bug —
and an unset hash is the engine's belief, not proof: on an ambiguous
submission, verify against Horizon before declaring the sender whole), the
"why there is no automated refund" reasoning — on-chain reversal impossible,
and SEP-31 offering the sender no refund endpoint — appears once in full and
is linked from the `held`/`refunded` sections, and the `held` steps say
"contact the anchor" outright instead of gesturing at a refund flow that has
no API. ROADMAP's refund item gets the same precision.

### Added — SEP-31 refund initiation fails closed with `REFUND_UNSUPPORTED` (2026-08-29)

SEP-31 defines no sender-initiated refund endpoint: a refund is a decision the
receiving anchor makes on its own side, only reported back through the
transaction record's `refunds` object. So `Sep31Adapter.requestRefund()` is
now an explicit, documented fail-closed — it returns the new non-retryable
`REFUND_UNSUPPORTED` error code without touching the network, and the message
points at the out-of-band runbook path instead. Anything else would be a
bespoke, anchor-specific endpoint dressed up as protocol conformance; anchors
that do expose a proprietary refund API belong behind their own
`AnchorAdapter` implementation, not in `packages/sep31`. Nothing calls the
method yet (whether refund initiation belongs on the `AnchorAdapter` port is
a separate design decision); it exists to occupy the name with the refusal.
The engine's escalation of a refused refund to `held` is asserted at the
engine seam, the service maps the code to HTTP 501, the on-chain submitter's
refusal message now points at the out-of-band runbook instead of a "SEP-31
anchor refund" flow that does not exist, and `docs/sep-coverage.md` states
the scope boundary plainly.

### Added — `refund_pending` state for anchor-driven refunds (2026-08-29)

The corridor state machine gains `refund_pending`: "we asked the receiving
anchor to refund and are waiting to hear back." Today refunds always fail
immediately and the run lands in `held`, so the state has no producer yet —
but once refunds are anchor-driven they become asynchronous, and an async
operation with no state of its own is a run that looks finished while money
is still in motion. Entered only from `recovering`; exits only to
`refunded`, `held`, or `failed`; not terminal. It inherits `recovering`'s
double-spend contract in full — every successor is terminal, so `settling`
is unreachable from it by construction, and the property suite now asserts
that over all paths (the same all-paths check that historically caught
`settled -> recovering -> settling`). Both idempotency stores round-trip the
new state (it is just a string, but the tests assert it rather than assume
it, including against real Postgres).

### Fixed — probe missed single-quoted stellar.toml values (2026-08-11)

`tomlValue()` only matched double-quoted `KEY = "value"` lines. Both quote
styles are valid TOML, and real anchors use both — `cowrie.exchange`'s live
`stellar.toml` is entirely single-quoted, so a live probe against it detected
only SEP-1 (the toml itself) and silently missed its real SEP-10, SEP-12, and
SEP-31 support. Found by actually running `@corridor/probe` against a real
anchor rather than only against test fixtures, which had only ever used
double quotes. Fixed to accept either quote style; regression tests in
`tests/probe.test.ts` cover both. Re-probing after the fix confirmed
`cowrie.exchange` for real: SEP-10 challenge signed and exchanged for a JWT,
SEP-12 answered, SEP-31 `/info` returned a non-empty receive list (NGNT,
USDC) — added as the `ng-cowrie` corridor in `web/lib/corridors.ts`, the
first corridor in the repo with `endpoints_verified_at` actually set. No
SEP-38 quote server is published, so its `quote_source` is `external`, and no
payment has been attempted — a real settlement still needs a KYC'd business
relationship with Cowrie that this repo does not have.

### Fixed — correctness & security (2026-08-10 audit)

A second audit pass, this time over the settle leg, the on-chain registry
probe, and credential comparisons. Each finding below is covered by a new
regression test (`tests/stellar.test.ts`, `tests/engine.test.ts`,
`tests/probe.test.ts`, `tests/types.test.ts`).

- **An ambiguous Stellar submission was blindly retried — a real
  double-payment path.** `StellarSettlementSubmitter.submit()` caught every
  exception from `submitTransaction()` identically, including a client-side
  network timeout that can happen AFTER Horizon already applied the
  transaction. The retry loop then built and sent an independently-valid
  second payment for the same amount and destination. `submit()` now
  distinguishes a confirmed Horizon rejection (`TransactionFailedError`,
  e.g. `tx_bad_seq` — safe to retry) from a genuinely ambiguous failure,
  which it resolves by looking the transaction up by its precomputed hash
  before deciding, mirroring the pattern `@corridor/attester` already used
  correctly. `confirm()`'s own poll-timeout path was also flipped from
  retryable to non-retryable for the same reason — a confirmation timeout on
  an already-accepted transaction is read-side lag, not proof of failure.
- **No serialization across concurrent settlements from one signer.**
  `loadAccount()` was called fresh, unlocked, on every `submit()` — two
  concurrent payments from the same account could read the same sequence
  number and race. Added a minimal per-instance async lock around
  `loadAccount → build → sign → submitTransaction`, released immediately
  after submission (not held through the slower `confirm()` poll, so one
  ambiguous submission can't head-of-line-block every other in-flight
  payment).
- **A firm quote's expiry was checked once, then never again for the rest of
  the settle/retry loop.** A slow anchor or a couple of retries could settle
  at a stale, no-longer-honoured rate with no error. The retry loop now
  re-checks `expiresAt` on every pass and fails closed (`QUOTE_EXPIRED`)
  rather than submitting against a dead quote.
- **SSRF via unvalidated `stellar.toml` endpoints in `@corridor/probe`.**
  `WEB_AUTH_ENDPOINT` / `ANCHOR_QUOTE_SERVER` / `KYC_SERVER` /
  `DIRECT_PAYMENT_SERVER` were fetched straight out of a target domain's own
  toml with no host or scheme validation — reachable via the repo's own
  "open a PR to add an anchor domain" flow. Added `isSafeUrl()`
  (`packages/probe/src/url-safety.ts`), a single choke point in the shared
  `get()` helper that refuses non-`https` and loopback/link-local/RFC1918/
  metadata-endpoint hosts. Hostname/IP-literal only — does not close DNS
  rebinding, tracked as a follow-up.
- **Non-constant-time credential comparisons.** The web payments route's
  bearer check and `@corridor/service`'s API-key/owner checks used ordinary
  `!==`/`Set.has()`, which leak timing information about how much of a
  presented credential matched. Added `constantTimeEqual` (`@corridor/types`)
  and used it at every credential-comparison site; `Set.has()` lookups now
  iterate and compare every candidate in constant time rather than
  short-circuiting on the first (or hash-bucket) match.
- **`release.yml`'s tag/version-match guard could be bypassed via manual
  `workflow_dispatch`.** The check only ran `if:` the ref was a `cli-v*` tag
  push; a manual dispatch run skipped it entirely and published whatever
  `package.json` said. The check now runs unconditionally on both trigger
  paths, looking up a matching tag by commit SHA when the ref itself isn't
  one.
- `contracts/{registry,attester}/test_snapshots/` (soroban-sdk `testutils`
  ledger-state dumps) are no longer tracked in git — nothing reads them
  back, they regenerated dirty on every `cargo test` run, and their missing
  trailing newline broke `pnpm lint` for anyone who ran the contract tests
  first.
- Bumped `typescript-eslint` and `tsup` to clear their patched advisories
  (brace-expansion DoS, esbuild dev-server file read). At the time, `vitest`
  and `eslint` carried the remaining dev-only advisories and needed major-
  version bumps (2→5, 9→10) to clear them; those upgrades were deferred as
  separate, deliberate work. `pnpm audit --prod` was clean, and none of those
  dependencies shipped in a built artifact.

### Fixed — correctness & security

Findings from an audit of this repo. Each was confirmed by execution against the
code as shipped, and each is now covered by a regression test in
`tests/security.test.ts`.

- **Negative amounts settled.** `isValidAmount` is a _signed_ syntax check
  (`subAmounts` needs negatives) and was the only guard at both the HTTP boundary
  and the engine entry point, so `POST /payments` with `"-100.00"` returned
  `200 completed` and handed the negative amount to the settlement submitter.
  Added `isSettleableAmount` (well-formed **and** strictly positive) and used it
  at both boundaries, plus an optional per-corridor `limits.max_amount` ceiling.
- **KYC was checked against the wrong account.** The SEP-12 status query was
  keyed to the operator's own SEP-10 signing account whenever a signer was
  configured — which is every production wiring — so `comply` answered "is the
  operator in good standing?" and recorded the result as the _recipient's_
  verdict. It now queries the recipient's SEP-12 customer id
  (`PartyRef.sep12Id`) and fails closed when there isn't one. Relatedly,
  `openTransaction` now sends `receiver_id`/`sender_id`, which it previously
  omitted entirely.
- **SEP-10 authentication failed open.** `authToken()` returned `undefined` on
  every failure path and callers proceeded _anonymously_, so an anchor that
  errored on `/auth` still had its SEP-12 answer accepted as an authenticated
  compliance verdict. Auth failure is now a hard, retryable error whenever a
  signer is configured.
- **`GET /payments/:key` leaked across tenants.** Any valid API key could read
  any run — including its `stellarTxHash` — by guessing a caller-chosen
  idempotency key. Runs now carry an `owner` set from the validated credential,
  reads are scoped to it, and only the error _code_ is returned rather than the
  stored message (which carries anchor URLs and upstream response bodies).
- **Failed authentication was not rate-limited.** The `401` returned before the
  limiter, so API keys could be brute-forced at line rate. Rate limiting now runs
  first.
- **The rate limiter was bypassable.** It keyed off the _unvalidated_ bearer
  token, so rotating the token minted a fresh bucket per request. It now keys off
  a recognised key, falling back to the client IP.
- **The SEP-38 `sell_amount` was discarded.** The anchor's own sell amount was
  parsed and thrown away, so the settle leg paid the amount originally requested
  rather than the one the firm quote bound to. Quotes are also now rejected when
  `buy_amount` contradicts `price × sell_amount` beyond a rounding tolerance.
- **The web API route lent out its credentials.** It proxied any anonymous
  caller's body to the internal `@corridor/service` _with the server's API key_
  attached. Proxying now requires `CORRIDOR_WEB_API_KEY` and fails closed if the
  proxy is configured without one. Added a request body-size cap; the demo's
  in-memory run store is now bounded.
- **Security headers.** The web app now sends CSP, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`.
- **Stuck spinner.** A failed `fetch` in the payment runner threw with `running`
  still true, disabling the button until a page reload. Also fixed the failed-step
  highlight, which was computed from a hardcoded state and never rendered.

### Changed — honesty of reported status

- **Liveness now has three states, not two.** `runnable`/`not runnable` was
  derived purely from whether an endpoint string was non-empty, so a manifest
  naming a fictional anchor was reported as healthy by both `corridor plan` and
  the dashboard. Corridors are now `VERIFIED` (endpoints confirmed against a
  published `stellar.toml` on a recorded date, via the new
  `dest.endpoints.endpoints_verified_at`), `UNVERIFIED` (present but unchecked —
  **the honest default**, and where every corridor in this repo currently sits),
  or `NOT RUNNABLE`.
- **`mx-bitso.corridor.yaml` renamed to `mx-example.corridor.yaml`** and stripped
  of the company name. Its endpoints are and always were fictional; naming a real
  company on it implied a relationship that does not exist.
- **Two ROADMAP items reverted from ✅ to ⬜** because they did not survive a code
  read: Corridor #1 (a template with placeholder endpoints, not a live lane) and
  "Real refund path (reverse settlement)" (`refund()` unconditionally fails —
  what ships is escalation to a manual `held`, not a reversal). The grant
  proposal's corresponding claims were corrected the same way.

### Added

- GitHub issue and PR templates.
- Separate CI job that typechecks and builds the `web/` showcase app.
- `author`/`maintainers`/`repository` metadata in `package.json` (so the
  `SECURITY.md` reporting pointer resolves).
- `CHANGELOG.md` and `.env.example`.
- Request body-size limit in `@corridor/service` (memory-DoS guard).
- Explicit SEP-31 lifecycle status mapping (`mapSep31Status`) plus contract-shape
  tests for the adapter.
- Env-gated integration test against a real SEP-31 server (`tests/integration/`).
- `docs/operations.md` (runbook) and `docs/sep-coverage.md` (SEP-31 vs SEP-6/24).
- `IdempotencyStore.create()` — an atomic claim (conditional `INSERT … ON
CONFLICT DO NOTHING` in Postgres) implemented by both stores, plus regression
  tests for the concurrent-claim path.
- `PrometheusMetrics` — a zero-dependency `Metrics` sink that renders Prometheus
  text exposition, plus a `metricsText` option on `@corridor/service` that serves
  it at `GET /metrics` (public + unmetered). Runbook gains a Metrics & alerting
  section with `held`/`failed` alert rules.
- Pluggable rate limiting: a `RateLimiter` interface and `rateLimiter` service
  option so a shared (e.g. Redis) limiter can replace the per-process
  `TokenBucket` for multi-replica deployments.
- `gracefulShutdown(server)` helper to drain in-flight requests on SIGTERM/SIGINT.
- One-command testnet runner (`pnpm testnet` → `examples/run-testnet.ts`) wiring
  the real adapter + submitter + Postgres store to capture a live run; refuses
  mainnet without `CORRIDOR_ALLOW_MAINNET=1`.
- Live-Postgres integration test for `PostgresIdempotencyStore` (concurrent
  `create()`, version-guarded `put()`), gated on `CORRIDOR_TEST_DATABASE_URL`,
  with a Postgres service-container CI job.
- The `web/` API route now proxies to a real `@corridor/service` when
  `CORRIDOR_SERVICE_URL` is set; the in-repo simulation is fenced as demo-only.
- README status badges (CI, license, Node).
- One-command service runner (`pnpm serve` → `examples/run-service.ts`) wiring
  the real adapter/submitter/store behind `createService().server().listen()`
  — previously the service was importable but nothing ever started it. Serves
  every corridor manifest in `corridors/`, skipping `network: public` lanes
  unless `CORRIDOR_ALLOW_MAINNET=1`.
- An on-page "build-time snapshot, not a live liveness feed" label on the web
  dashboard's Corridors section — the underlying data was already disclosed in
  a code comment, now it's visible on the page itself.
- Dedicated unit tests for `@corridor/cli`, `@corridor/router`, and
  `@corridor/adapter-kit` — previously exercised only incidentally through
  other packages' tests; `conformanceSuite` had no coverage that actually ran
  in CI.
- `.github/CODEOWNERS`, `.github/dependabot.yml` (npm + github-actions,
  weekly), and a `feature_request.yml` issue template.
- `"engines": {"node": ">=22"}` in every package.json (root, `web/`, and all
  workspace packages), matching `.nvmrc` and the README's Node badge.
- SHA-pinned the GitHub Actions used in CI (previously floating `@v4` tags),
  plus new `codeql.yml` and `dependency-review.yml` workflows.
- `nightly-live-anchor.yml`: re-runs the opt-in live-anchor integration test
  on a schedule; inert until anchor secrets are configured.
- `docs/grant-proposal.md`: SCF Tier-2 draft with milestones mapped to
  ROADMAP.md; budget figures left as explicit placeholders.
- `@corridor/cli` is now npm-publish-ready: a `tsup` build step bundles it to
  a single `dist/index.js` (inlining `@corridor/manifest`/`@corridor/types`;
  `zod`/`yaml` stay real external dependencies), plus `bin`/`files`/
  `exports`/`description`/`license`/`repository`/`publishConfig`. Verified
  by installing the actual packed tarball into a scratch project and running
  the resulting `corridor` bin. The other 8 packages are unpublished still.
- `release.yml`: tag-triggered (`cli-vX.Y.Z`) npm publish workflow for
  `@corridor/cli` — full test suite, bundle build, a smoke run of the built
  bin, a tag↔package-version check, then `npm publish --provenance`. Needs
  one repo secret (`NPM_TOKEN`).
- The live-anchor suite (and the nightly workflow) now honours
  `ANCHOR_ASSET_ISSUER` / `ANCHOR_DEST_ASSET`, and `.env.example` + README
  document verified known-good values for the public SDF test anchor
  (`testanchor.stellar.org`) — the read-only probe runs against a real anchor
  with no self-hosted infrastructure.

- README links the live web dashboard (corridor-in-a-box.vercel.app), which
  the Vercel GitHub integration deploys from `main`.
- **On-chain anchor conformance registry.** New Soroban contracts
  (`contracts/registry`, `contracts/attester`) let an enrolled attester write
  probe-based SEP conformance data on-chain per anchor domain: the registry
  only accepts writes forwarded by the configured attester contract
  (`require_auth` chained through both), enforces a per-domain attestation
  cooldown, and caps storage (`MAX_DOMAINS`). Deployed to testnet — contract
  IDs committed in `contracts/deployments.json`; mainnet fields stay `null`
  by policy until a testnet deployment has been exercised for a wave. 21
  Rust tests, clippy clean.
- `@corridor/probe` — runs real SEP-10/SEP-38/SEP-31 conformance probes
  against a domain's published `stellar.toml` (auth challenge, firm-quote
  expiry check, non-empty SEP-31 receive list) and reports which SEPs are
  advertised vs. actually served.
- `@corridor/attester` — signs and submits a `ProbeResult` through the
  on-chain attester contract; maps raw Soroban host errors to
  operator-readable messages ("not an enrolled attester", "too soon: within
  the cooldown window").
- `attest-anchors.yml` (scheduled + manual dispatch) probes every domain in
  the new `contracts/anchors.json` and submits attestations on-chain when
  `ATTESTER_SECRET` is configured; `nightly-live-anchor.yml` now defaults
  `ANCHOR_*` env vars to public SDF testanchor values when the matching
  secrets are unset, so its live-anchor assertions actually run in CI
  instead of skipping.
- The web dashboard's "Attested anchors" panel now reads the on-chain
  registry (`web/lib/registry.ts`, via a Soroban simulation call — no
  signing key, no fee) instead of showing only the static corridor list.
  The page is incrementally re-rendered on an hourly `revalidate`, so what
  you see is real chain data up to an hour old — **not** a read per request,
  as this entry previously claimed. Each card still reports its own
  attestation age in ledgers, which is the number that actually matters.
  The Corridors section, which is still the static manifest, is explicitly
  labeled "manifest snapshot — not a live liveness probe" so the two are
  never confused.
- `@corridor/router` gained a registry-gated `RouteResolver`
  (`RegistryRouteResolver`): fails closed on an unreachable registry,
  refuses unattested domains, and enforces a max-staleness bound. Opt-in
  alongside the existing static resolver — not yet the default for
  `@corridor/engine` callers.
- `tests/money-properties.test.ts` and `tests/state-properties.test.ts` —
  property-based tests (round-trip/commutativity/associativity for money
  math over ~400 generated cases each; an exhaustive walk of the engine's
  state-transition graph). The state-graph walk found
  `settled -> recovering -> settling` was reachable in the transition table
  (never taken by actual control flow, but reachable by the table alone) —
  see the `retrying`/`recovering` split below.
- Upgraded `@stellar/stellar-sdk` 13 → 16 across every workspace package.

### Fixed

- **The SEP-38 quote request was spec-invalid and every live anchor rejected
  it.** The adapter sent `sell_asset: stellar:USDC` (no issuer — the anchor
  answers 404 `sell_asset not found`) and omitted the required `context`
  field (400 `Unsupported context`). Found by running the opt-in live suite
  against the SDF test anchor; mocks never caught it. `requestQuote` now
  sends `context: "sep31"` and the SEP-38 Asset Identification Format
  (`stellar:CODE:ISSUER`, or `stellar:native` when the bridge asset is XLM),
  with regression tests pinning the exact body. First live-verified firm
  quote followed immediately.

- `.env.example` documented `CORRIDOR_HORIZON_URL`, which nothing in the
  codebase reads — the real scripts read `HORIZON_URL`. Renamed, and added
  the previously-undocumented `MANIFEST`, `CORRIDOR_ALLOW_MAINNET`, and
  `CORRIDORS_DIR` variables.
- **Concurrent double-settlement window in the idempotency gate.** `execute()`
  previously gated on `get()` alone, so two callers racing the same
  `idempotencyKey` could both pass the check and both settle on-chain (the
  `put()` version guard only prevents the stored row from going backwards, not
  two in-flight runs). `execute()` now atomically claims the key via
  `store.create()` before any work and returns `IDEMPOTENCY_CONFLICT` to the
  loser. Addresses the double-settlement scope item in `SECURITY.md`.
- **Unbounded memory in the rate limiter.** The `TokenBucket` map never evicted
  client entries (and the key can be a spoofable `X-Forwarded-For`), an
  exhaustion vector. It now evicts fully-refilled idle buckets (behaviour-neutral)
  and keys off a transport-resolved client IP rather than a raw header — see
  `trustProxy`.
- A thrown error inside the HTTP request handler (e.g. an unreachable idempotency
  DB) now returns `500` instead of hanging the socket / risking a process crash.
- **First real testnet settlement.** `pnpm verify:settle`
  (`examples/verify-settle-leg.ts`) executed a real payment on Stellar
  testnet — transaction hash and ledger committed in ROADMAP.md — closing
  the "settle leg never actually run" gap.
- **Five spec bugs found by running against a real SEP-31 anchor.** Standing
  up the Anchor Platform reference server locally and running the full
  quote → comply → settle flow against it (rather than mocks) surfaced and
  fixed: a SEP-38 `price`/`total_price` inversion, memo type sent as text
  instead of hash, a missing `destination_asset`/`fields.transaction`, a
  SEP-12 `type` mismatch, and Horizon error responses swallowing
  `result_codes`. The resulting corridor run — SEP-10 auth, SEP-12
  registration for both parties, SEP-38 firm quote, SEP-31 transaction
  open, and a settle tx the anchor attributed by hash memo — landed with
  its transaction hash and ledger committed in ROADMAP.md. Separately, the
  new probe/attest packages above independently confirmed
  `testanchor.stellar.org`'s own SEP-31 receive list is empty, so it does
  not actually serve SEP-31 despite advertising it.
- **A settle failure that already moved money could be retried into a
  second payment.** The `recovering` state used to allow re-entering
  `settling`, so a settle failure discovered after reconcile (money already
  on-chain) could, per the state table alone, loop back into resubmitting.
  Found by the new exhaustive state-graph property test, not by any code
  path actually taking it. `recovering` is now split from `retrying`:
  `retrying` is the only state permitted to re-enter `settling`, reserved
  for failures known to have happened before money moved; `recovering` is
  terminal and cannot.

## 0.1.0 — 2026-06-18

Initial public release: the walking skeleton.

### Added

- `@corridor/types` — `Outcome<T>` no-throw result type and decimal-safe `Money`.
- `@corridor/manifest` — Zod schema + loader for a `*.corridor.yaml`; the corridor
  abstraction.
- `@corridor/adapter-kit` — `AnchorAdapter` port, conformance probes, mock adapter.
- `@corridor/sep31` — one adapter for any standards-compliant SEP-31 anchor
  (SEP-10 auth + SEP-12 KYC; crypto behind an injected signer).
- `@corridor/stellar` — settlement submitter + SEP-10 signer; `ExternalSigner`
  (KMS/HSM) port.
- `@corridor/router` — `RouteResolver` seam + static default.
- `@corridor/engine` — corridor-agnostic orchestration of quote → comply → settle
  → reconcile → recover, with a persisted state machine, crash-resume, recovery,
  audit trail, metrics hooks, and a durable Postgres idempotency store.
- `@corridor/service` — thin HTTP API over the engine (API-key auth, rate limit).
- `@corridor/cli` — manifest validation and an offline runnability `plan`.
- Reference, MX/Bitso, and NG→CN corridor manifests.
- Docs: key management, "why not Anchor Platform".

[Unreleased]: https://github.com/ezedike-evan/corridor-in-a-box/commits/main
