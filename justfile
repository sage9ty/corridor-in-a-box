# corridor-in-a-box — the commands CI runs, in one place.
#
# Every recipe shells out to the same script or CLI invocation
# .github/workflows/ci.yml uses, so a local run and the CI jobs cannot drift
# apart semantically. Where CI supplies something a plain shell does not — the
# Postgres service container, the working directory a job runs from — the recipe
# reproduces it rather than assuming it.
#
# Requires bash (Git Bash on Windows), Node 22+, pnpm 9+, a Rust toolchain with
# the wasm32v1-none target for `contracts`, and podman or docker for `pg-test`
# and `anchor-up`. Install `just` itself with `cargo install just`.
#
#   just                list the recipes
#   just ci             everything CI runs except the secret scan
#   just --dry-run ci   show the commands without running them
#
# The comment block above each recipe is for whoever reads the file; the line
# directly above it is what `just --list` prints.

set shell := ["bash", "-cu"]

# Container CLI used by `pg-test`; podman because scripts/reference-anchor.sh
# already assumes rootless podman. Override with CONTAINER_CLI=docker just ….
CONTAINER_CLI := env_var_or_default("CONTAINER_CLI", "podman")

# The same image and credentials as the `postgres:` service in ci.yml.
PG_IMAGE := "docker.io/library/postgres:16"
PG_URL := env_var_or_default("CORRIDOR_TEST_DATABASE_URL", "postgres://postgres:pg@localhost:5432/corridor_test")

# List the recipes.
default:
    @just --list

# web/ is its own workspace root on purpose, so pnpm must not resolve the
# repository root's workspace for it (see web/README.md).

# Install both pnpm roots: the monorepo, and web/ outside it.
install:
    pnpm install --frozen-lockfile
    pnpm --dir web install --frozen-lockfile --ignore-workspace

# Lint, typecheck and test the monorepo, as CI's build job does.
check:
    pnpm lint
    pnpm typecheck
    pnpm test

# The wasm build is not decoration: a contract that compiles natively can still
# fail to link for wasm32 (two contracts exporting __constructor, for one), and
# only the release build against wasm32v1-none catches it.

# Check, test and build the Soroban contracts, as CI's contracts job does.
contracts:
    #!/usr/bin/env bash
    set -euo pipefail
    # A shebang recipe, because CI runs this job with `working-directory:
    # contracts` and just otherwise runs each line in its own shell — a bare
    # `cd` on its own line would not carry to the cargo commands.
    cd contracts
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo test
    cargo build --release --target wasm32v1-none

# The showcase app is a standalone Next.js project with its own lockfile,
# installed outside the workspace by `just install`.

# Typecheck and build the web showcase app, as CI's web job does.
web:
    # `--dir` is CI's `working-directory: web`, stated per command because just
    # runs each line in its own shell.
    pnpm --dir web typecheck
    pnpm --dir web build

# The atomic claim and the version-guarded upsert are only exercised against a
# real Postgres. CI gets one from a service container and a shell does not, so
# this starts one and removes it again on the way out. The URL is CI's own; the
# test is env-gated, which is why the default `pnpm test` skips it.
#
# Set CONTAINER_CLI=docker if this machine has docker rather than podman.

# Run the Postgres integration test against a real server.
pg-test:
    #!/usr/bin/env bash
    set -euo pipefail
    name=corridor-pg-test
    {{CONTAINER_CLI}} rm -f "$name" >/dev/null 2>&1 || true
    {{CONTAINER_CLI}} run -d --name "$name" -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=corridor_test -p 5432:5432 {{PG_IMAGE}} >/dev/null
    trap '{{CONTAINER_CLI}} rm -f "$name" >/dev/null 2>&1 || true' EXIT
    until {{CONTAINER_CLI}} exec "$name" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
    CORRIDOR_TEST_DATABASE_URL={{PG_URL}} pnpm exec vitest run tests/integration/idempotency-pg.test.ts

# `up` waits until SEP-1 actually serves, and reseeds the Stellar observer's
# paging token on every start — the row a stale cursor hides in, explained in
# the header of the script it calls. Testnet only; needs podman.

# Start the SDF Anchor Platform SEP-31 reference server locally.
anchor-up:
    ./scripts/reference-anchor.sh up

# Stop and remove the reference anchor stack.
anchor-down:
    ./scripts/reference-anchor.sh down

# Containers, SEP-1, the SEP-31 receive list, and how far the observer's cursor
# has drifted behind Horizon. The last of those is what makes a run end in
# RECONCILE_STALLED, and it is better measured before the run than after.

# Report whether the reference stack is fit to run a corridor.
anchor-doctor:
    ./scripts/reference-anchor.sh doctor

# CI's gitleaks job uses an action with a token, so the secret scan is not part
# of this: `just secret-scan` is the local equivalent, left separate rather than
# made to fail on a machine without the binary.

# Run every gate CI runs except the secret scan.
ci: install check contracts web pg-test

# Scans the whole history, matching CI's `fetch-depth: 0` checkout.

# Scan the repository history for secrets.
secret-scan:
    gitleaks detect --source . --config .gitleaks.toml --redact
