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
//!
//! ## Storage lifetime
//!
//! Soroban persistent and instance entries expire after their TTL and are then
//! archived: a read of an archived entry fails until someone restores it. Every
//! write here therefore extends the entry it touched, and the contract instance
//! (which holds `Admin`, `Attester` and the `domains()` list, and whose expiry
//! takes the whole contract offline), by the constants below. `bump(domain)` lets
//! anyone keep a record alive without re-attesting it, so an anchor that is no
//! longer attested (say, one removed from `contracts/anchors.json`) is not
//! archived just because nobody wrote to it. `bump` does not change
//! `attested_ledger`: the record stays exactly as old as it was.
//!
//! The extension is capped by the network's maximum entry TTL, and an entry only
//! lives that long if something touches it again before then. Calling `bump` for
//! every registered domain at least once per `TTL_THRESHOLD` window is enough.
//!
//! ### Restoring an archived entry
//!
//! `bump` cannot revive an entry that has already been archived: the network
//! rejects any transaction that touches one. Submit a `RestoreFootprint`
//! operation for the archived key first (the Stellar CLI wraps it as
//! `stellar contract restore`; see its `--help` for the key flags), which brings
//! the entry back live, and then call `bump(domain)` to extend it again. Restoring
//! the contract instance the same way brings back `Admin`, `Attester` and
//! `domains()`.
//!
//! ## Migration
//!
//! When updating the registry contract in place via `upgrade()` (see `upgrade`
//! in the implementation below), existing anchor records are retained as-is in
//! storage. Because new probe bits are strictly appended, existing records
//! maintain their validity and previous bit meanings. Old records written
//! before new probes were added will read `serves_sep6 == false` until they are
//! re-attested by an attester that runs the new probes.
//!
//! Anchor metadata works the same way. It lives under its own
//! `DataKey::Meta(domain)` rather than inside `AnchorRecord`, so no existing
//! record has to be rewritten for the field to exist. A domain attested before
//! the upgrade simply has no meta entry, and `get_meta` answers `NotFound` for
//! it rather than inventing an empty list — "nobody looked" and "it receives
//! nothing" are different facts, and a default would conflate them.
//!
//! ## What metadata is, and what it is not
//!
//! `AnchorMeta` holds two things, and the facts-not-opinions rule above still
//! applies to both, because they are different kinds of claim:
//!
//! - `receive_assets` is OBSERVED — the asset codes a SEP-31 `/info` response
//!   actually listed when the probe ran.
//! - `country` is DECLARED — the anchor's own `stellar.toml` says where it is
//!   physically located. Nothing about it was verified.
//!
//! Both carry the ledger they were read at and the attester that read them, the
//! same freshness discipline as the bitmaps. See `docs/registry-metadata.md`
//! for why this is a second key rather than a new field on `AnchorRecord`, and
//! for the bounds `put_meta` enforces.

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
pub const PROBE_NAMES: [&str; 7] = [
    "toml_fetch",   // stellar.toml fetched and parsed
    "sep10_auth",   // full SEP-10 challenge/response produced a JWT
    "sep38_quote",  // a firm SEP-38 quote came back with a future expiry
    "sep12_status", // SEP-12 customer status was readable
    "sep31_info",   // SEP-31 GET /info listed at least one receivable asset
    "sep6_info",    // SEP-6 GET /info listed at least one withdraw asset
    "sep6_auth",    // SEP-6 authenticated read succeeded
];

/// Upper bound on registered domains. An unbounded list is an unbounded read
/// cost for every consumer of `domains()`, and an unbounded write cost for
/// whoever crosses the threshold. Raise it deliberately via an upgrade if the
/// ecosystem outgrows it rather than discovering the limit in production.
pub const MAX_DOMAINS: u32 = 512;

/// Upper bound on the receive asset codes stored per anchor. An anchor listing
/// more than this has assets nobody can route through, and the list is read in
/// full by `get_meta`, so its size is the size of that read.
pub const MAX_RECEIVE_ASSETS: u32 = 32;

/// Upper bound on one asset code, in bytes. Real codes are 3-12 characters
/// (`NGN`, `USDC:G…`); the slack is for a quoted `iso4217:NGN`-style form
/// without letting the field become a blob.
pub const MAX_ASSET_CODE_LEN: u32 = 32;

/// Length of a country code: ISO-3166-1 alpha-2, uppercase ASCII. Fixed rather
/// than ranged so `country` can be compared by consumers without normalising,
/// and so a free-text address line cannot be written into it by accident.
pub const COUNTRY_CODE_LEN: u32 = 2;

/// Ledgers close about every 5 seconds.
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// An entry is only extended when its remaining TTL has fallen below this, so a
/// burst of writes pays for one extension rather than one each. 30 days.
pub const TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;

/// What a write or `bump` extends an entry to. 90 days: comfortably inside the
/// network's maximum entry TTL (an extension past it is an error, not a clamp),
/// and three times the threshold so that a write always buys a real extension.
pub const TTL_EXTEND_TO: u32 = 90 * LEDGERS_PER_DAY;

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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorMeta {
    /// Anchor home domain this metadata was read under. Matches the
    /// `AnchorRecord` key it sits beside; stored so a reader that only has the
    /// value can tell what it describes.
    pub domain: String,
    /// OBSERVED: asset codes the anchor's SEP-31 `/info` listed as receivable.
    /// Empty when the probe ran and it listed nothing — which is the
    /// `testanchor.stellar.org` case this registry exists to record.
    pub receive_assets: Vec<String>,
    /// DECLARED: ISO-3166-1 alpha-2 country from the anchor's own
    /// `stellar.toml`. `None` means the toml had no machine-readable country —
    /// it is not a claim that the anchor has none.
    pub country: Option<String>,
    /// Ledger at which this metadata was read. A separate clock from the
    /// record's `attested_ledger`, because the two are written by separate
    /// calls: metadata from last week is not evidence about this week's
    /// bitmaps, or the other way round.
    pub attested_ledger: u32,
    /// Which attester address produced this metadata.
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
    /// Observed/declared metadata for a domain, deliberately NOT inside
    /// `Anchor(String)`: writing it must not have to rewrite the record, and
    /// records that predate it must stay readable untouched.
    Meta(String),
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
    /// No record for the domain asked about — from a read, or from
    /// `put_meta`, which refuses to store metadata about a domain that has
    /// never been attested, because there would be nothing to read it against.
    NotFound = 6,
    /// More than `MAX_RECEIVE_ASSETS` asset codes in one write.
    TooManyAssets = 7,
    /// An asset code was empty, or longer than `MAX_ASSET_CODE_LEN`.
    InvalidAssetCode = 8,
    /// The same asset code appeared twice in one write.
    DuplicateAsset = 9,
    /// A country that is not `COUNTRY_CODE_LEN` uppercase ASCII letters.
    InvalidCountry = 10,
}

const SEP_MASK: u32 = (1u32 << SEP_NUMBERS.len()) - 1;
const PROBE_MASK: u32 = (1u32 << PROBE_NAMES.len()) - 1;

pub const fn sep_bit(sep: u32) -> Option<u32> {
    let mut i = 0;
    while i < SEP_NUMBERS.len() {
        if SEP_NUMBERS[i] == sep {
            return Some(1u32 << i);
        }
        i += 1;
    }
    None
}

pub const fn probe_bit(name: &str) -> Option<u32> {
    let mut i = 0;
    while i < PROBE_NAMES.len() {
        let a = PROBE_NAMES[i].as_bytes();
        let b = name.as_bytes();
        if a.len() == b.len() {
            let mut j = 0;
            let mut eq = true;
            while j < a.len() {
                if a[j] != b[j] {
                    eq = false;
                    break;
                }
                j += 1;
            }
            if eq {
                return Some(1u32 << i);
            }
        }
        i += 1;
    }
    None
}

/// Emitted on every accepted attestation, so indexers and dashboards can follow
/// the registry without polling every key.
///
/// ## Event Schema Version
/// - **v1** (initial): topic `("attested", domain)`, data `{ attested_ledger }`.
/// - **v2** (current): topic `("attested", domain)`, data `{ seps, toml_hash, probes_run, probes_passed, attested_ledger, attester }`.
///   Indexers can distinguish v2 from v1 by inspecting the map keys in the event data body
///   (v2 carries the full attestation payload alongside `attested_ledger`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attested {
    #[topic]
    pub domain: String,
    pub seps: u32,
    pub toml_hash: BytesN<32>,
    pub probes_run: u32,
    pub probes_passed: u32,
    pub attested_ledger: u32,
    pub attester: Address,
}

/// Emitted on every accepted metadata write. Separate from `Attested` because
/// the two are written by separate calls and land in separate ledgers: an
/// indexer that assumed one event per attestation would drop whichever half
/// arrived on its own.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetaAttested {
    #[topic]
    pub domain: String,
    pub receive_assets: Vec<String>,
    pub country: Option<String>,
    pub attested_ledger: u32,
    pub attester: Address,
}

/// Keeps the contract instance (its `Admin`, `Attester` and `Domains`, and its
/// code) alive. Called from every path that writes instance storage.
fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Keeps one anchor record alive.
fn extend_record(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Validate a receive-asset list the way `put_meta` stores it: bounded in
/// count, bounded per code, no empty code, no code written twice.
///
/// Order is not checked — the list is an observation of what an anchor's own
/// `/info` endpoint returned, and re-sorting it here would silently rewrite
/// what a probe saw. Duplicates are a different matter: they make `len()` a
/// lie about how many assets an anchor receives.
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

/// Validate a declared country: absent, or exactly `COUNTRY_CODE_LEN`
/// uppercase ASCII letters. Rejecting `ngn`-style lowercase rather than
/// normalising it is deliberate — normalising here would mean two spellings of
/// the same country can be written and only one of them read back.
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
        extend_instance(&env);
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

        let attested_ledger = env.ledger().sequence();
        let record = AnchorRecord {
            domain: domain.clone(),
            seps,
            toml_hash: toml_hash.clone(),
            probes_run,
            probes_passed,
            attested_ledger,
            attester: attester.clone(),
        };
        env.storage().persistent().set(&key, &record);
        extend_record(&env, &key);
        extend_instance(&env);

        Attested {
            domain,
            seps,
            toml_hash,
            probes_run,
            probes_passed,
            attested_ledger,
            attester,
        }
        .publish(&env);
        Ok(())
    }

    /// Record (or replace) the observed receive assets and declared country for
    /// a domain. Same writer restriction as [`Registry::put_anchor`].
    ///
    /// Written separately from the record, and requires one to exist: metadata
    /// about a domain nobody has ever attested is a claim with no facts behind
    /// it, and it would be invisible to every read that starts from `domains()`.
    ///
    /// Passing an empty `receive_assets` says the probe ran and the anchor
    /// listed nothing, which is a real finding about an anchor that advertises
    /// SEP-31. To say nothing was observed, do not call this at all — the
    /// absence of a meta entry is what `get_meta` reports as `NotFound`.
    pub fn put_meta(
        env: Env,
        domain: String,
        receive_assets: Vec<String>,
        country: Option<String>,
        attester: Address,
    ) -> Result<(), Error> {
        let writer: Address = env
            .storage()
            .instance()
            .get(&DataKey::Attester)
            .ok_or(Error::NotInitialised)?;
        writer.require_auth();

        if !env
            .storage()
            .persistent()
            .has(&DataKey::Anchor(domain.clone()))
        {
            return Err(Error::NotFound);
        }
        check_receive_assets(&receive_assets)?;
        check_country(&country)?;

        let key = DataKey::Meta(domain.clone());
        let attested_ledger = env.ledger().sequence();
        let meta = AnchorMeta {
            domain: domain.clone(),
            receive_assets: receive_assets.clone(),
            country: country.clone(),
            attested_ledger,
            attester: attester.clone(),
        };
        env.storage().persistent().set(&key, &meta);
        extend_record(&env, &key);
        extend_instance(&env);

        MetaAttested {
            domain,
            receive_assets,
            country,
            attested_ledger,
            attester,
        }
        .publish(&env);
        Ok(())
    }

    /// Extend the lifetime of a record, and of the contract instance, without
    /// re-attesting. Permissionless on purpose: keeping a fact readable costs the
    /// caller a fee and changes nothing, `attested_ledger` included, so there is
    /// nothing to protect and no reason to make a dashboard ask the attester.
    ///
    /// Extends the domain's metadata entry too when it has one — it expires on
    /// its own clock, and letting it archive while the record next to it stays
    /// live would leave a domain that answers `get_anchor` but not `get_meta`.
    ///
    /// Cannot revive an entry that is already archived; see "Restoring an
    /// archived entry" in the header.
    pub fn bump(env: Env, domain: String) -> Result<(), Error> {
        let key = DataKey::Anchor(domain.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NotFound);
        }
        extend_record(&env, &key);
        let meta_key = DataKey::Meta(domain);
        if env.storage().persistent().has(&meta_key) {
            extend_record(&env, &meta_key);
        }
        extend_instance(&env);
        Ok(())
    }

    pub fn get_anchor(env: Env, domain: String) -> Result<AnchorRecord, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Anchor(domain))
            .ok_or(Error::NotFound)
    }

    /// Observed receive assets and declared country for a domain.
    ///
    /// `NotFound` covers both "never attested" and "attested before this existed":
    /// a record written by the previous version of this contract simply has no
    /// meta entry, and inventing an empty one would report an anchor as
    /// receiving nothing when nobody has asked it yet.
    pub fn get_meta(env: Env, domain: String) -> Result<AnchorMeta, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Meta(domain))
            .ok_or(Error::NotFound)
    }

    /// Whether an anchor was OBSERVED receiving a given asset code, e.g. "does
    /// this anchor pay out NGN". Matches the stored list exactly — a caller that
    /// wants to compare `NGN` against `iso4217:NGN` is comparing two different
    /// things an anchor may well answer differently.
    pub fn receives_asset(env: Env, domain: String, code: String) -> Result<bool, Error> {
        Ok(Self::get_meta(env, domain)?.receive_assets.contains(&code))
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
        Self::serves(env, domain, 31)
    }

    /// Whether the domain both advertises SEP-6 and passed the sep6_info probe.
    pub fn serves_sep6(env: Env, domain: String) -> Result<bool, Error> {
        Self::serves(env, domain, 6)
    }

    /// Generic query: whether the domain advertises the given SEP and passed
    /// its defined probe. Returns false for SEPs with no defined probe.
    pub fn serves(env: Env, domain: String, sep: u32) -> Result<bool, Error> {
        let r = Self::get_anchor(env, domain)?;
        let (sep_bit, probe_bit) = match sep {
            31 => (sep_bit(31), probe_bit("sep31_info")),
            6 => (sep_bit(6), probe_bit("sep6_info")),
            _ => return Ok(false),
        };
        let (Some(sb), Some(pb)) = (sep_bit, probe_bit) else {
            return Ok(false);
        };
        Ok(r.seps & sb != 0 && r.probes_passed & pb != 0)
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
        extend_instance(&env);
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
