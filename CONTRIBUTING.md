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
`package.json`), and the contracts need a Rust toolchain with the
`wasm32v1-none` target. The dev container below sets all of it up for you.

The commands CI runs are also collected in the [`justfile`](./justfile), so you
do not have to read `.github/workflows/ci.yml` to find them. `just --list` shows
every recipe; `just ci` runs the whole gate.

```bash
cargo install just       # or brew install just, or https://github.com/casey/just#installation
just install             # both pnpm roots: the monorepo and web/
just check               # lint, typecheck, test
just contracts           # cargo fmt --check, clippy -D warnings, test, wasm build
just ci                  # all of the above, plus web and the Postgres test
```

### Dev container

`.devcontainer/` captures that toolchain as code, for a fresh machine or a
GitHub Codespace:

- Node 22 (the `engines` floor) from the TypeScript devcontainer image, with
  pnpm resolved through corepack from `packageManager` (`pnpm@9.12.0`)
- Rust stable with `rustfmt`, `clippy` and the `wasm32v1-none` target — the same
  toolchain CI's `contracts` job installs
- a `postgres:16` service with `CORRIDOR_TEST_DATABASE_URL` already pointing at
  it, so the Postgres-backed tests need no database setup of their own (the
  crash-resume Postgres cases still need the live-anchor variables, as on a bare
  machine)
- `git`, so the `prepare` script can install lefthook's hooks

Open it with **Reopen in Container** in VS Code (Dev Containers extension) or
**Code → Codespaces → Create codespace** on GitHub. It installs both pnpm roots
on create, after which these run as-is:

```bash
pnpm typecheck
pnpm test            # also runs the Postgres suite, since the DB is configured
pnpm exec vitest run tests/integration/idempotency-pg.test.ts
cd contracts && cargo test
```

The reference-anchor stack is the one thing that does not work here:
`scripts/reference-anchor.sh` drives rootless **podman** on the host, and a dev
container has no nested container runtime. Docker-in-Docker would not help — it
provides docker, while the script and `just anchor-up` call podman. `just` and
`gitleaks` are not installed either, so the `justfile` stays the host workflow;
`just pg-test` is redundant in here in any case, since it starts its own
Postgres on 5432 while `CORRIDOR_TEST_DATABASE_URL` already points at the `db`
service. Run `pnpm` and `cargo` directly in the container, and `just ci` /
`just anchor-up` on the host.

## Git hooks

`pnpm install` runs a `prepare` script that installs [lefthook](https://github.com/evilmartians/lefthook)
git hooks. On commit, staged files are checked quickly (< 5 s typical):

- `prettier --write` on staged files
- `eslint` on staged `.ts` files
- `gitleaks git --staged` (with `.gitleaks.toml`) if `gitleaks` is installed
  (skipped with a warning otherwise)
- `rustfmt` on staged `contracts/**/*.rs` files

To opt out for a single command, prefix it with `LEFTHOOK=0`, e.g.
`LEFTHOOK=0 git commit -m "wip"`. Hooks are a convenience; CI still runs the
full gate.

## Before you open a PR

Run the full gate locally. `just ci` runs the same steps as CI's build,
contracts, web and integration-postgres jobs; CI also has a gitleaks job, whose
local equivalent is `just secret-scan`. `just ci` needs a container runtime for
the Postgres job — without one, run `just check && just contracts && just web`.

```bash
just ci
```

Or, without `just`, the three commands the monorepo gate is made of:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

- Keep PRs focused. One logical change per PR.
- Add or update tests for any behavior change. Engine logic must be exercised
  through the mock adapter / mock submitter (see `tests/engine.test.ts`).
- Update the README or relevant doc when you change a public interface.
- Do **not** commit secrets, signing keys, or `.env` files.

### Quarantining a flaky test

Don't delete or `.skip` a test that flakes. Open an issue for it, then wrap it in
`quarantine()` from `tests/helpers/quarantine.ts`, giving the issue URL first:

```ts
quarantine(
  "https://github.com/ezedike-evan/corridor-in-a-box/issues/123",
  "socket 413",
  () => {
    it("rejects a body over the cap", async () => {
      /* … */
    });
  },
);
```

`pnpm test` skips quarantined blocks. `pnpm test:quarantine` runs only those
blocks, retrying each test up to 3 times. The non-blocking `quarantine` CI job
lists every quarantined test, its issue, and how it did in the job summary.
`tests/quarantine.test.ts` fails if a `quarantine()` call has no issue URL.
Once the issue is fixed, remove the wrapper.

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
