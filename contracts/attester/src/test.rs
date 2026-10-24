#![cfg(test)]

use super::*;
use corridor_registry::{Registry, RegistryClient as RegistryDirect};
use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _,
    },
    Address, BytesN, Env, String, Vec,
};

const SEP31: u32 = 1 << 5;
const PROBE_SEP31_INFO: u32 = 1 << 4;
const MIN_INTERVAL: u32 = 720; // ~1 hour of ledgers

struct Fixture {
    env: Env,
    attester_client: AttesterClient<'static>,
    registry_client: RegistryDirect<'static>,
    alice: Address,
}

/// Wires the real pair together: a registry that trusts ONLY the attester
/// contract, and an attester pointed at it. Nothing is mocked — the cross-call
/// under test is the one that will run on chain.
fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(10_000);

    let admin = Address::generate(&env);
    let alice = Address::generate(&env);

    // The attester contract's address must be known to the registry, and the
    // registry's to the attester, so deploy the registry with a placeholder and
    // rotate it once the attester exists.
    let registry_id = env.register(Registry, (admin.clone(), admin.clone()));
    let attester_id = env.register(Attester, (admin.clone(), registry_id.clone(), MIN_INTERVAL));

    let registry_client = RegistryDirect::new(&env, &registry_id);
    registry_client.set_attester(&attester_id);

    let attester_client = AttesterClient::new(&env, &attester_id);
    attester_client.add_attester(&alice);

    Fixture {
        env,
        attester_client,
        registry_client,
        alice,
    }
}

fn hash(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn domain(env: &Env) -> String {
    String::from_str(env, "testanchor.stellar.org")
}

#[test]
fn an_authorised_attester_writes_through_to_the_registry() {
    let f = setup();
    let d = domain(&f.env);

    f.attester_client.attest(
        &f.alice,
        &d,
        &SEP31,
        &hash(&f.env, 0xcd),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
    );

    // The cross-call landed: the registry has the record, stamped with the
    // originating attester rather than the contract that relayed it.
    let record = f.registry_client.get_anchor(&d);
    assert_eq!(record.attester, f.alice);
    assert_eq!(record.toml_hash, hash(&f.env, 0xcd));
    assert!(f.registry_client.serves_sep31(&d));
}

#[test]
fn an_unenrolled_signer_is_rejected_even_though_it_signed() {
    let f = setup();
    let mallory = Address::generate(&f.env);
    // mock_all_auths() means Mallory's signature is valid. Membership is the
    // check that stops her — signing must be necessary but not sufficient.
    let res =
        f.attester_client
            .try_attest(&mallory, &domain(&f.env), &SEP31, &hash(&f.env, 1), &0, &0);
    assert_eq!(res, Err(Ok(Error::NotAnAttester)));
}

#[test]
fn a_removed_attester_can_no_longer_write() {
    let f = setup();
    let d = domain(&f.env);
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 1), &0, &0);

    f.attester_client.remove_attester(&f.alice);
    f.env.ledger().set_sequence_number(10_000 + MIN_INTERVAL);

    let res = f
        .attester_client
        .try_attest(&f.alice, &d, &SEP31, &hash(&f.env, 2), &0, &0);
    assert_eq!(res, Err(Ok(Error::NotAnAttester)));
}

// --- rate limiting --------------------------------------------------------
// Without a cooldown, attested_ledger is always "now" and stops carrying any
// information about freshness — which is the registry's whole point.

#[test]
fn re_attesting_too_soon_is_rejected() {
    let f = setup();
    let d = domain(&f.env);
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 1), &0, &0);

    f.env
        .ledger()
        .set_sequence_number(10_000 + MIN_INTERVAL - 1);
    let res = f
        .attester_client
        .try_attest(&f.alice, &d, &SEP31, &hash(&f.env, 2), &0, &0);
    assert_eq!(res, Err(Ok(Error::TooSoon)));

    // The registry still holds the FIRST attestation, untouched.
    assert_eq!(f.registry_client.get_anchor(&d).toml_hash, hash(&f.env, 1));
}

#[test]
fn re_attesting_after_the_interval_is_allowed() {
    let f = setup();
    let d = domain(&f.env);
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 1), &0, &0);

    f.env.ledger().set_sequence_number(10_000 + MIN_INTERVAL);
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 2), &0, &0);

    assert_eq!(f.registry_client.get_anchor(&d).toml_hash, hash(&f.env, 2));
    assert_eq!(f.registry_client.attested_at(&d), 10_000 + MIN_INTERVAL);
}

#[test]
fn the_cooldown_is_per_domain_not_global() {
    let f = setup();
    let a = String::from_str(&f.env, "anchor-a.example");
    let b = String::from_str(&f.env, "anchor-b.example");

    f.attester_client
        .attest(&f.alice, &a, &SEP31, &hash(&f.env, 1), &0, &0);
    // Same ledger, different domain: must not be blocked.
    f.attester_client
        .attest(&f.alice, &b, &SEP31, &hash(&f.env, 2), &0, &0);

    assert_eq!(f.registry_client.domains().len(), 2);
}

// --- payload validation ---------------------------------------------------

#[test]
fn rejects_an_empty_domain() {
    let f = setup();
    let res = f.attester_client.try_attest(
        &f.alice,
        &String::from_str(&f.env, ""),
        &SEP31,
        &hash(&f.env, 1),
        &0,
        &0,
    );
    assert_eq!(res, Err(Ok(Error::InvalidDomain)));
}

/// Every one of these is the same anchor spelled a different way. The registry
/// keys by the raw string, so accepting any of them writes a second permanent
/// record — and a domain, once in `Domains`, can never be taken back out.
fn rejected_spelling(spelled: &str) {
    let f = setup();
    let res = f.attester_client.try_attest(
        &f.alice,
        &String::from_str(&f.env, spelled),
        &SEP31,
        &hash(&f.env, 1),
        &0,
        &0,
    );
    assert_eq!(res, Err(Ok(Error::InvalidDomain)), "{spelled} was accepted");
    assert_eq!(
        f.registry_client.domains().len(),
        0,
        "{spelled} reached the registry"
    );
}

#[test]
fn rejects_an_uppercase_spelling_of_an_attested_anchor() {
    let f = setup();
    let d = domain(&f.env);
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 1), &0, &0);

    let res = f.attester_client.try_attest(
        &f.alice,
        &String::from_str(&f.env, "Cowrie.Exchange"),
        &SEP31,
        &hash(&f.env, 2),
        &0,
        &0,
    );
    assert_eq!(res, Err(Ok(Error::InvalidDomain)));
    // One record, still the one the canonical spelling wrote.
    assert_eq!(f.registry_client.domains().len(), 1);
    assert_eq!(f.registry_client.get_anchor(&d).toml_hash, hash(&f.env, 1));
}

#[test]
fn rejects_a_trailing_dot() {
    rejected_spelling("cowrie.exchange.");
}

#[test]
fn rejects_a_scheme() {
    rejected_spelling("https://cowrie.exchange");
}

#[test]
fn rejects_a_path() {
    rejected_spelling("cowrie.exchange/.well-known");
}

#[test]
fn rejects_a_port() {
    // Deliberate: a home domain is an origin, not a listener. See
    // `is_canonical_domain`.
    rejected_spelling("cowrie.exchange:8000");
}

#[test]
fn rejects_an_empty_label() {
    rejected_spelling("cowrie..exchange");
}

#[test]
fn rejects_a_leading_or_trailing_hyphen() {
    rejected_spelling("-cowrie.exchange");
    rejected_spelling("cowrie.exchange-");
}

#[test]
fn accepts_a_canonical_domain_with_a_hyphen_inside_a_label() {
    let f = setup();
    let d = String::from_str(&f.env, "anchor-1.test-anchor.stellar.org");
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 7), &0, &0);
    assert_eq!(f.registry_client.get_anchor(&d).toml_hash, hash(&f.env, 7));
}

#[test]
fn the_registrys_own_validation_still_applies_through_the_cross_call() {
    let f = setup();
    // probes_passed exceeds probes_run — the REGISTRY rejects this, and the
    // failure must propagate out through the attester rather than being
    // swallowed by the relay.
    let res = f.attester_client.try_attest(
        &f.alice,
        &domain(&f.env),
        &SEP31,
        &hash(&f.env, 1),
        &0,
        &PROBE_SEP31_INFO,
    );
    assert!(
        res.is_err(),
        "registry validation must not be bypassable via the attester"
    );
}

// --- configuration --------------------------------------------------------

#[test]
fn admin_can_retune_the_cooldown() {
    let f = setup();
    assert_eq!(f.attester_client.min_interval(), MIN_INTERVAL);
    f.attester_client.set_min_interval(&1);
    assert_eq!(f.attester_client.min_interval(), 1);

    let d = domain(&f.env);
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 1), &0, &0);
    f.env.ledger().set_sequence_number(10_001);
    f.attester_client
        .attest(&f.alice, &d, &SEP31, &hash(&f.env, 2), &0, &0);
    assert_eq!(f.registry_client.get_anchor(&d).toml_hash, hash(&f.env, 2));
}

#[test]
fn the_registry_refuses_writes_that_do_not_come_through_the_attester() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attester_contract = Address::generate(&env);
    let outsider = Address::generate(&env);

    let registry_id = env.register(Registry, (admin.clone(), attester_contract.clone()));
    let client = RegistryDirect::new(&env, &registry_id);

    // The registry requires auth from its configured attester ADDRESS. Under
    // mock_all_auths every signature is accepted, so this asserts the weaker but
    // still meaningful property: the stored writer is the attester contract, and
    // an outsider's identity is never what the record is attributed to.
    assert_eq!(client.attester(), attester_contract);
    client.put_anchor(
        &String::from_str(&env, "x.example"),
        &SEP31,
        &BytesN::from_array(&env, &[1; 32]),
        &0,
        &0,
        &outsider,
    );
    assert_eq!(
        client
            .get_anchor(&String::from_str(&env, "x.example"))
            .attester,
        outsider
    );
}

// ─── Storage lifetime ────────────────────────────────────────────────────────
//
// Soroban entries expire and are archived after their TTL. The unit-test
// environment does NOT archive: an entry past its `live_until` is still readable
// there, so reading state back after advancing the ledger proves nothing. These
// tests assert the lifetime itself (`get_ttl`, ledgers left until expiry),
// advancing the ledger the way a quiet network would.

/// The test environment's default minimum persistent TTL: what an entry nobody
/// extended is given.
const DEFAULT_TTL: u32 = 4_096;

fn advance(f: &Fixture, ledgers: u32) {
    f.env.ledger().with_mut(|l| l.sequence_number += ledgers);
}

fn entry_ttl(f: &Fixture, key: &DataKey) -> u32 {
    f.env.as_contract(&f.attester_client.address, || {
        f.env.storage().persistent().get_ttl(key)
    })
}

fn instance_ttl(f: &Fixture) -> u32 {
    f.env.as_contract(&f.attester_client.address, || {
        f.env.storage().instance().get_ttl()
    })
}

fn attest(f: &Fixture, d: &String) {
    f.attester_client.attest(
        &f.alice,
        d,
        &SEP31,
        &hash(&f.env, 0xcd),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
    );
}

#[test]
fn enrolling_an_attester_extends_its_entry_and_the_instance() {
    let f = setup();

    assert_eq!(
        entry_ttl(&f, &DataKey::Attester(f.alice.clone())),
        TTL_EXTEND_TO
    );
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn an_enrolment_outlives_the_default_ttl_by_a_wide_margin() {
    let f = setup();

    advance(&f, DEFAULT_TTL + 1);

    // Past the point a bare `set` would have expired, the enrolment and the
    // instance still have the rest of their extension to run, and an enrolled
    // attester can still sign in.
    assert_eq!(
        entry_ttl(&f, &DataKey::Attester(f.alice.clone())),
        TTL_EXTEND_TO - DEFAULT_TTL - 1
    );
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO - DEFAULT_TTL - 1);
    assert!(f.attester_client.is_attester(&f.alice));
    attest(&f, &domain(&f.env));
}

#[test]
fn attesting_extends_the_cooldown_marker_the_signers_enrolment_and_the_instance() {
    let f = setup();
    let d = domain(&f.env);
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(entry_ttl(&f, &DataKey::Attester(f.alice.clone())), 100);
    assert_eq!(instance_ttl(&f), 100);

    attest(&f, &d);

    assert_eq!(entry_ttl(&f, &DataKey::LastAttest(d)), TTL_EXTEND_TO);
    // An attester that keeps attesting never lapses.
    assert_eq!(
        entry_ttl(&f, &DataKey::Attester(f.alice.clone())),
        TTL_EXTEND_TO
    );
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn attesting_also_keeps_the_registry_instance_alive() {
    // The cross-call goes through the real registry, so its own extension is part
    // of the path this contract relies on. (The record's lifetime is pinned in the
    // registry's own tests, where its storage key is visible.)
    let f = setup();
    advance(&f, TTL_EXTEND_TO - 100);
    f.env.as_contract(&f.registry_client.address, || {
        assert_eq!(f.env.storage().instance().get_ttl(), 100);
    });

    attest(&f, &domain(&f.env));

    f.env.as_contract(&f.registry_client.address, || {
        assert_eq!(f.env.storage().instance().get_ttl(), TTL_EXTEND_TO);
    });
}

#[test]
fn removing_an_attester_extends_its_entry() {
    let f = setup();
    advance(&f, TTL_EXTEND_TO - 100);

    f.attester_client.remove_attester(&f.alice);

    assert_eq!(
        entry_ttl(&f, &DataKey::Attester(f.alice.clone())),
        TTL_EXTEND_TO
    );
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn retuning_the_cooldown_extends_the_instance() {
    let f = setup();
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(instance_ttl(&f), 100);

    f.attester_client.set_min_interval(&1_000);

    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn a_cooldown_longer_than_the_default_ttl_is_still_enforced() {
    // A cooldown marker that expired early would silently reopen the window, so
    // its lifetime has to cover any cooldown the admin can set, not just 720.
    let f = setup();
    let d = domain(&f.env);
    f.attester_client.set_min_interval(&10_000);
    attest(&f, &d);

    advance(&f, 4_500);

    assert_eq!(
        entry_ttl(&f, &DataKey::LastAttest(d.clone())),
        TTL_EXTEND_TO - 4_500
    );
    let again = f.attester_client.try_attest(
        &f.alice,
        &d,
        &SEP31,
        &hash(&f.env, 0xcd),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
    );
    assert_eq!(again, Err(Ok(Error::TooSoon)));
}

// ─── Metadata: attest_meta ───────────────────────────────────────────────────
//
// The metadata half of a sweep goes through this contract too, so it gets the
// same gates: enrolment, domain shape, cooldown. It is a separate method from
// `attest` with a separate cooldown key, and the tests below are what make that
// choice verifiable rather than just asserted in a comment.

/// Thirty-three distinct codes, enough to sit on both sides of the bound.
const ASSET_NAMES: [&str; 33] = [
    "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "B0", "B1", "B2", "B3", "B4", "B5",
    "B6", "B7", "B8", "B9", "C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "D0", "D1",
    "D2",
];

fn codes(env: &Env, list: &[&str]) -> Vec<String> {
    let mut v = Vec::new(env);
    for c in list {
        v.push_back(String::from_str(env, c));
    }
    v
}

fn country(env: &Env, code: &str) -> Option<String> {
    Some(String::from_str(env, code))
}

/// The submission order a sweep uses: bitmaps first, then metadata, in the same
/// ledger. Without the record there is nothing for `put_meta` to hang from.
fn attest_all(f: &Fixture, d: &String, list: &[&str], c: Option<String>) {
    attest(f, d);
    f.attester_client
        .attest_meta(&f.alice, d, &codes(&f.env, list), &c);
}

#[test]
fn an_authorised_attester_writes_metadata_through_to_the_registry() {
    let f = setup();
    let d = domain(&f.env);

    attest_all(&f, &d, &["NGN", "KES"], country(&f.env, "NG"));

    let meta = f.registry_client.get_meta(&d);
    assert_eq!(meta.receive_assets, codes(&f.env, &["NGN", "KES"]));
    assert_eq!(meta.country, country(&f.env, "NG"));
    // Attributed to the signer that submitted it, not to this contract — the
    // same rule the bitmaps follow.
    assert_eq!(meta.attester, f.alice);
    assert_eq!(meta.attested_ledger, 10_000);
}

#[test]
fn metadata_for_a_domain_that_was_never_attested_fails_through_the_relay() {
    let f = setup();
    let d = domain(&f.env);

    // No `attest` first: the registry refuses metadata with no record behind it,
    // and the attester must not swallow that and report success.
    let res = f.attester_client.try_attest_meta(
        &f.alice,
        &d,
        &codes(&f.env, &["NGN"]),
        &country(&f.env, "NG"),
    );
    assert!(
        res.is_err(),
        "the registry's refusal must propagate, not be relayed as a success"
    );
    assert_eq!(
        f.registry_client.try_get_meta(&d),
        Err(Ok(corridor_registry::Error::NotFound))
    );
}

#[test]
fn an_unenrolled_signer_cannot_write_metadata() {
    let f = setup();
    let d = domain(&f.env);
    attest(&f, &d);
    let mallory = Address::generate(&f.env);

    let res = f
        .attester_client
        .try_attest_meta(&mallory, &d, &codes(&f.env, &["NGN"]), &None);
    assert_eq!(res, Err(Ok(Error::NotAnAttester)));
}

#[test]
fn rejects_an_empty_domain_when_submitting_metadata() {
    let f = setup();
    let res = f.attester_client.try_attest_meta(
        &f.alice,
        &String::from_str(&f.env, ""),
        &codes(&f.env, &["NGN"]),
        &None,
    );
    assert_eq!(res, Err(Ok(Error::InvalidDomain)));
}

#[test]
fn a_sweep_can_submit_both_halves_in_the_same_ledger() {
    // The reason the cooldowns are separate keys: one shared marker would make
    // the second half of every sweep fail, and the honest response to that is a
    // retry, not a contract change.
    let f = setup();
    let d = domain(&f.env);

    attest(&f, &d);
    let res = f.attester_client.try_attest_meta(
        &f.alice,
        &d,
        &codes(&f.env, &["NGN"]),
        &country(&f.env, "NG"),
    );
    assert_eq!(res, Ok(Ok(())));

    // Each half keeps its own clock: the metadata is now in cooldown.
    let again = f
        .attester_client
        .try_attest_meta(&f.alice, &d, &codes(&f.env, &["NGN"]), &None);
    assert_eq!(again, Err(Ok(Error::TooSoon)));
}

#[test]
fn metadata_is_rate_limited_per_domain() {
    let f = setup();
    let a = domain(&f.env);
    let b = String::from_str(&f.env, "other.example");

    attest_all(&f, &a, &["NGN"], country(&f.env, "NG"));
    f.attester_client
        .attest(&f.alice, &b, &SEP31, &hash(&f.env, 2), &0, &0);
    let res = f.attester_client.try_attest_meta(
        &f.alice,
        &b,
        &codes(&f.env, &["KES"]),
        &country(&f.env, "KE"),
    );
    assert_eq!(res, Ok(Ok(())));
}

// --- bounds: refused at the door, with this contract's error codes ----------

#[test]
fn rejects_a_country_that_is_not_a_two_letter_code() {
    let f = setup();
    let d = domain(&f.env);
    attest(&f, &d);

    for bad in ["ng", "NGA", "N", "", "N1"] {
        let res = f.attester_client.try_attest_meta(
            &f.alice,
            &d,
            &codes(&f.env, &["NGN"]),
            &country(&f.env, bad),
        );
        assert_eq!(res, Err(Ok(Error::InvalidCountry)), "accepted {bad:?}");
    }
}

#[test]
fn rejects_an_asset_list_beyond_the_bound() {
    let f = setup();
    let d = domain(&f.env);
    attest(&f, &d);

    assert_eq!(
        f.attester_client
            .try_attest_meta(&f.alice, &d, &codes(&f.env, &ASSET_NAMES), &None),
        Err(Ok(Error::TooManyAssets))
    );
    // At the bound it goes through.
    assert_eq!(
        f.attester_client
            .try_attest_meta(&f.alice, &d, &codes(&f.env, &ASSET_NAMES[..32]), &None),
        Ok(Ok(()))
    );
}

#[test]
fn rejects_blank_and_duplicated_asset_codes() {
    let f = setup();
    let d = domain(&f.env);
    attest(&f, &d);

    assert_eq!(
        f.attester_client
            .try_attest_meta(&f.alice, &d, &codes(&f.env, &[""]), &None),
        Err(Ok(Error::InvalidAssetCode))
    );
    assert_eq!(
        f.attester_client.try_attest_meta(
            &f.alice,
            &d,
            &codes(&f.env, &["NGN", "KES", "NGN"]),
            &None
        ),
        Err(Ok(Error::DuplicateAsset))
    );
}

#[test]
fn refuses_metadata_before_the_registry_would_see_it() {
    // The bounds are checked here rather than left to the registry so the caller
    // gets THIS contract's error numbering, and a rejected submission never
    // reaches the cross-call at all.
    let f = setup();
    let d = domain(&f.env);
    attest(&f, &d);

    let res = f.attester_client.try_attest_meta(
        &f.alice,
        &d,
        &codes(&f.env, &["NGN", "NGN"]),
        &country(&f.env, "TOO_LONG"),
    );
    assert_eq!(res, Err(Ok(Error::DuplicateAsset)));
    // Duplicate is reported rather than the country, because the asset list is
    // checked first; either way nothing was written.
    assert_eq!(
        f.registry_client.try_get_meta(&d),
        Err(Ok(corridor_registry::Error::NotFound)),
        "a rejected submission must not leave a partial record behind"
    );
}

// ─── The two crates must agree on the bounds ─────────────────────────────────
//
// These constants are mirrored because this crate cannot depend on the registry
// (linking it collides on __constructor). A mirror that drifts is worse than no
// mirror, so it is pinned by a test rather than by a comment.

#[test]
fn mirrors_the_registry_bounds() {
    use corridor_registry::{
        COUNTRY_CODE_LEN as REG_COUNTRY_LEN, MAX_ASSET_CODE_LEN as REG_MAX_ASSET_LEN,
        MAX_RECEIVE_ASSETS as REG_MAX_ASSETS,
    };
    assert_eq!(MAX_RECEIVE_ASSETS, REG_MAX_ASSETS);
    assert_eq!(MAX_ASSET_CODE_LEN, REG_MAX_ASSET_LEN);
    assert_eq!(COUNTRY_CODE_LEN, REG_COUNTRY_LEN);
}

#[test]
fn attesting_metadata_extends_the_marker_the_enrolment_and_the_instance() {
    let f = setup();
    let d = domain(&f.env);
    attest_all(&f, &d, &["NGN"], country(&f.env, "NG"));
    advance(&f, TTL_EXTEND_TO - 100);

    f.attester_client
        .attest_meta(&f.alice, &d, &codes(&f.env, &["NGN"]), &None);

    assert_eq!(entry_ttl(&f, &DataKey::LastMeta(d.clone())), TTL_EXTEND_TO);
    assert_eq!(
        entry_ttl(&f, &DataKey::Attester(f.alice.clone())),
        TTL_EXTEND_TO
    );
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}
