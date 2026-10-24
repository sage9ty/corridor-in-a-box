# Design: Multiple Attesters and Quorum for Registry Records

- **Status**: Proposed
- **Author**: `chizzy0011`
- **Related Issue**: [#244](https://github.com/ezedike-evan/corridor-in-a-box/issues/244)
- **Target Contracts**: `contracts/registry`, `contracts/attester`
- **Target SDK**: `@corridor/registry`, `@corridor/router`

---

## 1. Context & Motivation

Today, the Corridor Conformance Registry uses a single trust root:

1. `contracts/attester/src/lib.rs` maintains an enrolled list of attester addresses (`DataKey::Attester(Address)`), but in practice, a single key (`ATTESTER_SECRET`) submits all sweeps from GitHub Actions.
2. `contracts/registry/src/lib.rs:192-201` stores a single flat record per domain (`DataKey::Anchor(domain)`).
3. Any authorized attester calling `put_anchor` unconditionally overwrites the existing domain record.
4. If multiple independent attesters (e.g., geographically distributed nodes or multi-party organizations) run sweeps, they race and overwrite each other's records on-chain.
5. If one attester encounters a transient regional failure (e.g., DNS partition, Cloudflare geo-block, local ISP routing issue) while another succeeds, the registry's state flips back and forth depending on who attested last.

This document specifies a multi-attester architecture with **K-of-N quorum consensus**, **divergence detection**, **per-attester cooldowns**, and **fail-closed consumer safety**.

---

## 2. Core Architecture Decisions

### 2.1 Question 1: Per-Attester Records vs. On-Chain Quorum Gate

#### Options Considered

- **Option A: Pure On-Chain Write Gate (Buffer & Flush)**
  Attestations are stored in a staging buffer. Only when $K$ matching attestations arrive does the contract commit the canonical record.
  - _Cons_: Expensive Soroban storage operations, complex garbage collection of stale unfulfilled votes, and high gas costs for the $K$-th attester who bears the burden of consensus evaluation. Disagreements remain buried in uncommitted staging state.

- **Option B: Independent Records Only (Client-Side Quorum)**
  The contract only stores `Anchor(domain, attester)`. Quorum calculation is offloaded entirely to consumers (SDK/CLI).
  - _Cons_: Pure client-side quorum means smart contracts on Soroban cannot consume registry state directly without re-implementing client logic on-chain.

- **Option C (Recommended): Per-Attester Storage + Materialized Consensus Record**
  1. The registry stores individual attester observations: `DataKey::Anchor(domain, attester) -> AnchorRecord`.
  2. The contract maintains a materialized consensus record: `DataKey::Consensus(domain) -> ConsensusRecord`.
  3. When an attester submits a report, the contract updates that attester's record and incrementally re-evaluates the active window ($W$ ledgers, default: 34,560 ledgers / ~48 hours).
  4. If at least $K$ active enrolled attesters agree on `(seps, toml_hash, probes_passed)`, the consensus record updates to `QuorumReached`.
  5. If attesters disagree, the consensus record updates to `Divergent`, capturing the disagreement explicitly.

#### Recommendation

**Option C**. Storing individual records preserves evidentiary integrity and regional auditability, while the materialized consensus record allows both on-chain contracts and off-chain clients to read definitive quorum state in a single $O(1)$ query.

---

### 2.2 Question 2: Surfacing Disagreement & Regional Flakes

Disagreement is **critical signal**, not noise. For cross-border payment corridors:

- An anchor reachable from Europe but blocked in North America indicates Cloudflare WAF misconfiguration or localized peering outages.
- An anchor returning differing SEP-31 endpoints across regions suggests unpropagated DNS or rolling deployment issues.

#### Divergence Model

A domain enters `ConsensusStatus::Divergent` when:

1. At least 2 active attesters have submitted records within the staleness window $W$.
2. The records disagree on `seps`, `toml_hash`, or critical probe outcomes (e.g., SEP-31 support).
3. No single opinion has achieved the required quorum threshold $K$.

#### On-Chain and Off-Chain Visibility

1. **On-Chain Event**:
   ```rust
   #[contractevent]
   pub struct DivergenceDetected {
       pub domain: String,
       pub active_attesters: u32,
       pub distinct_hashes: u32,
   }
   ```
2. **Registry State**:
   `ConsensusRecord.status` is explicitly set to `ConsensusStatus::Divergent`.
3. **Consumer View**:
   - `corridor plan` outputs: `⚠ DIVERGENT ATTESTATIONS: 2 attesters report conflicting endpoints/probes.`
   - `packages/registry` exposes `findDivergent(records)` alongside `findStale(records)`.
   - The anchor sweep report (`sweep/sweep.md`) includes an **Attester Consistency Matrix** detailing per-region probe results.

---

### 2.3 Question 3: Rate Limiting and Cooldown Mechanics

#### Current State

`contracts/attester/src/lib.rs:141-146` enforces:

```rust
let last_key = DataKey::LastAttest(domain.clone());
if let Some(last) = env.storage().persistent().get::<_, u32>(&last_key) {
    if now.saturating_sub(last) < min_interval {
        return Err(Error::TooSoon);
    }
}
```

A single global cooldown per domain means the first attester to run locks out all other attesters for `min_interval` ledgers.

#### Proposed Change

Cooldown **MUST** become per `(domain, attester)`:

```rust
DataKey::LastAttest(String /* domain */, Address /* attester */)
```

- Each enrolled attester can attest any given domain once per `min_interval` ledgers.
- Scheduled sweeps from distributed runners (e.g. US, EU, APAC runners) can run on independent cron cadences without blocking each other.
- An attester cannot spam updates to skew consensus weight.

---

### 2.4 Question 4: Consumer Impact & Routing Safety

#### Fail-Closed Policy on Disagreement

When routing live customer payments, safety is paramount:

- **`serves_sep31(domain)`**:
  - **Returns `true` ONLY IF**: `ConsensusRecord.status == QuorumReached` AND `ConsensusRecord.seps` contains SEP-31.
  - **Returns `false` IF**: Status is `Divergent`, `Stale`, or `InsufficientVotes`.
- **`RegistryRouteResolver` (`packages/router/src/registry-resolver.ts`)**:
  - Treats `Divergent` records as non-routable (`RESOLVER_DIVERGENT` / `CORRIDOR_DEGRADED`).
  - Does NOT initiate payment legs on corridors with contested liveness.
- **`liveSep31Anchors` (`packages/registry`)**:
  - Exposes an extended filter:
    ```typescript
    interface AnchorFilterOptions {
      requireQuorum?: boolean; // default true
      allowDivergent?: boolean; // default false
    }
    ```
- **Diagnostic / Operator Overrides**:
  - CLI `corridor plan --allow-divergent` allows operators to inspect and debug paths even during contested quorum states.

---

### 2.5 Question 5: Enrollment Governance & Administration

#### Mainnet Admin Custody

As established in `docs/mainnet-registry.md`, the registry and attester admin on Mainnet is **not** a single developer key. It is a **Stellar Multisig Account** (e.g., 3-of-5 threshold across independent ecosystem stakeholders).

#### Administrative Responsibilities

1. **`add_attester(attester: Address)`**: Requires multisig admin signature. Adds an attester to the active enrollment set and increments $N$.
2. **`remove_attester(attester: Address)`**: Removes a misbehaving or decommissioned runner. Decrements $N$ and triggers immediate consensus re-evaluation on all active domains.
3. **`set_quorum_threshold(k: u32)`**: Requires $1 \le K \le N$. Typically set to $\lceil (N + 1) / 2 \rceil$ (simple majority) or $2/3$ supermajority.
4. **`set_staleness_window(ledgers: u32)`**: Configures how long an attestation remains valid for quorum calculations (default: 34,560 ledgers / ~48 hours).

---

## 3. Contract Specifications & API Changes

### 3.1 `contracts/registry/src/lib.rs`

#### Data Keys

```rust
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    AttesterContract,
    Domains,
    // Per-attester anchor record
    Anchor(String, Address), // (domain, attester)
    // Materialized consensus record
    Consensus(String),        // (domain)
    // List of active attester addresses that have attested this domain
    DomainAttesters(String),  // (domain) -> Vec<Address>
}
```

#### Types

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum ConsensusStatus {
    QuorumReached = 1,
    Divergent = 2,
    InsufficientAttestations = 3,
    Stale = 4,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct ConsensusRecord {
    pub domain: String,
    pub status: ConsensusStatus,
    pub agreeing_attesters: u32,
    pub total_active_attesters: u32,
    pub seps: Vec<u32>,
    pub toml_hash: BytesN<32>,
    pub probes_passed: u32,
    pub last_updated_ledger: u32,
}
```

#### Contract Interface

```rust
pub trait AnchorRegistryTrait {
    /// Invocable only by the authorized attester contract.
    fn record_attestation(
        env: Env,
        attester: Address,
        domain: String,
        seps: Vec<u32>,
        toml_hash: BytesN<32>,
        probes_run: u32,
        probes_passed: u32,
    ) -> Result<(), Error>;

    /// Fetch canonical consensus record for a domain.
    fn get_consensus(env: Env, domain: String) -> Option<ConsensusRecord>;

    /// Fetch specific attester's record for a domain.
    fn get_attestation(env: Env, domain: String, attester: Address) -> Option<AnchorRecord>;

    /// List all individual attestation records for a domain.
    fn list_attestations(env: Env, domain: String) -> Vec<AnchorRecord>;

    /// Checks if a domain reliably serves SEP-31 under quorum.
    fn serves_sep31(env: Env, domain: String) -> bool;
}
```

---

### 3.2 `contracts/attester/src/lib.rs`

#### Data Keys

```rust
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Registry,
    Attesters,                     // Vec<Address>
    QuorumThreshold,               // u32 (K)
    StalenessWindow,               // u32 (ledgers)
    MinInterval,                   // u32 (ledgers)
    LastAttest(String, Address),   // (domain, attester) -> u32
}
```

#### Contract Interface

```rust
pub trait AttesterTrait {
    /// Submit attestation for a domain. Caller must be an enrolled attester.
    fn attest(
        env: Env,
        attester: Address,
        domain: String,
        seps: Vec<u32>,
        toml_hash: BytesN<32>,
        probes_run: u32,
        probes_passed: u32,
    ) -> Result<(), Error>;

    /// Governance: update quorum threshold K.
    fn set_quorum(env: Env, threshold: u32) -> Result<(), Error>;

    /// Governance: add an attester runner.
    fn add_attester(env: Env, attester: Address) -> Result<(), Error>;

    /// Governance: remove an attester runner.
    fn remove_attester(env: Env, attester: Address) -> Result<(), Error>;
}
```

---

## 4. Implementation Breakdown (Follow-up Issues)

To deliver this design safely and iteratively, the work is divided into 5 focused issues:

### Issue 1: Per-Attester Cooldown & Storage Keys

- **Scope**: Update `contracts/attester` to key cooldowns on `DataKey::LastAttest(domain, attester)`. Update `contracts/registry` to key anchor storage on `DataKey::Anchor(domain, attester)` and maintain `DomainAttesters(domain)`.
- **Size**: M
- **Verification**: Unit tests with 2 attesters submitting without lockouts.

### Issue 2: Quorum Evaluation & Materialized Consensus Record

- **Scope**: Implement consensus calculation in `contracts/registry`: compare `(seps, toml_hash)` across active non-stale attestation records against threshold $K$. Write `DataKey::Consensus(domain)`.
- **Size**: L
- **Verification**: Tests for quorum reached (3-of-3, 2-of-3) and threshold updates.

### Issue 3: Divergence Detection & Event Notification

- **Scope**: Detect conflicting observations within window $W$. Emit `DivergenceDetected`. Set `ConsensusStatus::Divergent`. Update `serves_sep31` to fail closed on divergence.
- **Size**: M
- **Verification**: Tests asserting `serves_sep31 == false` when attesters disagree.

### Issue 4: Client SDK (`@corridor/registry`) Updates

- **Scope**: Add `getConsensus(domain)`, `getAttestations(domain)`, and `findDivergent(records)` to TypeScript client. Update RPC query bindings.
- **Size**: M
- **Verification**: Integration tests with mock RPC responses simulating consensus and divergence.

### Issue 5: Route Resolver & CLI Integration

- **Scope**: Update `RegistryRouteResolver` to require `QuorumReached`. Add divergence warnings to `corridor plan` and display attester agreement matrices in `corridor sweep`.
- **Size**: M
- **Verification**: End-to-end corridor routing tests rejecting divergent domains.
