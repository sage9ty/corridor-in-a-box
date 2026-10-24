# Security Policy

`corridor-in-a-box` orchestrates the movement of money across Stellar SEP-31
corridors. We take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the **Security** tab), or email the maintainers
listed in `package.json`.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a failing test or a minimal manifest is ideal).
- Any suggested remediation.

We aim to acknowledge reports within **72 hours** and to provide a remediation
timeline within **7 days**.

## Scope

For a comprehensive breakdown of defended assets, actors, trust boundaries,
and code-level mitigations, see the [Threat Model](docs/threat-model.md).

Of particular interest:

- **Double-settlement / idempotency bypass** — any path where the same
  `idempotencyKey` can produce two on-chain payments.
- **State-machine violations** — transitions that skip `comply` or `reconcile`.
- **Money handling** — precision loss, rounding, or asset-confusion bugs in the
  `Money` type or FX path.
- **Settlement key exposure** — anything that could leak the signing keypair used
  by a `SettlementSubmitter`.
- **Manifest injection** — untrusted `*.corridor.yaml` input that escapes Zod
  validation.

## Out of scope

- Vulnerabilities in third-party anchors or in `@stellar/stellar-sdk` itself
  (report those upstream).
- A proprietary `RouteResolver` implementation is not included in this repo; the
  open interface can support one if developed separately in the future.

## Supported versions

This project is pre-1.0. Only the latest `main` is supported; fixes are not
backported.
