# Why SEP-24's interactive flow does not fit an unattended corridor

`corridor-in-a-box` drives cross-border payments unattended from a server-side state machine (`quote → comply → open → settle → reconcile`). Many real-world Stellar ramps (for example, MoneyGram Access and several retail cash-out anchors) expose **SEP-24** (`TRANSFER_SERVER_SEP0024`) rather than **SEP-31** (`DIRECT_PAYMENT_SERVER`) or **SEP-6** (`TRANSFER_SERVER`).

This document explains why SEP-24 cannot be dropped in as an unattended destination adapter, cites the relevant sections of the [SEP-24 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md), and records the options considered and architectural recommendation.

---

## 1. The interactive URL lifecycle requires a browser session

In SEP-31 (`POST /transactions`) and SEP-6 (`GET /withdraw` or `GET /withdraw-exchange`), the opening request is a single machine-to-machine HTTP call that immediately returns the anchor's settlement instructions (destination Stellar account, memo, and fee breakdown).

In SEP-24, initiating a deposit or withdrawal does **not** open a ready-to-settle transaction:

1. **Interactive initiation (`POST /transactions/deposit/interactive` and `POST /transactions/withdraw/interactive`)** — Per SEP-24 [_Deposit_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#deposit) and [_Withdraw_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#withdraw), the anchor responds with `{ "type": "interactive_customer_info_needed", "url": "https://...", "id": "..." }`. No receiving Stellar account or memo is returned in this response.
2. **Hosted webview (`url`)** — Per SEP-24 [_Interactive Customer Information Needed_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#interactive-customer-information-needed-non-standard), the client application must open `url` in a browser or webview (or redirect the user) so a human can complete the anchor's forms (payout rail details, bank account or cash-pickup selection, fee confirmation, and interactive KYC).
3. **`incomplete` status until human completion** — While the user is inside (or has not yet opened) the webview, the transaction status in `GET /transaction` remains `incomplete` (see SEP-24 [_Transaction History — Single Historical Transaction_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#single-historical-transaction)). An unattended server process cannot advance a transaction past `incomplete` because there is no programmatic API to submit the webview form.

---

## 2. Funding account and memo are unknown until the webview completes

To execute the on-chain `settle` verb on Stellar, the engine requires three fields from the destination anchor:

- the destination Stellar address,
- the correlation memo, and
- the memo type (`text`, `id`, or `hash`).

In SEP-24 withdrawals, those fields (`withdraw_anchor_account`, `withdraw_memo`, and `withdraw_memo_type`) are **null or omitted** while the transaction is `incomplete`. Per SEP-24 [_Withdraw_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#withdraw) and [_Single Historical Transaction_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#single-historical-transaction):

- The anchor only populates `withdraw_anchor_account`, `withdraw_memo`, and `withdraw_memo_type` **after** the user finishes the interactive flow and the transaction transitions from `incomplete` to `pending_user_transfer_start`.
- Similarly, the final `amount_in`, `amount_out`, and `amount_fee` can be chosen or adjusted by the user inside the hosted webview rather than fixed at the initial `POST /transactions/withdraw/interactive` call (where `amount` is optional).

Consequently, the engine's `open` step (`AnchorAdapter.openTransaction`) cannot return a `SettlementRequest` (`to`, `memo`, `memoType`, `amount`) from the `POST /transactions/withdraw/interactive` response alone.

---

## 3. Customer identity and KYC belong to the end user, not the operator

SEP-31 and SEP-24 have different legal and protocol counterparties:

- **SEP-31 (`DIRECT_PAYMENT_SERVER`)** is an **anchor-to-anchor / PSP-to-anchor** protocol. The sending anchor or remittance operator authenticates with its own institutional SEP-10 keypair and registers sender/receiver KYC payloads programmatically via SEP-12 (`PUT /customer`).
- **SEP-24 (`TRANSFER_SERVER_SEP0024`)** is a **user-to-anchor** protocol. Per SEP-24 [_Authentication_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#authentication) and [_Interactive Customer Information Needed_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#interactive-customer-information-needed-non-standard), the SEP-10 JWT identifies the **individual user's Stellar account** (or muxed/sub-account), and the anchor collects KYC documents, liveness checks, and terms-of-service acceptance directly from that user inside the webview. Even when an anchor accepts SEP-9 fields as pre-fill hints on the initial `POST` or via SEP-12, SEP-24 explicitly reserves the right for the hosted UI to prompt the human for additional verification, OTPs, or physical cash-out confirmation before moving to `pending_user_transfer_start`.

An unattended corridor operator cannot impersonate end users in interactive KYC/liveness flows, nor can a shared treasury keypair act as hundreds of distinct retail SEP-24 customers without sub-account isolation and per-user browser sessions.

---

## 4. Implications for the engine state machine

The corridor state machine in [`packages/engine/src/state.ts`](../../packages/engine/src/state.ts) (`lines 6–21`) defines a strictly unattended progression:

```text
created → quoted → compliant → opened → verifying → settling → settled → reconciled → completed
```

Every state transition up to `settling` is synchronous to the engine's run loop:

1. `compliant → opened` assumes `openTransaction` returns complete deposit instructions (`to`, `memo`, `memoType`, `amount`).
2. `opened → verifying → settling` runs pre-settlement gates (including the firm-quote remaining TTL window check in `quote.window`) and immediately submits the Stellar payment.
3. There is **no state** before `opened` (or between `opened` and `verifying`) in which the engine can persist an `interactive_url`, yield control back to an external caller, wait minutes or hours for a human to complete a browser session, re-poll `GET /transaction` until `status === "pending_user_transfer_start"`, and re-validate or re-quote an expired SEP-38 quote before entering `verifying`.

Forcing SEP-24 into `openTransaction` by polling inside the adapter would either block the worker on a human who has no way to receive the `interactive_url`, or expire the firm quote (`min_quote_remaining_seconds`) while waiting on the browser session.

---

## 5. What is (and is not) automatable

| Lifecycle step                                   | SEP-24 endpoint / mechanism                                                                                | Automatable by engine?    | Why                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Capability discovery                             | `GET /info` ([_Info_](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#info)) | Yes                       | Machine-readable JSON listing supported assets, fees, and whether `withdraw-exchange` / quotes are enabled.   |
| Authentication                                   | SEP-10 challenge/response (`WEB_AUTH_ENDPOINT`)                                                            | Yes                       | Standard cryptographic signature exchange returning a Bearer JWT.                                             |
| Requesting the interactive session               | `POST /transactions/withdraw/interactive` or `/deposit/interactive`                                        | Yes                       | Returns `{ id, url, type: "interactive_customer_info_needed" }` via a standard multipart/JSON POST.           |
| Completing KYC, payout details, and confirmation | Hosted webview at `url` (`incomplete` status)                                                              | **No**                    | Requires a human in a browser to complete anchor-hosted UI steps; no programmatic submission endpoint exists. |
| Detecting readiness to settle                    | `GET /transaction?id=...` polling for `pending_user_transfer_start`                                        | Yes (once human finishes) | Returns `withdraw_anchor_account`, `withdraw_memo`, `withdraw_memo_type`, and final `amount_in`.              |
| Submitting on-chain settlement                   | Stellar payment to `withdraw_anchor_account` with `withdraw_memo`                                          | Yes                       | Identical on-chain payment primitive once the anchor populates the destination account and memo.              |
| Reconciling payout completion                    | `GET /transaction?id=...` polling for `completed` / `refunded` / `error`                                   | Yes                       | Statuses (`pending_external`, `completed`, `refunded`, `error`) map directly to the engine's reconcile loop.  |

---

## 6. Options considered and recommendation

### Option A: Poll inside a `Sep24Adapter.openTransaction()` call

- **How it would work:** `openTransaction` calls `POST /transactions/withdraw/interactive`, emits the `url` in a log or callback, and blocks polling `GET /transaction` until `pending_user_transfer_start`.
- **Why rejected:** Violates the unattended contract, ties up worker processes on human latency, causes SEP-38 firm quotes (`quote_ttl_seconds`) to expire while the user is in the webview, and provides no crash-safe persistence of the interactive URL or transaction ID before `opened` is written to the idempotency store.

### Option B: Add a `waiting_for_user` / `pending_user` state to `CorridorState`

- **How it would work:** Split `open` into `openInteractive` (`compliant → pending_user`, returning `{ transactionId, interactiveUrl }` to the caller) and `resumeAfterUser` (`pending_user → opened → verifying → settling` once a webhook or poller sees `pending_user_transfer_start`).
- **Why rejected for now:** Changes the core state machine (`packages/engine/src/state.ts`), requires two-phase quote management (since any quote acquired in `quoted` will expire while parked in `pending_user`), and turns an unattended B2B settlement engine into a retail session manager.

### Option C: Keep the core engine unattended (SEP-31 / SEP-6 / bespoke API) and treat SEP-24 as an edge flow (Recommended)

- **How it works:**
  1. **Destination side (`dest.protocol`):** Restrict unattended destination adapters to protocols with a deterministic, machine-to-machine `open` contract (`sep31`, `sep6`, and `custom:<id>`). Do not add `sep24` to `DestSchema` or unattended engine runs.
  2. **Source side (`source.protocol: "sep24"`):** Allow manifests to declare `source.protocol: "sep24"` (`packages/manifest/src/index.ts:127-134`) so a user-facing application can run the SEP-24 deposit webview at the edge _before_ handing the resulting on-chain bridge asset to `corridor-in-a-box` for unattended off-ramp settlement.
  3. **If a future product needs SEP-24 withdrawals:** Build a dedicated edge session service that drives steps 1–4 (`POST /transactions/withdraw/interactive` → user webview → poll until `pending_user_transfer_start`) and only invokes the settlement engine once `withdraw_anchor_account` and `withdraw_memo` are fixed.

### Recommendation

Adopt **Option C**, matching the decision in [RFC 0001](../rfcs/0001-protocol-agnostic-corridors.md): keep `corridor-in-a-box`'s state machine strictly unattended (`sep31`, `sep6`, `custom:<id>`), and keep interactive SEP-24 browser sessions at the application edge outside the core run loop.

The contract for that edge session — which state is (not) added to the engine, how the interactive URL is delivered, whose timeout budget a human wait consumes, and what must be true before anything is settled — is pinned in [RFC 0003](../rfcs/0003-sep24-interactive-handoff.md).
