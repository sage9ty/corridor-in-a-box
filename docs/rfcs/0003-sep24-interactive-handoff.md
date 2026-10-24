# RFC 0003: SEP-24 interactive handoff — addendum to RFC 0001

- Status: proposed
- Issue: [#203](https://github.com/ezedike-evan/corridor-in-a-box/issues/203)
- Addendum to: [RFC 0001](0001-protocol-agnostic-corridors.md) (protocol-agnostic corridors), [RFC 0002](0002-source-side-funding.md) (source-side funding)
- Depends on: [#202](https://github.com/ezedike-evan/corridor-in-a-box/issues/202) (closed — SEP-24 exclusion), [#202 analysis](../protocols/sep24.md)
- Related: [#214](https://github.com/ezedike-evan/corridor-in-a-box/issues/214), [#216](https://github.com/ezedike-evan/corridor-in-a-box/issues/216)

## Summary

#203 asks a design question, not for an implementation: **should the engine
support an "interactive handoff" mode at all, and if so, what is the
contract?**

The short answer is already three decisions deep in this repo, and they agree:

- RFC 0001: _"Do not add SEP-24 to unattended engine runs."_
- [`docs/protocols/sep24.md`](../protocols/sep24.md): Option C — keep the
  engine unattended and treat SEP-24 as an edge flow.
- RFC 0002: the `sep24_handoff` source mode exists precisely so that _"the
  engine never drives the interactive session"_ — it records the caller's proof,
  it does not re-drive the webview.

So this addendum does not re-open the decision. It **pins the contract** so
that the next person who asks does not have to re-derive it, and it answers the
four questions the issue asks, one by one.

**Recommendation: defer.** The engine's state machine does not gain an
interactive state. If a product ever needs SEP-24, the interactive session is
driven by a separate edge session service that hands the engine a _finished_
deposit, exactly as RFC 0002's `sep24_handoff` mode already describes.

## The question, as asked

> - Is a new state (`awaiting_user`) between `compliant` and `opened`
>   acceptable, and how does resume work across process restarts?
> - How is the URL delivered to the operator (return value, service endpoint,
>   callback)?
> - How long may a run wait, and does that timeout count against
>   `recovery.timeout_seconds`?
> - Does settle happen only after the anchor reports
>   `pending_user_transfer_start` with account+memo?

## Decision

### 1. A new state between `compliant` and `opened`? No.

`packages/engine/src/state.ts` stays exactly as it is. No `pending_user`, no
`awaiting_user`.

The reason is not that the state would be hard to add — it is that the state
would be a lie. A run parked waiting for a human is not a run that is
"settling"; it is a run that has been handed to somebody else. Modelling that
as an engine state means the engine has to own three things it cannot own:

- **the quote budget.** A SEP-38 firm quote has a TTL in seconds. A human in a
  bank branch or a cash-out terminal takes minutes. The run would sit in
  `awaiting_user` until the quote expired, and the only correct outcomes are
  "re-quote" (which RFC 0002 forbids doing one leg at a time) or "fail".
- **the resume path.** `resumeRun` reconciles a run in `settled` against
  whatever the resolver returns. A run parked in `awaiting_user` is not in
  `settled`; it has no money to reconcile, and the engine's idempotency store
  would have to carry a live, mutable "waiting for a human" record that no
  process owns. A crashed edge session and a crashed engine would then need
  different recovery paths, for the same payment.
- **the PII boundary.** SEP-24's KYC happens inside the anchor's hosted webview
  and belongs to the end user, not the operator. `SECURITY.md` and RFC 0001
  keep customer PII out of the engine's run records, alerts and logs. An
  `awaiting_user` state invites exactly the wrong record: a URL with a
  session token in it, stored in a run row.

The transition table is also the thing that guarantees a settled payment is
never submitted twice. Adding a state that can wait for an unbounded time
widens the window in which a restart has to be reasoned about, for a case the
engine was never going to serve.

**Where the waiting state actually lives:** in the edge session service, which
has its own state machine, its own persistence, and its own TTL. It is a
different program with a different failure model, and pretending otherwise is
what made this look like an engine problem in the first place.

### 2. How is the URL delivered? To the edge service's caller — never to the engine.

Three shapes were considered:

| Shape                                    | Verdict    | Why                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return value from `open`                 | rejected   | `open` returns a `SettlementRequest` (`to`, `memo`, `memoType`, `amount`). An interactive URL is not a settlement instruction, and at `pending_user_transfer_start` time there is no `to` and no `memo` to return. Returning it would make the type a lie. |
| Engine callback / event                  | rejected   | It puts a browser-session URL into the engine's event stream and its audit log — the PII and secret-scanning problem above, with a webhook delivery problem on top.                                                                                        |
| Return value from a separate session API | **chosen** | The edge service returns `{ id, url }` to _its_ caller (the web app or the operator's integration), and later returns the _completed_ deposit. The engine only ever sees the completed side.                                                               |

The prototype shape the issue mentions — a `DepositInstructions` kind
`interactive` carrying the URL, with `SettlementStrategy` refusing to settle
until the instructions are resolved — is sound **as the edge service's own
type**, and it is the right shape for RFC 0001's port #2 (a discriminated
`DepositInstructions` union, [#183](https://github.com/ezedike-evan/corridor-in-a-box/issues/183)).
It is only wrong as an `AnchorAdapter` return value in the unattended engine,
because the unattended engine has no way to resolve it.

### 3. How long may a run wait? It does not wait, so `recovery.timeout_seconds` is untouched.

`recovery.timeout_seconds` is the engine's budget for _its own_ work: quote,
comply, open, verify, settle, reconcile. A human's time is not engine work, and
charging it to the engine's timeout would mean either an unusably long engine
timeout or a failure for a payment that was progressing perfectly well.

So:

- **The engine's `recovery.timeout_seconds` is unchanged** and is not consumed
  by any human wait. The engine never parks, so there is nothing to time out.
- **The edge session service owns the wait**, with its own session TTL and its
  own expiry policy. When the session expires, the deposit simply does not
  happen; the sender's funds never moved, so there is nothing to recover.
- **No firm quote is held open across a human wait.** The engine's quote
  budget (`fx.quote_ttl_seconds`, `min_quote_remaining_seconds`) applies to the
  engine's own unattended window. In RFC 0002's `sep24_handoff` mode the
  deposit completes _before_ the engine opens the destination leg, so the
  engine's quote is minted after the human is done, not before.

### 4. Does settlement wait for `pending_user_transfer_start`? Yes — and that rule already exists.

Per the SEP-24 specification, `withdraw_anchor_account`, `withdraw_memo` and
`withdraw_memo_type` are only populated once the transaction leaves
`incomplete`, and the final `amount_in`/`amount_out`/`amount_fee` can change
inside the webview.

The rule "no destination account and memo means no settlement" is not new to
this repo. It is the rule the SEP-31 path already obeys: `open` returns a
`SettlementRequest`, and the settlement step submits to that `to` with that
`memo`. A SEP-24 flow that produced an `interactive_url` instead of a
`SettlementRequest` would have nothing to submit to.

So the answer splits:

- **In the edge session service:** yes, settlement waits for
  `pending_user_transfer_start` (or the deposit equivalent), and the service
  reads the final account, memo and amount from the anchor's response. It
  refuses to hand anything to the engine until those fields are present and
  well-formed.
- **In the engine:** the engine settles only when it holds a
  `SettlementRequest`. A `DepositInstructions` of kind `interactive` that has
  not been resolved is a hard stop: the `SettlementStrategy` refuses to
  settle, and the run does not reach `verifying`.

## What is explicitly not changed

- `packages/engine/src/state.ts` — no new state, no new transition.
- `DestSchema` — `sep24` is not a destination protocol. An unattended engine
  has no business opening an interactive destination.
- `packages/engine/src/verbs.ts` — the five verbs are unchanged.
- `packages/adapter-kit` — `DepositInstructions` is unchanged. The
  `interactive` kind, if it is ever added, is added by the edge service's
  adapter, not by the generic one.
- No new environment variable, no new manifest field.

## The contract, if a product ever needs it

Requirements for a future edge session service (out of scope for this repo's
unattended engine):

1. It owns the SEP-24 interaction: `POST /transactions/deposit/interactive`
   (or `/withdraw/interactive`), the hosted webview, and the poll of
   `GET /transaction` until `pending_user_transfer_start`.
2. It never returns a URL to the engine. It returns either a completed
   deposit reference or nothing.
3. It does not hold a firm quote open. If the product needs a rate guarantee
   across a human wait, that is a product-level rate-lock, and it is outside
   the engine.
4. It stores no customer PII in engine-shaped records. The session's own
   storage is the product's, and it is not the engine's run store.
5. It hands the engine a completed deposit reference, which RFC 0002's
   `sep24_handoff` source mode already accepts as source-funding evidence.
6. It is idempotent on the anchor's transaction id: replaying a session
   returns the same result and never starts a second deposit.

## Follow-up implementation issues (only if this addendum is accepted)

- Edge session service: SEP-24 interactive session lifecycle, persisted
  session, and a completion callback that hands a deposit reference to the
  engine. Out of this repo.
- `DepositInstructions`: add the `interactive` kind to the union, with the
  `SettlementStrategy` refusing to settle until it is resolved (RFC 0001 port
  #2, [#183](https://github.com/ezedike-evan/corridor-in-a-box/issues/183)).
- `source.funding.mode: sep24_handoff`: the manifest field and the engine's
  acceptance of a caller-supplied deposit reference (RFC 0002,
  [#216](https://github.com/ezedike-evan/corridor-in-a-box/issues/216)).
- Runbook: what an operator does when a SEP-24 session expires — which is
  "nothing moved, nothing to refund".

## Maintainer sign-off

- RFC review: pending on the pull request that introduces this document.
- Once approved, record the maintainer, date, and any accepted deviations here
  before implementation issues are opened.

## Decision record

**Defer.** The engine stays unattended: no `pending_user` state, no `sep24`
destination protocol, no interactive URL in the engine's surface. The contract
is pinned as: a SEP-24 session, if a product ever needs one, is driven by an
edge session service that returns a _completed_ deposit to the engine through
RFC 0002's `sep24_handoff` source mode; the engine's timeout and quote budget
are untouched by human time; and settlement never happens without a resolved
`SettlementRequest` carrying the destination account and memo.
