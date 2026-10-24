# Threat Model

This document outlines the threat model for `corridor-in-a-box` across its core components: the orchestration engine (`@corridor/engine`), the HTTP API service (`@corridor/service`), the on-chain registry contracts (`contracts/registry`, `contracts/attester`), and the blockchain integration ports (`@corridor/stellar`).

It specifies what the system defends against, what guarantees it enforces, the mitigations implemented in code, and open architectural questions. Per [SECURITY.md](../SECURITY.md), actual vulnerabilities should be reported privately to the maintainers rather than discussed in public issue trackers.

---

## 1. Assets

The system protects four primary asset classes:

### 1.1 Signing Key

- **Description & Threat:** The cryptographic private key (ed25519 secret seed) for the distribution account and the SEP-10 challenge signer. If exposed or stolen, an adversary can directly sign transactions on the Stellar network, drain reserve pools, or forge authentication tokens across connected anchors.
- **Mitigations:**
  - **Port Isolation:** Cryptographic signing operations are quarantined behind the `ExternalSigner` interface ([`packages/stellar/src/index.ts:89`](../packages/stellar/src/index.ts#L89)), decoupling money movement and challenge authentication ([`packages/stellar/src/index.ts:131`](../packages/stellar/src/index.ts#L131)) from raw private keys.
  - **Remote KMS/Vault Transit:** Production deployments avoid in-memory seeds by delegating to HashiCorp Vault Transit ([`packages/stellar/src/signers/vault-transit.ts:36`](../packages/stellar/src/signers/vault-transit.ts#L36)). Only the 32-byte transaction hash leaves the application process over TLS ([`packages/stellar/src/signers/vault-transit.ts:111`](../packages/stellar/src/signers/vault-transit.ts#L111)), with key versions explicitly pinned to prevent silent rotation mismatch.
  - **Pre-flight Conformance:** Startup assertions execute signature verification probes before binding listeners or accepting incoming jobs ([`packages/stellar/src/signers/conformance.ts:6`](../packages/stellar/src/signers/conformance.ts#L6)).
- **Known Gaps (Open Questions):**
  - _How should zero-downtime key rotation be coordinated across in-flight settlements without rejecting valid pre-signed or re-submitted transactions?_
  - _What deterministic fallback or alerting policy should take over when an external KMS/Vault cluster becomes unreachable mid-settlement during recovery?_

### 1.2 Funds in Flight

- **Description & Threat:** Capital moving across corridor legs throughout the five lifecycle verbs (`quote`, `comply`, `reserve`, `settle`, `reconcile`). Threats include double-settlement, premature execution, asset confusion, stranded funds, and floating-point precision loss.
- **Mitigations:**
  - **Pre-Settle Gating:** Settlement cannot occur without passing the mandatory pre-settle gate ([`packages/engine/src/gate.ts:41`](../packages/engine/src/gate.ts#L41), [`packages/engine/src/gate.ts:55`](../packages/engine/src/gate.ts#L55)), which checks balances, compliance, and anchor readiness. Omitting this gate without explicit opt-out fails closed ([`packages/engine/src/run.ts:268`](../packages/engine/src/run.ts#L268)).
  - **Atomic Idempotency Claims:** Runs are inserted into persistent storage with `ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key` ([`packages/engine/src/idempotency-pg.ts:170`](../packages/engine/src/idempotency-pg.ts#L170)). Only the winning worker claims execution rights; concurrent duplicate attempts fail immediately ([`packages/engine/src/run.ts:419`](../packages/engine/src/run.ts#L419)).
  - **Optimistic Concurrency & Immutable Evidence:** State transitions advance strictly via monotonically increasing versions (`where corridor_runs.version < excluded.version`) ([`packages/engine/src/idempotency-pg.ts:297`](../packages/engine/src/idempotency-pg.ts#L297)). Stored `refund_id` and `settlement` receipts are preserved via `COALESCE`, preventing stale workers from double-advancing or erasing recovery records.
  - **On-Chain Fact Verification:** The engine re-queries the Stellar ledger directly and verifies payment facts (hash, status, destination, exact amount, asset code, issuer, memo) prior to marking runs completed ([`packages/stellar/src/index.ts:1166`](../packages/stellar/src/index.ts#L1166), [`packages/engine/src/run.ts:796`](../packages/engine/src/run.ts#L796)).
  - **Arbitrary-Precision BigInt Arithmetic:** Payout and bridge math operates on scaled BigInts rather than float64 ([`packages/types/src/money.ts:41`](../packages/types/src/money.ts#L41)). All payment boundaries enforce strictly positive amounts via `isSettleableAmount` ([`packages/types/src/money.ts:35`](../packages/types/src/money.ts#L35), [`packages/engine/src/run.ts:279`](../packages/engine/src/run.ts#L279)).
- **Known Gaps (Open Questions):**
  - _How should the system resolve extended off-chain stalls where an on-chain transaction succeeds but the anchor's internal banking/clearing rail halts indefinitely?_
  - _What automated dispute resolution or arbitration protocol should engage when an anchor claims non-receipt of verified on-chain funds?_

### 1.3 API Keys

- **Description & Threat:** Authentication tokens issued to tenants accessing the HTTP API (`POST /payments`, `GET /payments/:key`). Leaked or compromised tokens allow unauthorized payment requests or tenant data exfiltration.
- **Mitigations:**
  - **Rate Limiting Preceding Authentication:** To eliminate unmetered credential guessing at line rate, token bucket rate limits are enforced _before_ credential checks ([`packages/service/src/index.ts:173`](../packages/service/src/index.ts#L173), [`packages/service/src/index.ts:527`](../packages/service/src/index.ts#L527)). Unrecognized bearer tokens bucket to the client IP.
  - **Constant-Time Comparison:** Configured API keys are checked using constant-time string comparisons ([`packages/service/src/index.ts:786`](../packages/service/src/index.ts#L786)), mitigating timing side-channel attacks during token validation.
  - **Tenant Isolation & Ownership Pinning:** Ownership of payment runs is bound at creation to the authenticated bearer token ([`packages/service/src/index.ts:796`](../packages/service/src/index.ts#L796)). Payment lookups enforce strict tenant matching, preventing cross-tenant information disclosure.
  - **Error Sanitization:** Internal error messages carrying sensitive upstream anchor URLs, credentials, or internal paths are scrubbed down to coarse error codes before reaching clients ([`packages/service/src/index.ts:803`](../packages/service/src/index.ts#L803)).
- **Known Gaps (Open Questions):**
  - _How should granular, capability-based API keys (e.g., corridor-scoped, read-only vs execute) be structured as tenant scale increases?_
  - _What key-lifecycle interface should automate scheduled tenant key rotation without service interruptions?_

### 1.4 Registry Integrity

- **Description & Threat:** The on-chain Soroban registry records verified anchor capabilities, supported SEPs, and domain attestations. If corrupted, corrupted records could deceive the router into selecting compromised or non-conformant anchors.
- **Mitigations:**
  - **Soroban Address Authorization:** The registry contract enforces `writer.require_auth()` ([`contracts/registry/src/lib.rs:414`](../contracts/registry/src/lib.rs#L414)), restricting attestation entries exclusively to the configured attester contract address.
  - **Schema & Bitmask Validation:** Inbound attestation entries are strictly validated against known bitmasks (`SEP_MASK`, `PROBE_MASK`) and checked for internal consistency (`probes_passed <= probes_run`) ([`contracts/registry/src/lib.rs:418`](../contracts/registry/src/lib.rs#L418)).
  - **Attester Whitelisting & Interval Cooldowns:** The attester contract restricts submission rights to authorized addresses ([`contracts/attester/src/lib.rs:262`](../contracts/attester/src/lib.rs#L262), [`contracts/attester/src/lib.rs:440`](../contracts/attester/src/lib.rs#L440)) and enforces a minimum ledger interval cooldown ([`contracts/attester/src/lib.rs:271`](../contracts/attester/src/lib.rs#L271)) to resist update spam and rapid state overwrites.
- **Known Gaps (Open Questions):**
  - _How will multi-attester consensus / quorum weighting replace the current single-attester model as the ecosystem decentralizes?_
  - _What challenge or slashing mechanism should penalize an enrolled attester if it attests to false capabilities before administrative revocation?_

---

## 2. Actors

| Actor                            | Role / Privilege                                                                            | Potential Malicious Actions                                                                                                         | Code Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Known Gap (Open Question)                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**                     | Deploys nodes, manages environment variables, databases, and corridor YAML manifests.       | Deploying unvalidated manifests, pointing at malicious anchors, injecting invalid configurations.                                   | Zod schema validation parses all corridor definitions ([`packages/manifest/src/index.ts:318`](../packages/manifest/src/index.ts#L318), [`packages/manifest/src/index.ts:351`](../packages/manifest/src/index.ts#L351)); manifest hash pinning locks runs to an exact specification ([`packages/manifest/src/index.ts:439`](../packages/manifest/src/index.ts#L439), [`packages/engine/src/idempotency-pg.ts:306`](../packages/engine/src/idempotency-pg.ts#L306)); keys remain isolated in KMS/Vault ([`packages/stellar/src/signers/vault-transit.ts:36`](../packages/stellar/src/signers/vault-transit.ts#L36)). | _How should cryptographic multi-signature approvals be required for production manifest deployments and corridor configuration updates?_ |
| **Tenant**                       | Submits payments via the HTTP service using assigned API keys.                              | Submitting duplicate payments, parameter tampering, negative amounts, brute-forcing keys, inspecting other tenants' transactions.   | Pre-auth rate limiting ([`packages/service/src/index.ts:527`](../packages/service/src/index.ts#L527)); constant-time token comparison ([`packages/service/src/index.ts:786`](../packages/service/src/index.ts#L786)); strict body validation and settleable amount assertions ([`packages/service/src/index.ts:546`](../packages/service/src/index.ts#L546), [`packages/types/src/money.ts:35`](../packages/types/src/money.ts#L35)); tenant ownership validation ([`packages/service/src/index.ts:796`](../packages/service/src/index.ts#L796)).                                                                  | _How should distributed tenant volume quotas and credit balances be enforced across clustered service nodes?_                            |
| **Anchor (Sending / Receiving)** | External counterparty providing SEP-31/SEP-6 settlement and SEP-38 FX quotes.               | Providing fake/expired quotes, forged transaction IDs, misleading deposit instructions, stalling payouts, denying receipt of funds. | Pre-settle gate evaluates anchor readiness and quote freshness ([`packages/engine/src/gate.ts:41`](../packages/engine/src/gate.ts#L41), [`packages/engine/src/gate.ts:55`](../packages/engine/src/gate.ts#L55)); independent on-chain settlement verification ([`packages/stellar/src/index.ts:1166`](../packages/stellar/src/index.ts#L1166), [`packages/engine/src/run.ts:796`](../packages/engine/src/run.ts#L796)); circuit breaker halts lane on consecutive failures ([`packages/engine/src/breaker.ts:35`](../packages/engine/src/breaker.ts#L35)).                                                         | _What automated protocol should handle unilateral fee or quote term adjustments after quote reservation?_                                |
| **Attester**                     | Submits conformance probe results to on-chain contracts.                                    | Submitting falsified attestation records, spoofing anchor capabilities, manipulating domain names.                                  | Admin-controlled attester whitelisting ([`contracts/attester/src/lib.rs:262`](../contracts/attester/src/lib.rs#L262), [`contracts/attester/src/lib.rs:440`](../contracts/attester/src/lib.rs#L440)); domain canonicalization checks ([`contracts/attester/src/lib.rs:266`](../contracts/attester/src/lib.rs#L266)); rate-limiting via min ledger interval ([`contracts/attester/src/lib.rs:271`](../contracts/attester/src/lib.rs#L271)).                                                                                                                                                                          | _How should attestation disputes or false reporting be challenged and resolved on-chain?_                                                |
| **Network Attacker**             | Eavesdropper or MITM on networks connecting service, engine, anchors, and blockchain nodes. | Traffic interception, challenge replay, connection dropping, forging responses.                                                     | Transport Layer Security (TLS); SEP-10 challenge nonces with expiration and transaction signing ([`packages/stellar/src/index.ts:131`](../packages/stellar/src/index.ts#L131)); atomic database idempotency constraints resist replay ([`packages/engine/src/idempotency-pg.ts:170`](../packages/engine/src/idempotency-pg.ts#L170)).                                                                                                                                                                                                                                                                              | _How should automated certificate pinning or mTLS be structured across third-party anchor connections?_                                  |

---

## 3. Trust Boundaries

```
[ Tenant Client ]
       │
       ▼ (service ↔ client: Bearer auth, Rate limiting, Input sanitization)
[ @corridor/service ]
       │
       ▼ (Internal IPC / Process boundary)
[ @corridor/engine ]
       ├──▶ [ External Signer (Vault/KMS) ] (32-byte hash over TLS, pinned version)
       │
       ├──▶ (engine ↔ anchor HTTP: Zod validation, Pre-settle gate, Circuit breaker)
       │    [ Third-Party Anchors (SEP-10/12/38/31/6) ]
       │
       └──▶ (engine ↔ Horizon / RPC: Ledger fact checking, Non-retryable fails)
            [ Stellar Network / Horizon / Soroban RPC ]
                   ▲
                   │ (attester ↔ registry contract: require_auth, cooldown, bounds check)
            [ @corridor/attester ]
```

### 3.1 Engine ↔ Anchor HTTP

- **Boundary Description:** Communication across untrusted public networks between the orchestration engine and third-party anchor APIs (SEP-10 web auth, SEP-12 KYC, SEP-38 quotes, SEP-31/6 transfers).
- **Threats:** Anchor API downtime, spoofed responses, manipulated exchange rates, unverified deposit instructions, or silent payment withholding.
- **Existing Mitigations:**
  - Inbound responses are validated using Zod schemas ([`packages/manifest/src/index.ts:26`](../packages/manifest/src/index.ts#L26)).
  - Pre-settle gate runs checks with fail-closed timeout boundaries before dispatching transactions ([`packages/engine/src/gate.ts:45`](../packages/engine/src/gate.ts#L45), [`packages/engine/src/gate.ts:55`](../packages/engine/src/gate.ts#L55)).
  - Sticky circuit breaker trips to `open` upon consecutive lane failures, arresting traffic before further funds are committed ([`packages/engine/src/breaker.ts:35`](../packages/engine/src/breaker.ts#L35)).
  - Finality is anchored in on-chain ledger proof, not anchor HTTP claims ([`packages/engine/src/run.ts:796`](../packages/engine/src/run.ts#L796)).
- **Known Gaps (Open Questions):**
  - _How can the engine definitively distinguish between transient network drops and intentional anchor equivocation during the reconcile stage?_

### 3.2 Engine ↔ Horizon / Soroban RPC

- **Boundary Description:** The channel between `@corridor/stellar` and Stellar Horizon / Soroban RPC nodes.
- **Threats:** Malicious, partitioned, or out-of-sync RPC nodes returning stale ledger states, false transaction confirmations, or failing transaction broadcasts.
- **Existing Mitigations:**
  - On-chain fact verification (`verifySettlementFacts`) re-reads transactions and inspects operation type, success flag, recipient account, asset issuer, amount, and memo ([`packages/stellar/src/index.ts:1166`](../packages/stellar/src/index.ts#L1166)).
  - Ambiguous settlement verification errors fail non-retryable (`retryable: false`) ([`packages/engine/src/run.ts:804`](../packages/engine/src/run.ts#L804)), preventing duplicate submissions of already-mined payments.
- **Known Gaps (Open Questions):**
  - _What multi-node quorum verification strategy should corroborate ledger receipts when operating against untrusted public RPC endpoints?_

### 3.3 Service ↔ Client

- **Boundary Description:** Ingress interface receiving untrusted external requests over HTTP from tenants and callers.
- **Threats:** High-volume DoS, brute-force enumeration of API keys, malformed JSON injection, parameter manipulation, and cross-tenant data harvesting.
- **Existing Mitigations:**
  - TokenBucket rate limiting runs ahead of auth verification to defeat key-space brute forcing ([`packages/service/src/index.ts:527`](../packages/service/src/index.ts#L527)).
  - Constant-time comparison on credentials and payment ownership checks prevents timing probes ([`packages/service/src/index.ts:786`](../packages/service/src/index.ts#L786), [`packages/service/src/index.ts:796`](../packages/service/src/index.ts#L796)).
  - Strict payload validation rejects invalid amounts and fields ([`packages/service/src/index.ts:546`](../packages/service/src/index.ts#L546), [`packages/types/src/money.ts:35`](../packages/types/src/money.ts#L35)).
  - Error stripping removes internal diagnostic messages and anchor URLs from responses ([`packages/service/src/index.ts:803`](../packages/service/src/index.ts#L803)).
- **Known Gaps (Open Questions):**
  - _What cryptographic request-signing protocol (e.g. HTTP Message Signatures / RFC 9421) should be adopted for institutional tenant verification?_

### 3.4 Attester ↔ Registry Contract

- **Boundary Description:** Inter-contract and client-to-contract invocations between off-chain attesters and the Soroban registry contracts on the Stellar network.
- **Threats:** Unauthorized attestation injection, replay of obsolete probe results, attribute corruption, and attester identity spoofing.
- **Existing Mitigations:**
  - Mandatory Soroban authentication (`attester.require_auth()` in [`contracts/attester/src/lib.rs:262`](../contracts/attester/src/lib.rs#L262), `writer.require_auth()` in [`contracts/registry/src/lib.rs:414`](../contracts/registry/src/lib.rs#L414)).
  - Contract-level domain normalization and canonicalization checks ([`contracts/attester/src/lib.rs:266`](../contracts/attester/src/lib.rs#L266)).
  - Bitmask validation and probe pass-rate invariant checks ([`contracts/registry/src/lib.rs:418`](../contracts/registry/src/lib.rs#L418)).
  - Enforced minimum ledger interval cooldown between submissions for any domain ([`contracts/attester/src/lib.rs:271`](../contracts/attester/src/lib.rs#L271)).
- **Known Gaps (Open Questions):**
  - _How should contract upgrade authorities (`upgrade` in [`contracts/registry/src/lib.rs:666`](../contracts/registry/src/lib.rs#L666), [`contracts/attester/src/lib.rs:490`](../contracts/attester/src/lib.rs#L490)) be transitioned to decentralized DAO/multisig governance?_
