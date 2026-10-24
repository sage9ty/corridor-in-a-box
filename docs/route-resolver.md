# RouteResolver modules

`@corridor/router` draws the routing seam in code: an engine gets a
`RouteResolver`, and where the receiving anchor comes from is that resolver's
business. The repo ships two — `StaticRouteResolver` (trust the manifest) and
`RegistryRouteResolver` (require a fresh on-chain attestation) — and an
operator can point a deployment at a third, private one without forking
anything. This page documents that mechanism.

## The RouteResolver interface

Whether a resolver is built in or loaded through `loadResolver`, it must satisfy
this interface. The interface is effectively public API: a private resolver is
built against it without living in this repo, so what it promises is stated
here.

```ts
interface RouteResolver {
  resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision>;
}

interface RouteDecision {
  readonly receiving: AnchorAdapter;
  readonly split?: ReadonlyArray<{ adapter: AnchorAdapter; weight: number }>;
  readonly trust: "attested" | "manifest";
}
```

### Call sites and call count

The engine calls `resolve()` at two points, both in `packages/engine/src/run.ts`:

1. **First run** of `execute()`, once, after the idempotency key is claimed and
   before the quote.
2. **Resume** of a run in state `settled` that still needs reconciliation
   (`resumeRun`).

A single payment can therefore see `resolve()` more than once. An
implementation must not assume it is called once.

### Idempotency

For the same `intent` and `corridor`, `resolve()` should return the same
`receiving` anchor on every call, as far as its inputs allow. A resume
reconciles against whatever anchor the resolver returns at that moment. If a
resolver's choice drifts between the first run and the resume, reconciliation
can poll the wrong anchor. A resolver that depends on live data (health,
attestation, rate limits) should document that dependency. Any state it keeps
must tolerate a repeated call for the same payment.

### Error semantics

`resolve()` may throw, and it fails closed: it must never return a route it
cannot vouch for. `RegistryRouteResolver` throws `UnattestedAnchorError` when
an anchor is not attested, when its attestation is older than the staleness
bound, or when the registry cannot be reached. An unreachable registry is
"unknown", never "proceed".

**Known gap.** The first-run call to `resolve()` is not wrapped in a `try`.
The run has already been claimed in state `created` at that point, so an
exception from `resolve()` propagates out of `execute()` and the run stays
`created` instead of moving to `failed`. Callers must handle a rejected
promise and must not treat `created` as terminal. This is tracked by the issue
"execute() strands a run in `created` when RouteResolver.resolve() throws".
When the engine turns the throw into a failed outcome, this section will say
so.

### Trust

`trust` records how the route was reached. `"attested"` means the registry
holds on-chain evidence for the anchor. `"manifest"` means the anchor is taken
from the corridor manifest on trust. The engine refuses a `"manifest"` route on
the public network unless the operator explicitly opts in with
`trustManifestWithoutAttestation`, failing with `MANIFEST_INVALID`. A resolver
must report `trust` honestly. Reporting `"attested"` for an unverified route
defeats that check.

### `split`

`split` is reserved for multi-anchor routing. The engine reads only `receiving`
and ignores `split`, so setting it has no effect on where a payment goes. When
it is set, its weights should sum to 1, so the field keeps its meaning when the
engine starts to honour it. That support will come as its own change, with a
changelog entry.

### Versioning and stability

- The factory contract is versioned by `ROUTE_RESOLVER_API_VERSION` (currently
  `1`), exported from `@corridor/router`. `loadResolver` refuses a module that
  declares a different `apiVersion`.
- While the package is pre-1.0, a breaking change to `RouteResolver` or
  `RouteDecision` is a minor version bump, and `ROUTE_RESOLVER_API_VERSION` is
  incremented in the same change.
- After 1.0, a breaking change is a major bump.
- A deprecated member stays for at least one minor release and is marked in its
  TSDoc before removal.
- Adding an optional field is not breaking. Making a field required, or
  changing what an existing value means, is.

## The module contract

`loadResolver(spec, { adapterFor })` (exported from `@corridor/router`) turns a
named module into a `RouteResolver`. The module must satisfy two things:

```ts
export const apiVersion = ROUTE_RESOLVER_API_VERSION; // named export, exact match

export default function createResolver(ctx, options) {
  // (ctx, options) => RouteResolver — sync or async.
  // ctx = { adapterFor: (corridor) => AnchorAdapter }
  return {
    async resolve(intent, corridor) {
      return { receiving: ctx.adapterFor(corridor), trust: "manifest" };
    },
  };
}
```

Loading refuses, by name, every way the contract can be broken:

| Failure                               | Result                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| `module` is a URL (`http://...`)      | refused; only filesystem paths or installed packages load  |
| module does not exist / import throws | `ResolverLoadError: could not be loaded (...)`             |
| `apiVersion` missing or mismatched    | `ResolverLoadError: declares apiVersion ..., expected ...` |
| no default-exported factory           | `ResolverLoadError: must default-export a factory (...)`   |
| factory throws                        | `ResolverLoadError: factory threw (...)`                   |
| factory's return has no `resolve()`   | `ResolverLoadError: ... did not return a RouteResolver`    |

All of these stop the boot. A deploy that names a resolver which is missing or
incompatible must never fall back to a weaker one silently; falling back IS
the failure this seam exists to prevent.

## Environment

`examples/run-service.ts` (`pnpm serve`) reads two variables, both optional:

| Variable                    | Meaning                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CORRIDOR_RESOLVER_MODULE`  | Filesystem path (`./examples/resolvers/allowlist-resolver.ts`) or installed package name to load. Unset = built-in `StaticRouteResolver`. |
| `CORRIDOR_RESOLVER_OPTIONS` | Optional JSON object passed to the module's factory as `options`. Must be valid JSON when set.                                            |

Both are recorded in `.env.example`. The startup summary logs which resolver
the process is running with:

```text
• resolver: ./examples/resolvers/allowlist-resolver.ts (CORRIDOR_RESOLVER_MODULE)
...
✓ @corridor/service listening on :8080
  resolver:  ./examples/resolvers/allowlist-resolver.ts
```

## The example: allowlist-resolver

`examples/resolvers/allowlist-resolver.ts` is a complete, non-proprietary
resolver living outside `@corridor/router`. It wraps another resolver —
`RegistryRouteResolver` by default — and refuses any corridor whose
`dest.endpoints.home_domain` is not on an operator allowlist, so an allowlist
entry can never re-enable a lane that the attestation evidence then rejects,
and vice versa.

Run it:

```sh
CORRIDOR_RESOLVER_MODULE=./examples/resolvers/allowlist-resolver.ts \
CORRIDOR_RESOLVER_OPTIONS='{"domains":["localhost:8080"]}' \
pnpm serve
```

Its options (via `CORRIDOR_RESOLVER_OPTIONS`):

| Option                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domains` (required)     | Destination home domains payments may be routed to. Aliased `allowlist`. An empty list fails the boot — an allowlist that allows nothing by accident is a misconfiguration, not a policy.                                                                                                                                                                                                                                                                                                  |
| `wrap`                   | Wrap this resolver instead of the default `RegistryRouteResolver`. JSON cannot carry functions, so this is for programmatic callers and tests only.                                                                                                                                                                                                                                                                                                                                        |
| `registry`               | Inject an `AttestationSource` for the default registry resolver (programmatic/testing). The source answers `serves(domain, protocol)` for the protocol the corridor declares (`sep31`, `sep6`); a source that only implements the older `servesSep31(domain)` is accepted and adapted, and answers `false` for every other protocol. Deployment default: the on-chain registry when `REGISTRY_CONTRACT_ID` is set, otherwise a source that throws so `RegistryRouteResolver` fails closed. |
| `maxStalenessLedgers`    | Freshness bound passed through to the default registry resolver.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `allowUnattestedDomains` | Passed through to the default registry resolver. `localhost` variants and `REFERENCE_ANCHOR_URL` are included by default (same defaults as the CLI), because a self-hosted reference anchor can never be attested by a public attester.                                                                                                                                                                                                                                                    |

Refusals name the domain, e.g.
`refusing to route to example.com: not on the operator allowlist (1 domain allowed)`.

## Conformance: `describeResolverContract`

`@corridor/router/testing` exports the contract above as executable vitest
cases, so a resolver developed outside this repo can prove it honours it instead
of discovering the drift in production:

```ts
import { describeResolverContract } from "@corridor/router/testing";

describeResolverContract("MyResolver", (fixtures) => new MyResolver(fixtures.corridor));
```

Four cases:

| Case                                                  | Why it is on the list                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| a decision carries a receiving anchor                 | the engine pays into `decision.receiving`                                     |
| the same intent twice yields the same anchor domain   | a payment that resumes after a restart must settle both halves same place     |
| failure behaviour matches what the resolver documents | a silent fallback to a weaker source of truth is the failure this seam is for |
| `split`, if present, sums to 1                        | weights that do not add up route more value than the payment holds            |

The suite hands your factory the fixtures it will resolve
(`resolverContractFixtures()` for the defaults): `corridor` is the one you are
expected to route, `unresolvableCorridor` the one you are expected to refuse.
Declare the refusal behaviour your resolver documents with `unresolvable`:

```ts
describeResolverContract("RegistryRouteResolver", () => new RegistryRouteResolver(opts), {
  unresolvable: { outcome: "rejects", errorPattern: /not attested as serving SEP-31/ },
});

describeResolverContract("StaticRouteResolver", () => new StaticRouteResolver(for, opts), {
  // Not a gate: it documents that it trusts the manifest, and says so.
  unresolvable: { outcome: "resolves", trust: "manifest" },
});
```

`checkResolverContract(name, makeResolver)` returns the per-case report instead
of registering anything, and `expectResolverContract(report)` throws naming every
clause that failed — which is how `tests/router.test.ts` asserts, with `it.fails`,
that the suite really is capable of failing a broken resolver.

Both built-ins and `examples/resolvers/allowlist-resolver.ts` run the suite in
`tests/router.test.ts`, so the expectations cannot drift away from the resolvers
they describe. vitest is a peer dependency of the `./testing` subpath only;
importing `@corridor/router` alone does not pull it in.

## Writing your own

1. Create a file (any path or package you control).
2. Export `apiVersion` (import it from `@corridor/router` so a future contract
   bump stays honest) and a default factory `(ctx, options) => RouteResolver`.
3. Point `CORRIDOR_RESOLVER_MODULE` at it and restart `pnpm serve`.
4. Read `examples/resolvers/allowlist-resolver.ts` and
   `tests/router.test.ts` for the tested shape of both.
5. Run `describeResolverContract` over it in your own suite (see
   [Conformance](#conformance-describeresolvercontract)) before pointing real
   money at it.
