# Operations runbook

This is the operator-facing companion to the README's "Going live" section. It
covers the manual procedures the engine does **not** automate: capturing a
testnet run, recovering `held`/`refunded` payments, rotating the signing key,
running migrations, and the project's versioning/release policy.

> Pre-1.0; endpoints of one production anchor were probed live, the full money-moving run
> is automated by `pnpm verify:corridor` and the `reference-corridor` workflow, but
> `reconcile → completed` is still unproven — see the [ROADMAP](../ROADMAP.md).
> Treat this runbook as the plan for a self-run testnet/close-beta pilot, not a
> claim of production-readiness.

## 0. Adding an anchor to the fleet

`contracts/anchors.json` is the fleet's curated list of anchors. It is **not**
seeded automatically from the Stellar Anchor Directory (anchors.stellar.org):
the directory is a human-facing web app with no documented machine-readable
feed, so every entry is a deliberate, reviewed addition. Never invent a domain —
every entry must come from the directory or the anchor's own site.

To add an anchor:

1. Find it on [anchors.stellar.org](https://anchors.stellar.org) and open its
   `stellar.toml` (`https://<home-domain>/.well-known/stellar.toml`).
2. Record the home domain, the countries and currencies it serves, and the SEPs
   it claims (`TRANSFER_SERVER_SEP0031`, `ANCHOR_QUOTE_SERVER`, `KYC_SERVER`,
   `WEB_AUTH_ENDPOINT`).
3. Add a structured entry to `contracts/anchors.json` with those fields and a
   `$comment` noting where the data came from and when it was checked.
4. Run `pnpm test` — the validation test rejects malformed or duplicate entries.
5. Open a PR. A human reviews the diff; nothing writes the file automatically.

Spell the domain in its canonical form: lowercase letters, digits, dots, and
hyphens inside a label only — no scheme, no port, no path, no leading or
trailing `.` or `-`. `contracts/attester` refuses anything else with
`Error::InvalidDomain`, and `pnpm attest` refuses it before paying for a
simulation, because the registry keys records by the raw string: `Cowrie.Exchange`
alongside `cowrie.exchange` is one anchor with two permanent records.

## 1. Capturing the testnet end-to-end run

Endpoints of one production anchor were probed live, and the full money-moving
run is automated by `pnpm verify:corridor` and the `reference-corridor` workflow;
`reconcile → completed` is still unproven and remains the open Phase-1 item.

1. **Pick the anchor.** Two zero-agreement options:
   - **SDF test anchor** (`testanchor.stellar.org`) — public, always up, no
     self-hosting. Its endpoints are documented as known-good values in
     [`.env.example`](../.env.example) (read-only suite verified green
     2026-07-12). Check its `/sep31/info` first: an empty `receive` list means
     quotes/auth/KYC work but a money-moving transaction cannot be opened there
     that day.
   - **Self-hosted Anchor Platform reference server** (podman) — full control
     of the receive side; required if the public anchor exposes no receivable
     asset. Read its `stellar.toml` for the `DIRECT_PAYMENT_SERVER`,
     `WEB_AUTH_ENDPOINT`, `KYC_SERVER`, `ANCHOR_QUOTE_SERVER`.
2. **Fund a testnet distribution account** (Friendbot) and trustline the bridge
   asset. Keep the secret in `CORRIDOR_SIGNER_SECRET` (testnet only).
3. **Smoke-test read-only first** with the opt-in integration suite (see
   [`.env.example`](../.env.example)):
   ```bash
   ANCHOR_HOME_DOMAIN=… ANCHOR_SEP31_TRANSFER_SERVER=… ANCHOR_SEP31_QUOTE_SERVER=… \
   ANCHOR_SEP31_WEB_AUTH=… CORRIDOR_SIGNER_SECRET=S… \
   pnpm exec vitest run tests/integration/sep31-live.test.ts
   ```
4. **Pre-flight the manifest** offline:

   ```bash
   pnpm cli plan corridors/reference.corridor.yaml
   ```

   Expected output (abridged):

   ```
   liveness: ? UNVERIFIED — endpoints present but unconfirmed. NOT runnable.

   liveness warnings:
     ! dest endpoints are UNVERIFIED — the URLs below have never been confirmed against …
   ```

   `UNVERIFIED` is the correct and expected result for the reference corridor.
   `corridors/reference.corridor.yaml` points at `localhost` and deliberately has no
   `endpoints_verified_at` — setting that field on a localhost manifest would be
   meaningless. The warning about unconfirmed endpoints is the proof that the
   manifest is honest, not broken.

   What the pre-flight check is actually verifying here:

   - The manifest parses and validates (exit 0).
   - The liveness state is **not** `NOT RUNNABLE` — every required endpoint field
     (`transfer_server_sep31`, `quote_server`, `kyc_server`) is present. A
     `NOT RUNNABLE` result or a "quotes will fail / no per-customer KYC" warning
     means the manifest has a structural gap that will break the run.
   - The output is **not** `✓ VERIFIED` — a localhost manifest that somehow
     reported verified would be the lie to catch.

   The live readiness check — are the containers up, is SEP-31 receiving, is the
   observer cursor in range — is `scripts/reference-anchor.sh doctor` (step 2 above,
   or run it again here):

   ```bash
   scripts/reference-anchor.sh doctor
   ```

   That command exits non-zero and names the failing check, so it can gate CI.
   Run it after `up` and before driving a payment; `plan` cannot replace it for a
   self-hosted stack.

5. **Drive one payment** with the real implementations wired per the README's
   "Going live" list (`Sep31Adapter` + `StellarSettlementSubmitter` +
   `PostgresIdempotencyStore`, with an `audit` sink). Capture the resulting
   `trail` (the `created → … → completed` line) and the `stellarTxHash`, and paste
   them into the README.

When that trail is in the README, check off the last Phase-1 box in the ROADMAP.

### The self-hosted reference anchor

[`scripts/reference-anchor.sh`](../scripts/reference-anchor.sh) stands the SDF
Anchor Platform reference server up locally, so option 2 above needs no
agreement with anybody. It needs `podman`; everything is testnet.

```bash
scripts/reference-anchor.sh up             # start, wait for SEP-1 to serve
scripts/reference-anchor.sh doctor         # is the stack fit to run a corridor?
scripts/reference-anchor.sh status         # what is running
scripts/reference-anchor.sh logs           # tail ap-sep (pass a name for another)
scripts/reference-anchor.sh logs-dump [dir] # non-following dump of all container logs (used by CI on failure)
scripts/reference-anchor.sh down           # tear it all down
```

#### `doctor` - check before you run, not after

A corridor run against a sick stack does not fail fast. It reaches `settled`
and polls while waiting for the anchor to reconcile. If the anchor reports
unchanged statuses for the configured stall window, the engine stops early
with `RECONCILE_STALLED`—around 20 seconds by default. If statuses continue
changing but never reach a terminal state, polling continues until
`recovery.timeout_seconds` expires (900s by default), then fails with
`SETTLEMENT_TIMEOUT`.

A corridor can tune its reconciliation patience with
`recovery.reconcile: { poll_seconds, stall_polls }`; unset fields fall back to
`EngineDeps.reconcilePollMs` / `stallThreshold`, then 2s / 10 polls. In either
case, time spent waiting on a sick stack was spent learning something that was
knowable beforehand. Run `doctor` first:

```
reference anchor doctor

  ✓ containers       db reference-db kafka ap-sep ap-ref ap-obs
  ✓ sep1             http://localhost:8080/.well-known/stellar.toml
  ✓ sep31-info       receive: JPYC USDC
  ✓ cursor-lag       11 ledgers behind Horizon (limit 180)

✓ stack is fit to run a corridor
```

It exits non-zero and names the failing check otherwise, so it can gate a CI job
or a `verify:corridor` run:

```
  ✗ cursor-lag       5002 ledgers behind Horizon (limit 180) - a fresh payment will not be seen in time

✗ 1 check(s) failed
```

The lag is reported as a **number of ledgers**, not a yes/no, because the
interesting cases are the borderline ones. The default limit of 180 ledgers
was originally based on a 900s timeout, but with stall detection the practical
window is now ~20s: the cursor must be near the tip to catch a fresh payment
before the engine stops waiting. Set `CURSOR_LAG_FAIL_LEDGERS` to adjust the limit.

#### The observer cursor

The one failure that will waste an afternoon: the platform's Stellar observer
resumes from a **stale cursor**, never matches the payment your settle leg just
made, and leaves the transaction at `pending_sender` until the engine reports
`RECONCILE_STALLED`. That looks like an engine bug and is not one.

The cursor is not a config value — Anchor Platform keeps it in the platform DB
(`stellar_payment_observer_page_token`, one row keyed `SINGLETON_ID`) and only
falls back to Horizon's latest cursor when that row is absent. `up` therefore
clears the row and reseeds it from Horizon's current ledger on every start,
minus a small margin so a payment submitted immediately afterwards is still in
range, and prints the ledger it chose:

```
• Horizon is at ledger 4422632; starting the observer at 4422622 (margin 10)
• observer cursor seeded at ledger 4422622 (cursor 18995016852570112)
```

Override it when you need a specific starting point — replaying an older ledger
while debugging, or starting without network access to Horizon:

| Variable                  | Default                               | Effect                                                                 |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `START_LEDGER`            | _(unset)_                             | Start the observer at exactly this ledger, skipping the Horizon lookup |
| `CURSOR_MARGIN_LEDGERS`   | `10`                                  | Ledgers of slack below Horizon's tip                                   |
| `HORIZON_URL`             | `https://horizon-testnet.stellar.org` | Horizon to read the current ledger from                                |
| `CURSOR_LAG_FAIL_LEDGERS` | `180`                                 | Lag at which `doctor`'s cursor check fails                             |

```bash
START_LEDGER=4030900 scripts/reference-anchor.sh up
```

### `pnpm verify:corridor` — the whole run, as a gate

```bash
scripts/reference-anchor.sh up
CORRIDOR_SIGNER_SECRET=S… pnpm verify:corridor
```

Drives one payment through every leg against the local reference server and
exits non-zero unless the terminal state is `completed`. It prints the trail on
both paths — the failing run is the one worth reading:

```
trail: created -> quoted -> compliant -> opened -> verifying -> settling -> retrying -> verifying -> settling -> recovering -> refunded

✗ SETTLEMENT_FAILED — settlement submit failed: tx_failed operations=[op_src_no_trust]
  terminal state: refunded
```

Exit codes are distinct so CI can tell the cases apart: `2` missing
`CORRIDOR_SIGNER_SECRET`, `3` refused (mainnet manifest, or a bridge asset the
anchor does not quote), `4` the stack is not fit (`doctor` failed), `5` the
corridor ran and did not complete.

**The signer** must be a testnet account holding the corridor's bridge asset with
a trustline for it — `op_src_no_trust` above is exactly what a missing trustline
looks like. `pnpm verify:settle` needs no such setup because it settles in native
XLM; this one settles the asset the anchor actually quotes.

**Known sharp edge in the reference server:** a small `AMOUNT` makes its
`GET /rate` throw `Buy amount must be greater than zero`, which surfaces as
`QUOTE_UNAVAILABLE: quote HTTP 502`. `AMOUNT=1.00` reproduces it; the default of
`10.00` does not.

### `corridor canary --write` — recording the proof it earns

```bash
CORRIDOR_SIGNER_SECRET=S… pnpm cli canary corridors/ng-cowrie.corridor.yaml \
  --amount 1.00 --write
```

`verify:corridor` above is a PASS/FAIL gate. The canary is the other thing you
actually want on a lane: it runs one real payment and records **chain-verified
evidence** in the manifest, which promotes the lane from `VERIFIED` to `PROVEN`.

Three rules make the evidence worth something:

1. **Only `completed` writes.** A run that ends `failed`, `held` or `refunded`
   leaves the file byte-identical — no partial edit, no stale proof.
2. **The proof is chain-read, not engine-asserted.** Before touching the
   manifest, `AccountInspector.settlementFacts()` re-reads the transaction from Horizon and checks
   the destination, amount, asset and memo against what the engine actually got
   confirmed. A mismatch refuses the write.
3. **Comments survive.** The manifest is edited through the `yaml` Document API,
   so every hand-written explanation in the file is still there afterwards.

The recorded block:

```yaml
proof:
  canary_completed_at: "2026-09-27"
  stellar_tx_hash: 9f2c… # the settlement leg, not the anchor's own id
  anchor_transaction_id: 7b1e… # the SEP-31 transaction
  amount: "1.00"
  max_age_days: 30
  canary_max_amount: "1.00" # the ceiling future canaries must respect
```

`canary_max_amount` is a guard rail, not a suggestion: a canary above the
recorded ceiling is refused outright, and until a lane records one the ceiling
is `10.00`. `--network public` is required to canary a `network: public`
corridor, and past `max_age_days` the lane drops back to `VERIFIED` with a
staleness warning instead of quietly staying green.

### `corridor canary` — single real payment canary CLI command

```bash
scripts/reference-anchor.sh up
CORRIDOR_SIGNER_SECRET=S… corridor canary <file.corridor.yaml> --amount 10.00 [--network public]
```

Drives one full, gated payment through the real stack (`Sep31Adapter`,
`StellarSettlementSubmitter`, pre-settle gate, `RegistryRouteResolver`) and reports
whether it reached `completed`.

**Safety guards:**

- **Canary cap**: Amount must not exceed `proof.canary_max_amount` in the corridor manifest (defaults to `10.00` if unspecified).
- **Liveness requirement**: Corridor liveness must be at least `verified` (refuses `unverified` corridors).
- **Mainnet guard**: Running against mainnet manifests requires `--network public` to be passed explicitly.
- **Pre-settle gate**: `balanceCheck` gate validates sender balance and trustlines before funds move on-chain.

**Exit codes** mirror `verify:corridor`:

- `0`: OK (`completed` reached)
- `1`: Manifest parse/validation error
- `2`: Missing arguments or missing `CORRIDOR_SIGNER_SECRET`
- `3`: Refused (mainnet without `--network public`, over canary cap, or unverified liveness)
- `4`: Stack unfit (`doctor` check failed)
- `5`: Not completed (payment failed or did not reach `completed`)

### `corridor canary --dry-run` — everything up to the gate, no payment

```bash
CORRIDOR_SIGNER_SECRET=S… corridor canary <file.corridor.yaml> --amount 1.00 --dry-run
```

Runs SEP-10 auth, the SEP-38 quote, SEP-12 KYC, the SEP-31 open and every
pre-settle gate check against the real anchor, then stops before `settling`.
`SettlementSubmitter.submit()` is never called, so no money moves. The same
switch is `execute(intent, corridor, deps, { dryRun: true })` in code and
`--dry-run` on `pnpm example` / `pnpm testnet`.

- A dry run that passes the gate ends in `failed` with `DRY_RUN_COMPLETE` and
  exits `0`. Its gate results are on the `verifying` and `failed` audit entries.
  A gate refusal ends with that check's `PRESETTLE_*` code and exits `5`, as a
  real run would.
- `DRY_RUN_COMPLETE` is not a lane failure: it never counts toward the circuit
  breaker.
- The idempotency key is spent. Use a new key for the real payment.
- The receiving anchor is left holding an opened SEP-31 transaction that is
  never funded. Nothing needs cleaning up on our side: the anchor expires it
  under its own policy. Expect it to appear in the anchor's dashboard as
  `pending_sender` until then.
- `--dry-run` cannot be combined with `--write`: a dry run earns no proof.

## 2. Recovering a stuck payment

The engine drives recovery automatically per the manifest's `recovery.rollback`
policy (`refund_sender` / `hold` / `manual`). `held` always needs a human;
`refunded` needs a one-line verification.

Inspect any run by key: `GET /payments/:idempotencyKey` (or read the
`corridor_runs` row directly). `lastError` tells you why it stopped.

### Why there is no automated refund

Two independent constraints, same conclusion:

1. **On-chain reversal is impossible.** A credited Stellar payment is final;
   nobody can pull it back unilaterally.
   [`@corridor/stellar`'s `refund()`](../packages/stellar/src/index.ts) exists
   to say exactly that — it always fails, non-retryably, instead of pretending.
2. **SEP-31 gives the sender no refund endpoint.** In the protocol, a refund is
   something the _receiving_ anchor initiates on its own side and merely reports
   back on the transaction record. There is nothing for the engine to call.

So when recovery wants to return money that has already left the distribution
account, the engine cannot do it. It parks the run in `held` and a human
resolves it with the anchor, out of band. The only "automated refund" in this
system is the no-op case: nothing had gone out yet, so there was nothing to
reverse (that is what `refunded` means — see below).

### `held`

The engine reached a non-recoverable failure under a `hold` policy, **or** a
refund was needed and could not be performed (see
[why there is no automated refund](#why-there-is-no-automated-refund)). Funds
may have left the distribution account.

1. Read `stellar_tx_hash` from the run. If set, the bridge payment went out and
   is sitting with the receiving anchor. `lastError` tells you which door the
   run came through: under a `hold` policy it carries the **original failure**
   (`SETTLEMENT_TIMEOUT`, `RECONCILE_MISMATCH`, …) — the refund port was never
   consulted; under `refund_sender` it carries the **refund port's refusal**,
   which with the real `StellarSettlementSubmitter` reads
   `REFUND_UNSUPPORTED: payment … cannot be reversed on-chain`. The code is
   distinct from `SETTLEMENT_FAILED` on purpose: this is a design invariant,
   not a settlement outage, so it should not page the settlement alert.
2. **Contact the receiving anchor** — exactly that; there is no API for this
   step. Ask it to refund on its side or to complete the payout manually.
3. Once settled out-of-band, the run stays `held` as an audit record. Do not
   re-submit the same `idempotencyKey` — the idempotency gate will reject it.

**Timed out waiting on whom?** A `SETTLEMENT_TIMEOUT` message ends with the last
status the anchor reported. When that status is one the engine classifies as
_awaiting input_ — `incomplete`, `pending_customer_info_update`,
`pending_transaction_info_update` — the message also says
`awaiting input from another party`. That is the anchor telling you it was
blocked on information (usually a SEP-12 customer record or a
`PATCH /transactions/:id` correction), not that it was slow. Chase the party that
owes the information, not the anchor's throughput. Any other status — including
one the engine has never seen — means the anchor was working on it.

#### Stalled, not slow

If the run stops with `RECONCILE_STALLED` (mapped to HTTP 504 by the service),
the engine saw ~20 seconds of identical statuses from the anchor and aborted. The
message contains the status it was stuck at (e.g., `tx … stuck at status=pending_sender for 10 consecutive polls`).
This failure is non-retryable. If `stellar_tx_hash` is set on the run, the bridge
payment did go out to the anchor. Check the anchor's observer logs and its SEP-31
status history for the transaction to see why it never progressed.

### `refunded`

**The engine believes no on-chain payment went out.** Despite the name, nothing
was reversed — nothing can be (see
[why there is no automated refund](#why-there-is-no-automated-refund)). In
today's engine this state is reachable only when settlement never succeeded
under a `refund_sender` policy: the engine found no `stellar_tx_hash` on the
run, so there was nothing to undo, and it recorded `refunded` without touching
the chain. Verify the belief before closing the run:

- `stellar_tx_hash` must be **unset**. If it IS set (with the real
  `StellarSettlementSubmitter` that combination should be impossible; the
  mock's `refund()` does succeed, so test data can produce it), money left the
  account and the state is lying — treat the run as `held`, follow the steps
  above, and file a bug.
- An unset hash is the engine's belief, not proof: an **ambiguous submission**
  can land on-chain without the engine ever learning the hash (the submit
  succeeded but confirmation timed out on Horizon read lag, or the send itself
  ended ambiguously). Read `lastError` — on `SETTLEMENT_TIMEOUT` or an
  ambiguous-submit message, check Horizon for the distribution account's recent
  payments (the same check "Crash mid-flight" below prescribes for `settling`)
  before declaring the sender whole.

The state machine defines `refund_pending` (between `recovering` and `refunded`)
but no transition enters it yet — the engine does not call `requestRefund`. When
a producer lands, a payment that did go out and was returned by the anchor will
enter `refund_pending` with `stellar_tx_hash` set. The run's trail tells the
two apart — and `refund_id`, described below, records which refund it was.

### `refund_id` on the run

The run carries `refund_id` alongside `stellar_tx_hash`: the reference of a
refund that has already been requested, empty until one is.

It exists so a resumed run can tell "a refund was requested" from "a refund was
never requested". Without it a process that crashed after requesting a refund
comes back with no record of having done so and asks for a second one — not
settling twice, but money moving twice all the same. The refund request path
reads it and refuses to issue another.

Consequently it is **write-once**: `migrate()` adds the column additively, and
`put()` coalesces rather than overwrites, so a writer holding a stale copy of
the run cannot erase the evidence. If you see a run whose `refund_id` is set,
a refund reference exists at the submitter — check there before initiating
anything by hand.

### `failed` before `settled`

No payment went out (failure was at quote/comply/open). Safe to retry with a
**new** `idempotencyKey`.

When the failure carries a `PRESETTLE_*` code, the pre-settle gate refused the
attempt before the native payment operation was submitted. Resolve the cause,
then retry with a new key. Never bypass a failed gate by calling the submitter
directly.

A `failed` run with `DRY_RUN_COMPLETE` is not an incident: it was started with
`dryRun: true`, passed the gate, and stopped before settling as asked (see
`corridor canary --dry-run` above).

| Code                              | Meaning                                                             | Operator action                                                                  |
| --------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PRESETTLE_ANCHOR_DRIFT`          | Live `/info` or `stellar.toml` no longer matches what was verified. | Re-verify the anchor and update the manifest before retrying.                    |
| `PRESETTLE_TX_MISMATCH`           | The opened anchor transaction is not what is about to be paid.      | Do not pay; open a new transaction and investigate the anchor response.          |
| `PRESETTLE_DESTINATION_UNSAFE`    | Destination missing, has no trustline, or is not authorized.        | Confirm the destination account and its trustline/authorization with the anchor. |
| `PRESETTLE_INSUFFICIENT_FUNDS`    | Amount, fee, and reserve do not fit the distribution account.       | Fund the account, establish the bridge-asset trustline, or lower the amount.     |
| `PRESETTLE_QUOTE_WINDOW`          | The firm quote will not survive settle + confirm.                   | Request a fresh quote and retry promptly.                                        |
| `PRESETTLE_AMOUNT_OUT_OF_RANGE`   | Amount is outside the anchor or manifest min/max.                   | Adjust the amount to the advertised limits.                                      |
| `PRESETTLE_RECEIVER_NOT_ACCEPTED` | The receiver's SEP-12 status is no longer `ACCEPTED`.               | Complete or refresh the receiver's KYC before retrying.                          |
| `CORRIDOR_UNPROVEN`               | Amount is above the canary cap on a lane that is not yet `PROVEN`.  | Stay within the canary cap until the lane is proven.                             |

### `refund_pending`

After a payment has settled but the receiving anchor reports a terminal failure,
the engine enters `recovering → refund_pending`. The receiving anchor owns the
refund under SEP-31, so the engine polls `GET /transactions/:id` and does not
attempt a second on-chain reversal. A full `RefundInfo` report moves the run to
`refunded` and records the first refund payment id in write-once `refund_id`.
Partial or unknown refunds, and a silent anchor after
`recovery.refund_wait_seconds`, move to `held`; the run's `lastError` includes
the reported `amountRefunded` and `amountFee` when available. Contact the
anchor and resolve the held run out of band.

### `CORRIDOR_HALTED` and breaker reset

A corridor breaker protects a lane after repeated operational failures. New
payments are refused with `CORRIDOR_HALTED` until an operator verifies the
anchor, signer balance, and outstanding runs. Inspect the breaker and reset it
only after the cause is understood:

```bash
corridor breaker status [corridor-id]
corridor breaker reset <corridor-id> --reason "anchor healthy; balance restored"
```

The reset reason is part of the operator audit record. A reset is not a retry of
any existing idempotency key; held and failed runs remain unchanged.

### Resolving a held run

List held runs, contact the anchor or recipient, and record the out-of-band
outcome without mutating the payment state:

```bash
corridor runs list --state held
corridor runs resolve <idempotency-key> \
  --outcome refunded-offchain \
  --note "anchor refund reference rf_…"
```

Valid outcomes are `refunded-offchain`, `paid-out-manually`, and `written-off`.
The command refuses non-held runs and duplicate resolutions; `held` remains the
immutable payment audit state.

### Crash mid-flight

On restart, calling `execute()` again with the same intent auto-resumes from
`settled`/`reconciled` (re-polls, never re-settles). A run in
`refund_pending` resumes its refund watch; it never calls the settle leg again.
A run stuck in `settling` returns `IDEMPOTENCY_CONFLICT` — investigate whether
the payment went out (check Horizon for the distribution account) before
forcing any action.

## 3. Signing-key rotation

The distribution account's seed is the highest-value secret; see
[key-management.md](./key-management.md) for the `ExternalSigner` (KMS/HSM) port.

1. Stand up the new signer (new KMS key or new account) and fund/trustline it.
2. Drain in-flight work: stop accepting new payments, let outstanding runs reach
   a terminal state (watch `corridor_runs` for non-terminal rows).
3. Swap the `ExternalSigner` / `signerSecret` the `StellarSettlementSubmitter` is
   constructed with, and the SEP-10 `StellarSep10Signer` account.
4. Re-run the read-only integration suite against the anchor to confirm SEP-10
   auth still succeeds with the new account.
5. Revoke the old key once no run references it.

## 4. Database migrations

The durable store needs two tables: `corridor_runs` (idempotency) and, if you
adopt the circuit breaker (§7), `corridor_breakers`. Run the bundled DDL once at
startup or via your migration tool:

```ts
import { migrate } from "@corridor/engine";
// idempotent: CREATE TABLE IF NOT EXISTS corridor_runs (…), corridor_breakers (…)
await migrate(pool);
```

`migrate()` is the only migration entry point, so one command brings a database
up to date — a deployment that upgrades the engine and does not re-run it would
fail every payment on a missing table. The schema is intentionally tiny
(`packages/engine/src/idempotency-pg.ts`, `packages/engine/src/breaker-pg.ts`).
The `version` column carries optimistic concurrency — never edit it by hand. Any
future schema change ships as an additive migration with a CHANGELOG entry.

### The audit table is append-only

`migrate()` also creates `corridor_audit`, the durable trail written by
`PostgresAuditSink` (`packages/engine/src/audit-pg.ts`): one row per state
transition. `examples/run-service.ts` uses it whenever `DATABASE_URL` is set. A
retried write of the same transition is ignored, because of a unique key on
`(idempotency_key, version, to_state)`.

The code never updates or deletes an audit row. Make the database enforce that
too. Run `migrate()` as the role that owns the tables, and run the service as a
separate role that can only read and append to `corridor_audit`:

```sql
-- once, as the table owner, after migrate()
create role corridor_service login password '…';
grant select, insert, update on corridor_runs, corridor_resolutions, corridor_breakers
  to corridor_service;
grant select, insert on corridor_audit to corridor_service; -- no UPDATE, DELETE or TRUNCATE
grant usage on sequence corridor_audit_id_seq to corridor_service;
```

Don't run the service as the table owner: an owner can always update or
delete its own rows. `tests/integration/audit-pg.test.ts` checks that a role
granted only `SELECT`/`INSERT` is refused both.

To read a payment's trail, use `PostgresAuditSink.listAudit(idempotencyKey)`.
It returns the entries oldest first.

**When an audit write fails.** `record()` throws and `execute()` stops right
there. By that point the run's new state is already saved, so the payment
halts before its next step (it never moves money without an audit record) and
resumes from the saved state later. The transition whose write failed is not
recorded again on resume. It shows up as a missing `version` in that payment's
`listAudit()` output, so a gap in the versions means an audit write failed,
not that a step was skipped.

## 5. Scaling notes (before multi-replica)

- The service's **rate limiter and in-memory idempotency store are per-process**.
  Before running more than one replica:
  - Back idempotency with `PostgresIdempotencyStore` (shared). Its atomic
    `create()` claim + version-guarded `put()` make the double-settlement gate
    correct across replicas — the `IdempotencyStore` interface is the seam.
  - Inject a shared rate limiter via `ServiceOptions.rateLimiter` (the
    `RateLimiter` interface; `take()` may be async). The default `TokenBucket`
    is per-process; a Redis token bucket (a small `EVAL` Lua script doing
    refill-then-decrement against a per-client key) enforces the limit fleet-wide.
    Without it, each replica grants the full bucket independently.
- Set `maxBodyBytes` on the service for your payload size (default 64 KiB).
- Enable `trustProxy` **only** behind an ingress that sets `X-Forwarded-For` and
  strips any client-supplied value; otherwise leave it off so the socket peer
  address (which a client cannot forge) keys the limiter.
- Wire `gracefulShutdown(server)` to `SIGTERM`/`SIGINT` so a rollout drains
  in-flight payments instead of severing one mid-settle.
- Terminate TLS at your ingress; the built-in `node:http` server speaks plain HTTP.

## 6. Versioning & releases

- The project follows [Semantic Versioning](https://semver.org). **While pre-1.0,
  minor versions may contain breaking changes**; pin exact versions.
- All notable changes are recorded in [CHANGELOG.md](../CHANGELOG.md)
  (Keep a Changelog format). Every behaviour change updates the `Unreleased`
  section in the same PR.
- A release: move `Unreleased` to a dated, numbered section; tag `vX.Y.Z`; the
  tag is the source of truth for the changelog compare links.
- Only the latest `main` is supported; fixes are not backported (see
  [SECURITY.md](../SECURITY.md)).

## 7. Metrics & alerting

The engine emits counters/timings to an injected `Metrics` sink and one
`corridor.terminal{state=…}` counter on every terminal transition. To scrape
them with no client library, pass a `PrometheusMetrics` to BOTH the engine and
the service:

```ts
import { PrometheusMetrics } from "@corridor/engine";
const metrics = new PrometheusMetrics();
const service = createService({
  corridors,
  deps: { ...deps, metrics },
  metricsText: () => metrics.render(), // GET /metrics (public, unmetered)
});
```

Point Prometheus at `/metrics`. The two alerts that matter both key off the
terminal counter — they catch money that stopped needing a human (see §2):

```yaml
# Funds may be parked with the anchor; on-chain reversal isn't possible.
- alert: CorridorPaymentsHeld
  expr: increase(corridor_terminal{state="held"}[15m]) > 0
# A payment failed terminally (before or after settle).
- alert: CorridorPaymentsFailed
  expr: increase(corridor_terminal{state="failed"}[15m]) > 0
# A lane is refusing new payments until an operator resets its breaker.
- alert: CorridorBreakerTripped
  expr: increase(corridor_breaker_tripped[15m]) > 0
```

Useful companion series: `corridor_transition{to=…}` (throughput per state),
`corridor_breaker_refused{corridor=…}`, and the timing histograms
`corridor_verb_<verb>_seconds` (per-verb latency) and
`corridor_duration_seconds` (end-to-end). Timing observations are converted from
milliseconds to seconds; old `_ms_count`/`_ms_sum` samples are replaced by
histogram `_bucket`, `_sum`, and `_count` samples. Use `histogram_quantile()` for
latency percentiles, for example:

```promql
histogram_quantile(0.95, sum by (le) (rate(corridor_verb_settle_seconds_bucket[5m])))
```

Treat a rising `held`/`failed` rate as the page-worthy signal.

The Alerting port is the integration seam for paging: inject an implementation
that turns breaker trips, `CORRIDOR_HALTED`, and held refunds into the team's
incident channel. Keep the port asynchronous and idempotent so a metrics retry
cannot send duplicate pages.

### The circuit breaker

Repeated settlement failures against one anchor are not 3 independent bad
lunches — they are one broken anchor, and each retry spends another fee and
another round of reconciliation to learn what you already know. The breaker
stops that. After `recovery.breaker.consecutive_failures` consecutive lane
failures (default **3**) the corridor is **halted**: new payments are refused
immediately with `CORRIDOR_HALTED` / HTTP 503, and nothing is sent to the anchor.

What counts as a failure: `SETTLEMENT_FAILED`, `SETTLEMENT_TIMEOUT`,
`RECONCILE_MISMATCH`, `RECONCILE_STALLED`, and pre-settle failures (which carry
funds — `PRESETTLE_INSUFFICIENT_FUNDS` and any `PRESETTLE_*` sibling). A
rejected quote or a KYC denial does **not** trip it; those are the correct
outcome of a payment you should not be making. One success clears the count.

A failure is counted when the run **resolves** to `refunded` or `held`, using the
original settlement/reconcile cause. A run that is merely parked in
`refund_pending` (waiting on the anchor's refund report) is not counted yet.

Three properties worth knowing before you rely on it:

- **A halt only blocks new work.** A payment already past settlement still
  reconciles and completes, so a halt never strands funds the anchor is holding.
- **A halt is sticky.** Further failures do not clear it. Only an explicit
  `reset` reopens the lane, so a still-broken anchor cannot un-halt itself.
- **It is per-corridor.** A dead Argentine peso lane does not stop a lane to
  Kenya.

It is **opt-in**. Without a `CorridorHealthStore` in the engine's `deps.health`,
no breaker state is kept, no gate runs, and no series are emitted — so a
deployment that has not adopted it grows no always-zero series that looks like
something is being measured. To adopt it, wrap the store so the counters land in
your scrape target:

```ts
import {
  MeteredCorridorHealthStore,
  PostgresCorridorHealthStore,
  PrometheusMetrics,
} from "@corridor/engine";

const health = new MeteredCorridorHealthStore(
  new PostgresCorridorHealthStore(pool), // or InMemoryCorridorHealthStore()
  metrics, // the SAME PrometheusMetrics the service renders
);
const service = createService({ corridors, deps: { ...deps, health } });
```

State lives in `corridor_breakers`, created by the same `migrate()` call as
`corridor_runs` (§4). The increment and the threshold test are one atomic
upsert, so concurrent failures cannot lose a count and two replicas cannot both
claim the trip.

Three counters, each labelled `corridor`:

```yaml
# The page. A lane just went from trying to refusing.
- alert: CorridorBreakerTripped
  expr: increase(corridor_breaker_tripped[15m]) > 0
# Impact, not a separate incident: how much traffic the halt turned away.
- alert: CorridorBreakerRefusing
  expr: increase(corridor_breaker_refused[15m]) > 0
```

`corridor_breaker_tripped` fires **once per halt**, not once per failure while
halted, so it stays quiet until an operator acts. `corridor_breaker_refused` is
the impact side of the same incident — how much traffic the halt turned away.

> `corridor_breaker_reset` is emitted only by a process that observed the reset,
> and `corridor breaker reset` is a short-lived CLI process, so do **not** alert
> on it. For "did anyone reopen this, and on what grounds", read the durable
> `reset_by` / `reset_reason` / `reset_at` columns in `corridor_breakers` (shown
> by `breaker status`) — those outlive the process that wrote them.

### Reopening a lane

```sh
# What is halted, and since when, and what was the last error?
pnpm cli breaker status
pnpm cli breaker status ng-cn

# Reopen. The reason is mandatory and is stored with the OS user who ran it.
pnpm cli breaker reset ng-cn --reason "anchor confirmed healthy on testnet"
```

Both read `DATABASE_URL` — the same Postgres the engine uses, so the CLI and the
service can never disagree about whether a lane is halted. Exit codes: `0`
success, `1` environment/lookup failure (e.g. `DATABASE_URL` unset, no such
corridor), `2` bad usage (a missing `--reason`, an unknown flag). **There is no
`--force`**: if a reset needs justifying, that is the point of the command.

Two cases to read carefully in `status`:

- `UNKNOWN` means **no run has ever failed on that lane** — the absence of
  evidence, not evidence of health. A lane with no row is accepting work.
- `CLOSED` with a non-zero count is healthy but _near the threshold_. Check it
  before it becomes a page.

Reopen only after confirming the anchor is healthy (a testnet payment through,
the anchor's own status page). Clearing a halt on an unfixed anchor just
re-spends the fee that proved the lane was down. The reset is recorded, so a
later `tripped` right after a `reset` is a fast signal that the reopen was wrong.
