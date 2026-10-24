# SEP coverage: why SEP-31, and where SEP-6/24 fit

`corridor-in-a-box` orchestrates **SEP-31** cross-border payments. That is a
deliberate scope choice, not an assumption that SEP-31 is the only flow that
matters. This note explains the choice and how the engine would extend to the
other transfer SEPs.

## The transfer SEPs, briefly

| SEP        | Shape                             | Who the "customer" is      | Human in the loop?          |
| ---------- | --------------------------------- | -------------------------- | --------------------------- |
| **SEP-6**  | Programmatic deposit/withdraw     | An end user of one anchor  | No (API-driven)             |
| **SEP-24** | Interactive deposit/withdraw      | An end user of one anchor  | Yes (anchor-hosted webview) |
| **SEP-31** | Cross-border **anchor-to-anchor** | A _sending business_ (PSP) | No — fully programmatic     |

SEP-6 and SEP-24 are **user ↔ anchor**: a person on- or off-ramps with a single
anchor. SEP-31 is **anchor ↔ anchor**: a sending business hands a payment (and the
customer's KYC, via SEP-12) to a receiving anchor that pays out the recipient.
SEP-38 (quotes) and SEP-10 (auth) are shared plumbing under all three.

## Why this engine targets SEP-31

The product is an **orchestrator a remittance operator / PSP runs to drive a
payment across two anchors** — exactly the SEP-31 topology:

- It is **server-to-server and non-interactive**: no anchor-hosted webview to
  babysit, which is what makes a corridor automatable as a state machine.
- The recipient is reached through the **receiving anchor's** payout rails, so the
  engine only owns the on-chain bridge leg plus quote/comply/reconcile/recover —
  the five verbs.
- KYC moves operator→anchor via **SEP-12**, so PII never flows through the engine
  (see [SECURITY.md](../SECURITY.md)).

SEP-6/24 solve a different problem (one user, one anchor) and carry interactive
state (SEP-24's webview) that doesn't belong in an unattended corridor runner.

## What SEP-31 does not cover: refund initiation

**Requesting a refund is out of scope for the generic adapter, because it is out
of scope for the protocol.** SEP-31's endpoints are `GET /info`,
`POST /transactions`, `GET /transactions/:id` and `PATCH /transactions/:id` —
there is no sender-initiated refund call. A refund is something the _receiving_
anchor decides to do on its own side, and it is only reported back to the sender
through the `refunds` object on the transaction record: there is no request,
only news.

`Sep31Adapter.requestRefund()` therefore fails closed with a non-retryable
`REFUND_UNSUPPORTED` and never touches the network. Since #72 the port has
`requestRefund`; the generic adapter refuses, the engine does not call it yet,
and the state machine defines `refund_pending` but no transition enters it. The
method occupies the name so bespoke adapters (OTC desks, proprietary anchors)
can implement anchor-driven refunds. The engine already parks any refused
refund in `held` for a human (asserted in a test), and the [operations
runbook](./operations.md) takes over (out-of-band resolution with the anchor). Observing that a refund _happened_ is
`getTransaction`'s job. An anchor that exposes a proprietary refund API is a
bespoke integration: it implements `AnchorAdapter` itself and lives outside
`packages/sep31`, keeping the generic adapter honest about what the standard
actually guarantees.

## How the architecture would extend

The boundary that makes this tractable is already in place: the engine knows only
the **`AnchorAdapter`** port (`packages/adapter-kit`), never a specific SEP. Adding
another transfer SEP is a new adapter, not an engine change:

- **SEP-6** maps cleanly onto the same five verbs — `openTransaction` becomes a
  SEP-6 `POST /transactions/withdraw` (or `/deposit`), `getTransaction` polls the
  SEP-6 status. `@corridor/sep6` now provides the adapter and its `GET /info`
  discovery; the transfer verbs land in their own issues.
- **SEP-24** is the awkward one: its interactive webview needs a human, so it
  fits a _user-facing_ product, not an unattended corridor. If it were ever
  needed, the `open` step would return an `interactive_url` the caller must drive,
  and the engine would park in a `pending_user` state — a genuine engine change,
  which is why it is out of scope today. See
  [docs/protocols/sep24.md](./protocols/sep24.md) for a full breakdown of the
  SEP-24 interactive lifecycle, state-machine implications, and options considered.
  Anchors that publish only SEP-6/SEP-24 (for example Anclap, pending the probe
  recorded in the issue) are blocked on the SEP-6 adapter and cannot yet be
  onboarded as SEP-31 corridors.

## External quotes (`fx.quote_source: external`)

Some anchors (Cowrie, for one) publish no SEP-38 server. For those corridors the
operator injects `EngineDeps.externalQuote`, a function
`(intent, corridor) => Promise<Outcome<{ price; destAmount?; expiresAt? }>>`.
The engine wraps it in `ExternalQuoteProvider` and never calls the adapter's
`requestQuote`, so no SEP-38 request is made. The resulting `Quote` is always
`firm: false`, so the firm-quote expiry checks do not apply to it.

A non-firm rate cannot bind the receiving anchor, so `external` combined with
`who_holds_risk: receiving_anchor` is refused before `open` (`MANIFEST_INVALID`)
unless the adapter's `capabilities().quotes` includes `"native"`. A corridor with
`quote_source: external` and no injected provider fails with `QUOTE_UNAVAILABLE`.

The manifest already abstracts the corridor; the adapter port already abstracts
the protocol. SEP-31 is the first and primary target because it is the flow whose
shape actually matches an automated cross-border orchestrator.

### Destination protocol schema and backward compatibility

A corridor manifest declares how the destination anchor is reached via `dest.protocol`:

- `protocol: "sep31"`: Standard SEP-31 anchor, exposing `transfer_server_sep31`.
- `protocol: "sep6"`: Programmatic deposit/withdraw anchor, requiring `transfer_server`.
- `protocol: "custom:<name>"`: Bespoke API integration, requiring `base_url`.

**Backward compatibility:** Existing manifests without a `protocol` field default to
`protocol: "sep31"` at parse time (provided their endpoints match the SEP-31 shape with
no `transfer_server` or `base_url` keys). When a legacy manifest without `protocol` is
parsed, `parseCorridor` and `loadCorridor` return a deprecation warning in `warnings: string[]`
recommending explicit declaration of `dest.protocol: sep31`. Manifests omitting `protocol`
while supplying `transfer_server` are rejected with an error instructing the author to set
`protocol: sep6`.

See also [why-not-anchor-platform.md](./why-not-anchor-platform.md) for how this
relates to the SDF Anchor Platform (the server side an anchor runs).

## SEP-24 interactive handoff

The question "should the engine ever support an interactive SEP-24 handoff?"
is answered in [RFC 0003](./rfcs/0003-sep24-interactive-handoff.md): no. The
engine stays unattended, and an interactive session — if a product ever needs
one — belongs to an edge session service that hands the engine a _finished_
deposit. [RFC 0003](./rfcs/0003-sep24-interactive-handoff.md) pins the contract:
which state is (not) added, how the URL is delivered, whose timeout budget a
human wait consumes, and what must be true before anything is settled.
