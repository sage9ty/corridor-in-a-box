# Mainnet Deployment Plan: Registry & Attester Contracts

This document specifies the readiness criteria, operational procedures, security custody, and rollback strategy for deploying the on-chain anchor conformance registry (`corridor-registry`) and attester contract (`corridor-attester`) to the Stellar mainnet (`public`).

---

## 1. Entry Criteria

Before initiating mainnet deployment, the following milestones must be fully met and verified:

1. **Storage TTL Fix Merged (#245)**:
   - Ensure the persistent storage TTL extension logic is implemented and tested so that active registry entries and instance storage never silently expire into archival state.
2. **End-to-End Upgrade Rehearsal on Testnet**:
   - Rehearse `upgrade(new_wasm_hash)` on the testnet deployment (`contracts/deployments.json:testnet`).
   - Verify that an upgraded WASM retains existing `Anchor(domain)` state, domain list indices, and attester permissions without state migration failures.
3. **4 Weeks of Unbroken Testnet Attestations**:
   - Maintain a minimum of 4 consecutive weeks of green, scheduled daily attestations via `.github/workflows/attest-anchors.yml` against live anchors.
   - Confirm that flappings or network blips are accurately reported without contract reverts or unhandled exceptions.

---

## 2. Admin Key Custody & Governance

The `admin` address for both contracts holds critical privileges: rotating the attester contract, enrolling or removing attester keys, adjusting rate limits (`min_interval`), and replacing WASM bytecode via `upgrade()`.

### Custody Model

- **Never a Single EOA**: The admin MUST NOT be a single private key stored on a laptop, in a `.env` file, or inside a CI secret.
- **Multisig Recommendation**: Admin authority must belong to a 2-of-3 or 3-of-5 Stellar multisig account comprised of core maintainers and trusted foundation signers.
- **Hardware / Cold Storage**: All multisig signers must custody their signing keys on hardware devices (Ledger) or institutional KMS vaults adhering to [`docs/key-management.md`](key-management.md).

### Contract Administration Boundaries

- Both contracts (`Registry` and `Attester`) can share the same multisig admin address to minimize governance overhead while keeping their contract boundaries distinct.

---

## 3. Constructor Parameters & Initialization

### Deployment Order & Circular Reference Resolution

The `Registry` requires `attester: Address` in its constructor, while the `Attester` requires `registry: Address`. To resolve this on Soroban:

1. Deploy `Registry` with `admin = <MultisigAddress>` and a temporary placeholder or predicted attester address.
2. Deploy `Attester` with `admin = <MultisigAddress>`, `registry = <RegistryAddress>`, and `min_interval = 720`.
3. Admin invokes `Registry.set_attester(<AttesterAddress>)` to link the contracts authorization chain.

### Parameter Specifications

| Contract     | Parameter      | Value                   | Rationale                                                                 |
| ------------ | -------------- | ----------------------- | ------------------------------------------------------------------------- |
| **Registry** | `admin`        | `<MultisigAddress>`     | 2-of-3 multisig core governance.                                          |
| **Registry** | `attester`     | `<AttesterAddress>`     | Restricts `put_anchor` exclusively to the attester contract.              |
| **Attester** | `admin`        | `<MultisigAddress>`     | Shared core governance.                                                   |
| **Attester** | `registry`     | `<RegistryAddress>`     | Target registry for relaying attestations.                                |
| **Attester** | `min_interval` | `720` ledgers (~1 hour) | Prevents runaway attestation loops while permitting retries within hours. |

### Day-One Attester Keys

- Deployer calls `Attester.add_attester(<AttesterPublicKey>)` for each approved attestation node.
- On day one, exactly one production attester key (`G...`) is enrolled, custodied in a cloud KMS/HSM service and used by the dedicated attestation runner.

---

## 4. Fee Budget & Funding

### Cost Model (Mainnet)

- **Fleet Size**: ~10 anchors in `contracts/anchors.json`.
- **Frequency**: 1 attestation per anchor per day.
- **Per-Transaction Cost**: ~0.05 to 0.10 XLM (covering base fee, CPU/memory instructions, and persistent entry write footprint).
- **Daily Spend**: ~0.50 to 1.00 XLM.
- **Monthly Run Rate**: ~15 to 30 XLM per month (plus periodic storage rent extensions).

### Treasury & Operational Account

- A dedicated attestation distribution account (`G...`) will be funded with **250 XLM** (sufficient for >8 months of operations).
- Automated alerting triggers when balance falls below **50 XLM**.
- Funded and sponsored by the ecosystem operations grant.

---

## 5. Rollout Plan

### 1. Build and Verify Bytecode

```bash
stellar contract build
stellar contract optimize --wasm target/wasm32v1-none/release/corridor_registry.wasm
stellar contract optimize --wasm target/wasm32v1-none/release/corridor_attester.wasm
```

### 2. Deploy to Public Network

```bash
# 1. Install WASMs
REGISTRY_HASH=$(stellar contract install --wasm target/wasm32v1-none/release/corridor_registry.optimized.wasm --network public --source-account <ADMIN_SOURCE>)
ATTESTER_HASH=$(stellar contract install --wasm target/wasm32v1-none/release/corridor_attester.optimized.wasm --network public --source-account <ADMIN_SOURCE>)

# 2. Deploy Registry
REGISTRY_ID=$(stellar contract deploy --wasm-hash $REGISTRY_HASH --network public --source-account <ADMIN_SOURCE> -- --admin <MULTISIG_ADMIN> --attester <MULTISIG_ADMIN>)

# 3. Deploy Attester
ATTESTER_ID=$(stellar contract deploy --wasm-hash $ATTESTER_HASH --network public --source-account <ADMIN_SOURCE> -- --admin <MULTISIG_ADMIN> --registry $REGISTRY_ID --min_interval 720)

# 4. Bind Registry to Attester
stellar contract invoke --id $REGISTRY_ID --network public --source-account <ADMIN_SIGNER> -- set_attester --attester $ATTESTER_ID

# 5. Enroll Day-One Attester Key
stellar contract invoke --id $ATTESTER_ID --network public --source-account <ADMIN_SIGNER> -- add_attester --who <ATTESTER_PUBKEY>
```

### 3. Record in `contracts/deployments.json`

Update `contracts/deployments.json`:

```json
  "public": {
    "networkPassphrase": "Public Global Stellar Network ; September 2015",
    "rpcUrl": "https://mainnet.sorobanrpc.com",
    "registry": "<REGISTRY_ID>",
    "attester": "<ATTESTER_ID>",
    "deployedAt": "2026-10-XX"
  }
```

### 4. Consumer Opt-In

- `examples/read-registry.ts`: Reads `deployments.json` for `STELLAR_NETWORK=public`.
- `RegistryRouteResolver` (`@corridor/router`): Connects to `deployments.json["public"].registry` for mainnet settlement validation.
- Workflow execution: Mainnet scheduled attestation runs under a dedicated, permissions-restricted workflow dispatch or separate cron.

---

## 6. Rollback & "Withdrawal" Strategy

Soroban contracts cannot be deleted from the ledger. If a critical defect or migration necessitates sunsetting or pausing the deployment, the following progressive withdrawal mechanisms apply:

1. **Pause Writing (Attester Revocation)**:
   - Admin invokes `Attester.remove_attester(who)` for all enrolled keys.
   - Result: No further attestations can be submitted. Existing historical data remains readable.
2. **Sever Registry Authority**:
   - Admin invokes `Registry.set_attester(<DeadAddress>)`.
   - Result: Permanently detaches the attester contract from the registry.
3. **Contract Deprecation / Tombstone**:
   - If contract logic must be deactivated, admin invokes `upgrade(tombstone_wasm_hash)` pointing to a minimal contract whose entry points revert with `DEPRECATED`.
4. **Consumer Rollback**:
   - Revert `contracts/deployments.json` public addresses to `null` or a replacement address in git. Clients fall back to fail-safe behavior.

---

## 7. Open Decisions for Maintainer Signoff

The following decisions require explicit confirmation from the repository maintainer:

1. **Multisig Composition**:
   - Finalize the list of signer public keys and threshold (2-of-3 vs. 3-of-5).
2. **Initial Cooldown (`min_interval`)**:
   - Confirm whether `720` ledgers (~1 hour) or `1440` ledgers (~2 hours) is preferred for initial mainnet operation.
3. **Attester Infrastructure**:
   - Select cloud host (AWS KMS vs. GCP Cloud KMS) for the primary production attester key.
4. **Mainnet Workflow Cadence**:
   - Confirm whether mainnet attestation runs on the same schedule as testnet (05:23 UTC) or staggered.
