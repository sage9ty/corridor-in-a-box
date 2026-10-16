#![no_std]
//! # corridor-registry
//!
//! An on-chain, permissionless-to-READ registry of SEP conformance facts about
//! Stellar anchors: which SEPs a domain's `stellar.toml` advertises, which
//! conformance probes it actually passed, the hash of the toml they were read
//! from, and — critically — the ledger at which someone last checked.
//!
//! ## Why this exists
//!
//! Off-ramp scarcity is the binding constraint on Stellar cross-border payments,
//! and today the only way to find out whether an anchor really serves SEP-31
//! receive-side is to go and ask it. Every operator repeats that work privately,
//! and nobody can point at a shared, timestamped answer. This contract is that
//! shared answer.
//!
//! ## What is deliberately NOT here
//!
//! Facts only. No health score, no ranking, no routing weight, no opinion about
//! which anchor you should use. Those are judgements, they depend on your own
//! risk appetite and volumes, and they belong in whatever resolver you plug into
//! your engine — not in a public record everyone reads. The split is the point:
//! verifiable facts are the public good, the interpretation is the product.
//!
//! ## Staleness is a first-class value, not an omission
//!
//! Every record carries `attested_ledger`. An attestation from 400,000 ledgers
//! ago is not wrong, it is *old*, and a consumer must be able to see that
//! difference without trusting the writer to have removed stale rows. Anything
//! that hides age would reproduce the exact failure this project is correcting:
//! reporting a lane as healthy because a string was present, rather than because
//! someone checked.
//!
//! Writes are restricted to a single configured attester contract, which holds
//! the authorisation policy. See the `attester` crate.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    String, Vec,
};

/// SEP numbers this registry can express, in bit order: bit `i` of a `seps`
/// bitmap corresponds to `SEP_NUMBERS[i]`.
///
/// A bitmap rather than a `Vec<u32>` because storage is the dominant cost and
/// this is read far more often than written. Consumers never need to know the
/// encoding — `seps_for()` decodes it for them.
pub const SEP_NUMBERS: [u32; 7] = [1, 6, 10, 12, 24, 31, 38];

/// Conformance probes, in bit order: bit `i` of a `probes` bitmap corresponds to
/// `PROBE_NAMES[i]`. Kept separate from `seps` because "the toml claims SEP-31"
/// and "a SEP-31 call actually succeeded" are different facts, and conflating
/// them is how a registry starts asserting things nobody verified.
pub const PROBE_NAMES: [&str; 5] = [
    "toml_fetch",   // stellar.toml fetched and parsed
    "sep10_auth",   // full SEP-10 challenge/response produced a JWT
    "sep38_quote",  // a firm SEP-38 quote came back with a future expiry
    "sep12_status", // SEP-12 customer status was readable
    "sep31_info",   // SEP-31 GET /info listed at least one receivable asset
];

/// Upper bound on registered domains. An unbounded list is an unbounded read
/// cost for every consumer of `domains()`, and an unbounded write cost for
/// whoever crosses the threshold. Raise it deliberately via an upgrade if the
/// ecosystem outgrows it rather than discovering the limit in production.
pub const MAX_DOMAINS: u32 = 512;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorRecord {
    /// Anchor home domain, e.g. "testanchor.stellar.org". The primary key.
    pub domain: String,
    /// Bitmap over `SEP_NUMBERS` — which SEPs the anchor advertises.
    pub seps: u32,
    /// SHA-256 of the `stellar.toml` these facts were read from. Lets a consumer
    /// detect that an anchor changed its published configuration since the
    /// attestation, without this contract having to store the file.
    pub toml_hash: BytesN<32>,
    /// Bitmap over `PROBE_NAMES` — which probes were ATTEMPTED.
    pub probes_run: u32,
    /// Bitmap over `PROBE_NAMES` — which probes PASSED. Always a subset of
    /// `probes_run`; the contract enforces that rather than trusting the writer.
    pub probes_passed: u32,
    /// Ledger sequence at which this attestation was recorded. The freshness
    /// signal — compare against the current ledger to decide if you trust it.
    pub attested_ledger: u32,
    /// Which attester address produced this record.
    pub attester: Address,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    /// The attester CONTRACT permitted to write. Not an end-user address.
    Attester,
    /// Ordered list of registered domains, for enumeration.
    Domains,
    /// One record per domain.
    Anchor(String),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    /// `probes_passed` claimed a bit that `probes_run` did not set — i.e. the
    /// writer said a probe passed without saying it ran.
    PassedExceedsRun = 3,
    /// A bit was set outside the defined `SEP_NUMBERS` / `PROBE_NAMES` range.
    UnknownBit = 4,
    RegistryFull = 5,
    NotFound = 6,
}

const SEP_MASK: u32 = (1u32 << SEP_NUMBERS.len()) - 1;
const PROBE_MASK: u32 = (1u32 << PROBE_NAMES.len()) - 1;

/// Emitted on every accepted attestation, so indexers and dashboards can follow
/// the registry without polling every key.
#[contractevent]
pub struct Attested {
    #[topic]
    pub domain: String,
    pub attested_ledger: u32,
}

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    /// `admin` may rotate the attester and upgrade the contract. `attester` is
    /// the CONTRACT address allowed to write records.
    pub fn __constructor(env: Env, admin: Address, attester: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Attester, &attester);
        env.storage()
            .instance()
            .set(&DataKey::Domains, &Vec::<String>::new(&env));
    }

    /// Record (or replace) the attestation for a domain.
    ///
    /// Restricted to the configured attester contract. Soroban lets a contract
    /// authorise its own sub-invocations, so this succeeds when the attester
    /// contract calls it and fails for everyone else — no shared secret, no
    /// signature check written by hand.
    pub fn put_anchor(
        env: Env,
        domain: String,
        seps: u32,
        toml_hash: BytesN<32>,
        probes_run: u32,
        probes_passed: u32,
        attester: Address,
    ) -> Result<(), Error> {
        let writer: Address = env
            .storage()
            .instance()
            .get(&DataKey::Attester)
            .ok_or(Error::NotInitialised)?;
        writer.require_auth();

        // Validate rather than trust. A registry that stores whatever it is
        // handed is not a source of truth, it is a mirror of its writer.
        if seps & !SEP_MASK != 0 || probes_run & !PROBE_MASK != 0 {
            return Err(Error::UnknownBit);
        }
        if probes_passed & !probes_run != 0 {
            return Err(Error::PassedExceedsRun);
        }

        let mut domains: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::Domains)
            .unwrap_or_else(|| Vec::new(&env));

        let key = DataKey::Anchor(domain.clone());
        let is_new = !env.storage().persistent().has(&key);
        if is_new {
            if domains.len() >= MAX_DOMAINS {
                return Err(Error::RegistryFull);
            }
            domains.push_back(domain.clone());
            env.storage().instance().set(&DataKey::Domains, &domains);
        }

        let record = AnchorRecord {
            domain: domain.clone(),
            seps,
            toml_hash,
            probes_run,
            probes_passed,
            attested_ledger: env.ledger().sequence(),
            attester,
        };
        env.storage().persistent().set(&key, &record);

        Attested {
            domain,
            attested_ledger: record.attested_ledger,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_anchor(env: Env, domain: String) -> Result<AnchorRecord, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Anchor(domain))
            .ok_or(Error::NotFound)
    }

    /// Every registered domain. Bounded by `MAX_DOMAINS`.
    pub fn domains(env: Env) -> Vec<String> {
        env.storage()
            .instance()
            .get(&DataKey::Domains)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// The SEP numbers a domain advertises, decoded — so callers never have to
    /// know the bitmap layout.
    pub fn seps_for(env: Env, domain: String) -> Result<Vec<u32>, Error> {
        let record = Self::get_anchor(env.clone(), domain)?;
        let mut out = Vec::new(&env);
        for (i, sep) in SEP_NUMBERS.iter().enumerate() {
            if record.seps & (1u32 << i) != 0 {
                out.push_back(*sep);
            }
        }
        Ok(out)
    }

    /// Ledger at which the domain was last attested. The freshness check a
    /// consumer should make before trusting anything else in the record.
    pub fn attested_at(env: Env, domain: String) -> Result<u32, Error> {
        Ok(Self::get_anchor(env, domain)?.attested_ledger)
    }

    /// How many ledgers old the attestation is, as of now.
    pub fn staleness(env: Env, domain: String) -> Result<u32, Error> {
        let at = Self::attested_at(env.clone(), domain)?;
        Ok(env.ledger().sequence().saturating_sub(at))
    }

    /// Whether the domain both advertises SEP-31 and passed the SEP-31 probe.
    /// The question an operator actually has, answered without a decoder ring.
    pub fn serves_sep31(env: Env, domain: String) -> Result<bool, Error> {
        let r = Self::get_anchor(env, domain)?;
        let sep31_bit = 1u32 << 5; // index of 31 in SEP_NUMBERS
        let probe_bit = 1u32 << 4; // index of sep31_info in PROBE_NAMES
        Ok(r.seps & sep31_bit != 0 && r.probes_passed & probe_bit != 0)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialised)
    }

    pub fn attester(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Attester)
            .ok_or(Error::NotInitialised)
    }

    /// Point the registry at a different attester contract. Admin only.
    pub fn set_attester(env: Env, attester: Address) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        env.storage().instance().set(&DataKey::Attester, &attester);
        Ok(())
    }

    /// Replace this contract's code. Admin only.
    ///
    /// Present from the first deployment on purpose: a mainnet contract without
    /// an upgrade path is a bug you cannot fix, and retrofitting one is not
    /// possible after the fact.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

mod test;
