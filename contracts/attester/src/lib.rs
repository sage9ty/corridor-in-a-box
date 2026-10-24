#![no_std]
//! # corridor-attester
//!
//! Who may write to the [registry](../../registry), and under what conditions.
//!
//! ## Why this is a separate contract
//!
//! The registry stores facts; this contract decides whose facts count. Keeping
//! them apart means the authorisation policy can change — add attesters, require
//! more of them, rate-limit a noisy one — without touching the contract that
//! holds the data, and without every consumer having to re-point at a new
//! registry address. The registry trusts exactly one address (this contract) and
//! nothing else, so the whole policy surface lives here.
//!
//! ## The submission path
//!
//! An attester calls `attest()`. This contract checks the caller is authorised
//! and the payload is well-formed, then cross-invokes `registry.put_anchor()`.
//! Soroban authorises that sub-invocation with this contract's own address,
//! which is what the registry requires — so there is no shared secret and no
//! hand-rolled signature check anywhere in the path.
//!
//! `attest_meta()` is the same path for the registry's metadata half — observed
//! receive assets and a declared country, relayed to `registry.put_meta()`. It is
//! a separate method rather than extra arguments on `attest` so the signature an
//! already-deployed client calls stays valid, and so a probe that could not read
//! an anchor's asset list can still put its bitmaps on chain.
//!
//! ## Rate limiting
//!
//! An attester may re-attest a given domain only once every `min_interval`
//! ledgers. Without it, a compromised or buggy attester can rewrite a record
//! every ledger, which both burns fees and destroys the freshness signal the
//! registry exists to provide — `attested_ledger` would always be "now" and
//! would tell a consumer nothing.
//!
//! ## Storage lifetime
//!
//! Soroban persistent and instance entries expire after their TTL and are then
//! archived. Every write here extends the entry it touched (an enrolment, a
//! domain's cooldown marker) and the contract instance (`Admin`, `Registry`,
//! `MinInterval`, whose expiry takes the contract offline), by the constants
//! below. `attest` also extends the signer's own enrolment, so an attester that
//! keeps attesting never lapses. An enrolled attester that goes quiet for longer
//! than the TTL does lapse, and `is_attester` then fails for it; the admin
//! restores the entry (or simply calls `add_attester` again once it is restored)
//! to bring it back. Restoring an archived entry is a `RestoreFootprint`
//! operation, which the Stellar CLI wraps as `stellar contract restore`; see the
//! registry crate's header for the details, which apply here unchanged.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Bytes, BytesN, Env, String, Vec,
};

/// The slice of the registry's interface this contract calls.
///
/// Declared as a trait rather than by depending on the `corridor-registry`
/// crate: linking the registry's implementation into this wasm pulls in its
/// `__constructor` too, and two contracts exporting that symbol fails to link
/// ("symbol multiply defined"). A `#[contractclient]` trait generates the same
/// typed client from the signature alone, with no code linked and no build-order
/// coupling between the two crates.
///
/// The real registry is still used in this crate's tests, where compilation
/// targets native rather than wasm and no such collision exists — so the
/// cross-call is exercised against the actual contract, not a stand-in.
#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn put_anchor(
        env: Env,
        domain: String,
        seps: u32,
        toml_hash: BytesN<32>,
        probes_run: u32,
        probes_passed: u32,
        attester: Address,
    );

    /// Observed receive assets and declared country for a domain. Mirrors
    /// `Registry::put_meta`.
    fn put_meta(
        env: Env,
        domain: String,
        receive_assets: Vec<String>,
        country: Option<String>,
        attester: Address,
    );
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Registry,
    /// Minimum ledgers between attestations for the same domain.
    MinInterval,
    /// Set membership for an authorised attester.
    Attester(Address),
    /// Ledger of the last accepted attestation for a domain, for rate limiting.
    LastAttest(String),
    /// Ledger of the last accepted METADATA write for a domain. Its own key
    /// rather than sharing `LastAttest`: a sweep submits both halves for one
    /// domain in one ledger, and one cooldown would make the second of the two
    /// always fail. They rate limit each other not at all — a bitmap rewrite and
    /// a receive-asset rewrite cost the same and abuse the same way.
    LastMeta(String),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialised = 1,
    /// The caller is not in the authorised attester set.
    NotAnAttester = 2,
    /// Re-attested the same domain before `min_interval` ledgers had passed.
    TooSoon = 3,
    /// A domain is not in canonical form: empty, oversized, or spelled in a way
    /// that would create a second record for an anchor that already has one.
    /// See [`is_canonical_domain`].
    InvalidDomain = 4,
    /// More receive assets than a registry record is allowed to hold.
    TooManyAssets = 5,
    /// An asset code was empty or too long to be a code.
    InvalidAssetCode = 6,
    /// The same asset code appeared twice in one submission.
    DuplicateAsset = 7,
    /// A country that is not a two-letter uppercase code.
    InvalidCountry = 8,
}

/// Ledgers close about every 5 seconds.
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// An entry is only extended once its remaining TTL has fallen below this, so a
/// burst of writes pays for one extension rather than one each. 30 days. Kept in
/// step with the registry's constant of the same name (this crate cannot depend
/// on the registry's implementation, see the note on `RegistryInterface`).
pub const TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;

/// What a write extends an entry to. 90 days: inside the network's maximum entry
/// TTL, where an extension past it is an error rather than a clamp.
pub const TTL_EXTEND_TO: u32 = 90 * LEDGERS_PER_DAY;

/// Guards against a caller writing an empty key or an unbounded blob into the
/// registry's domain list, where it would be permanent and readable by everyone.
const MAX_DOMAIN_LEN: u32 = 253; // RFC 1035 maximum hostname length.

/// One accepted spelling of one anchor.
///
/// The registry keys records by the raw string (`DataKey::Anchor(domain)`) and
/// appends every new key to the bounded `Domains` list, so a domain that is
/// merely spelled differently — `Cowrie.Exchange`, `cowrie.exchange.`,
/// `https://cowrie.exchange/` — is a second permanent record for the same
/// anchor, burning one of `MAX_DOMAINS` slots that can never be reclaimed and
/// showing a reader two conflicting facts about one host.
///
/// Canonical form, and the only form accepted here: labels of lowercase ASCII
/// letters and digits, with `-` allowed inside a label but never first or last,
/// joined by single dots. Ports are deliberately NOT allowed (`:` is rejected) —
/// a home domain is an origin, and SEP-10 requires the `HOME_DOMAIN` to name the
/// same host the toml is served from, so a port would be a different anchor's
/// key, not a different spelling of this one.
///
/// The TypeScript mirror is `isCanonicalDomain` in `@corridor/probe`; keep the
/// two in step, and the attester CLI refuses a non-canonical domain before it
/// pays for a simulation.
fn is_canonical_domain(domain: &String) -> bool {
    if domain.is_empty() || domain.len() > MAX_DOMAIN_LEN {
        return false;
    }
    let bytes = domain.to_bytes();
    let len = bytes.len();

    let mut label_start: u32 = 0;
    let mut i: u32 = 0;
    loop {
        // A dot ends a label; the end of the string ends the last one.
        if i == len || bytes.get_unchecked(i) == b'.' {
            if !is_canonical_label(&bytes, label_start, i) {
                return false;
            }
            if i == len {
                return true;
            }
            label_start = i + 1;
        }
        i += 1;
    }
}

/// One label, `bytes[start..end]`: non-empty, alphanumeric at both ends, and
/// nothing but lowercase letters, digits and inner hyphens in between. An empty
/// label (a leading, trailing or doubled dot) fails on the spot.
fn is_canonical_label(bytes: &Bytes, start: u32, end: u32) -> bool {
    if start == end {
        return false;
    }
    if !bytes.get_unchecked(start).is_ascii_alphanumeric()
        || !bytes.get_unchecked(end - 1).is_ascii_alphanumeric()
    {
        return false;
    }
    let mut i = start;
    while i < end {
        let c = bytes.get_unchecked(i);
        // Uppercase, `_`, whitespace, any non-ASCII byte: all rejected here.
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
            return false;
        }
        i += 1;
    }
    true
}

/// The registry's metadata bounds, mirrored. This crate cannot import them — see
/// the note on `RegistryInterface` — so they are restated here and pinned by the
/// `mirrors_the_registry_bounds` test, which fails if the two crates disagree.
///
/// Refusing an oversized submission HERE rather than letting the registry do it
/// is deliberate: a revert inside the cross-contract call surfaces the
/// registry's error numbering to a caller that asked the attester, which is
/// exactly the mislabelling this contract's error codes exist to avoid.
pub const MAX_RECEIVE_ASSETS: u32 = 32;
pub const MAX_ASSET_CODE_LEN: u32 = 32;
pub const COUNTRY_CODE_LEN: u32 = 2;

/// Emitted when an attestation is accepted and relayed to the registry.
#[contractevent]
pub struct Attested {
    #[topic]
    pub domain: String,
    pub attester: Address,
}

/// Emitted when a metadata write is accepted and relayed. Separate from
/// `Attested` because a sweep emits both for the same domain in the same
/// ledger, and an indexer needs to tell them apart.
#[contractevent]
pub struct MetaAttested {
    #[topic]
    pub domain: String,
    pub attester: Address,
}

/// Keep one cooldown marker and the enrolment of the signer alive.
fn touch_submission(env: &Env, last_key: &DataKey, attester: &Address) {
    extend_entry(env, last_key);
    // Signing in keeps the signer's own enrolment alive too.
    extend_entry(env, &DataKey::Attester(attester.clone()));
    extend_instance(env);
}

/// The authorisation, domain and cooldown gates every submission path shares.
fn check_submission(
    env: &Env,
    attester: &Address,
    domain: &String,
    last_key: &DataKey,
) -> Result<u32, Error> {
    attester.require_auth();
    if !Attester::is_attester(env.clone(), attester.clone()) {
        return Err(Error::NotAnAttester);
    }
    if !is_canonical_domain(domain) {
        return Err(Error::InvalidDomain);
    }

    let now = env.ledger().sequence();
    let min_interval: u32 = env
        .storage()
        .instance()
        .get(&DataKey::MinInterval)
        .ok_or(Error::NotInitialised)?;
    if let Some(last) = env.storage().persistent().get::<_, u32>(last_key) {
        if now.saturating_sub(last) < min_interval {
            return Err(Error::TooSoon);
        }
    }
    Ok(now)
}

/// Reject a receive-asset list the registry cannot store. Duplicated from the
/// registry crate for the same reason the bounds above are: this is the last
/// place a mistake can be reported with an attester error code.
fn check_receive_assets(assets: &Vec<String>) -> Result<(), Error> {
    if assets.len() > MAX_RECEIVE_ASSETS {
        return Err(Error::TooManyAssets);
    }
    for i in 0..assets.len() {
        let a = assets.get_unchecked(i);
        if a.is_empty() || a.len() > MAX_ASSET_CODE_LEN {
            return Err(Error::InvalidAssetCode);
        }
        for j in (i + 1)..assets.len() {
            if a == assets.get_unchecked(j) {
                return Err(Error::DuplicateAsset);
            }
        }
    }
    Ok(())
}

fn check_country(country: &Option<String>) -> Result<(), Error> {
    let Some(code) = country else {
        return Ok(());
    };
    if code.len() != COUNTRY_CODE_LEN {
        return Err(Error::InvalidCountry);
    }
    let bytes = code.to_bytes();
    for i in 0..COUNTRY_CODE_LEN {
        let b = bytes.get(i).ok_or(Error::InvalidCountry)?;
        if !b.is_ascii_uppercase() {
            return Err(Error::InvalidCountry);
        }
    }
    Ok(())
}

/// Keeps the contract instance (and its code) alive.
fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Keeps one persistent entry (an enrolment or a cooldown marker) alive.
fn extend_entry(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

#[contract]
pub struct Attester;

#[contractimpl]
impl Attester {
    /// `admin` manages the attester set and upgrades. `registry` is the contract
    /// this one writes to. `min_interval` is the per-domain cooldown in ledgers
    /// (~5s each, so 720 ≈ an hour).
    pub fn __constructor(env: Env, admin: Address, registry: Address, min_interval: u32) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::MinInterval, &min_interval);
        extend_instance(&env);
    }

    /// Submit an attestation for `domain`. Requires `attester`'s authorisation
    /// AND membership in the authorised set — signing is necessary but not
    /// sufficient, so a leaked key that was never enrolled achieves nothing.
    pub fn attest(
        env: Env,
        attester: Address,
        domain: String,
        seps: u32,
        toml_hash: BytesN<32>,
        probes_run: u32,
        probes_passed: u32,
    ) -> Result<(), Error> {
        let last_key = DataKey::LastAttest(domain.clone());
        let now = check_submission(&env, &attester, &domain, &last_key)?;

        let registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialised)?;

        // Cross-contract call. The registry checks that ITS configured attester
        // authorised this invocation; Soroban supplies that authorisation from
        // this contract's own address automatically.
        RegistryClient::new(&env, &registry).put_anchor(
            &domain,
            &seps,
            &toml_hash,
            &probes_run,
            &probes_passed,
            &attester,
        );

        env.storage().persistent().set(&last_key, &now);
        touch_submission(&env, &last_key, &attester);
        Attested { domain, attester }.publish(&env);
        Ok(())
    }

    /// Submit the observed receive assets and declared country for `domain`.
    ///
    /// A separate call from `attest`, not extra arguments on it, so that the
    /// already-deployed submission path keeps its exact signature: an attester
    /// running the old client must not revert just because the contract grew a
    /// field. It also means a probe that could not read the receive list still
    /// gets its SEP bitmaps on chain.
    ///
    /// Rate limited on its own clock (`LastMeta`), so a sweep may submit both
    /// halves for a domain in the same ledger.
    pub fn attest_meta(
        env: Env,
        attester: Address,
        domain: String,
        receive_assets: Vec<String>,
        country: Option<String>,
    ) -> Result<(), Error> {
        let last_key = DataKey::LastMeta(domain.clone());
        let now = check_submission(&env, &attester, &domain, &last_key)?;
        check_receive_assets(&receive_assets)?;
        check_country(&country)?;

        let registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialised)?;

        RegistryClient::new(&env, &registry).put_meta(
            &domain,
            &receive_assets,
            &country,
            &attester,
        );

        env.storage().persistent().set(&last_key, &now);
        touch_submission(&env, &last_key, &attester);
        MetaAttested { domain, attester }.publish(&env);
        Ok(())
    }

    pub fn is_attester(env: Env, who: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Attester(who))
            .unwrap_or(false)
    }

    pub fn add_attester(env: Env, who: Address) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        let key = DataKey::Attester(who);
        env.storage().persistent().set(&key, &true);
        extend_entry(&env, &key);
        extend_instance(&env);
        Ok(())
    }

    pub fn remove_attester(env: Env, who: Address) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        let key = DataKey::Attester(who);
        env.storage().persistent().set(&key, &false);
        extend_entry(&env, &key);
        extend_instance(&env);
        Ok(())
    }

    pub fn set_min_interval(env: Env, ledgers: u32) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::MinInterval, &ledgers);
        extend_instance(&env);
        Ok(())
    }

    pub fn min_interval(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::MinInterval)
            .ok_or(Error::NotInitialised)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialised)
    }

    pub fn registry(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialised)
    }

    /// Replace this contract's code. Admin only. Present from the first
    /// deployment because it cannot be retrofitted afterwards.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

mod test;
