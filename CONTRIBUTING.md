# Contributing to corridor-in-a-box

Thanks for your interest. This is the open, runnable manifest-driven engine for
Stellar SEP-31 cross-border corridors, with a `RouteResolver` extension seam.
Contributions
that keep corridors as _configuration, not code_ are exactly what we want.

## Ground rules

- A new corridor is a new `*.corridor.yaml` file — **not** a fork of the engine.
  If you find yourself adding a string like `"NGN"` or a bank name to
  `packages/engine`, stop: that fact belongs in a manifest.
- `packages/router` is the public `RouteResolver` interface and default
  implementation. Any future proprietary route-intelligence logic or dataset
  should be implemented outside this repo; none is included today.
- Money is never a JavaScript `number`. Use the string-based `Money` type and the
  helpers in `@corridor/types`.
- Every fallible operation returns `Outcome<T>` — we do not throw across module
  boundaries.

## Development setup

```bash
corepack enable          # or: npm i -g pnpm@9
pnpm install
pnpm typecheck           # whole monorepo, one tsc pass
pnpm test                # vitest: engine, manifest, money, sep31, stellar, service, …
pnpm lint                # eslint + prettier --check
pnpm example             # run a payment end-to-end (mocked anchor + settle)
```

Node 22+ and pnpm 9+ are required (see `.nvmrc` and `packageManager` in
`package.json`).

## Before you open a PR

Run the full gate locally — CI runs the same three commands:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

- Keep PRs focused. One logical change per PR.
- Add or update tests for any behavior change. Engine logic must be exercised
  through the mock adapter / mock submitter (see `tests/engine.test.ts`).
- Update the README or relevant doc when you change a public interface.
- Do **not** commit secrets, signing keys, or `.env` files.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) prefixes
(`feat:`, `fix:`, `docs:`, `chore:`, `build:`, `test:`). Keep the subject line
under ~72 characters and explain the _why_ in the body.

## Good first issues

- Add `*.corridor.yaml` manifests for live SEP-24 / SEP-6 anchors and add corresponding `plan` verification tests.
- Extend the conformance suite in `packages/adapter-kit` with additional probes for anchor SEP conformance.
- Add and expand conformance and integration test coverage across corridor lifecycle states and error paths.
- Widen the SEP-31 status mapping in `packages/sep31` as you hit real anchors that report statuses we don't yet classify (see `mapSep31Status`).

## Keeping docs in sync

| If you change X          | Also update Y                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| New error code           | `packages/service/src/index.ts` STATUS_BY_CODE, `web/lib/docs.ts` HTTP API page, `docs/operations.md` |
| New package              | README tree and web Architecture page                                                                 |
| New env var              | `.env.example`                                                                                        |
| Corridor liveness change | README tables, ROADMAP, grant-proposal                                                                |
| Any merged PR            | CHANGELOG Unreleased                                                                                  |

Note that `web/lib/docs.ts` duplicates README content by hand.

## License

By contributing you agree that your contributions are licensed under the
[Apache-2.0 License](./LICENSE).
