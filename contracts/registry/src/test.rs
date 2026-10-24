#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::storage::{Instance as _, Persistent as _},
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, Event as _, String, Vec,
};

/// Bit indices, mirroring SEP_NUMBERS / PROBE_NAMES. Spelled out here rather
/// than imported so a silent reordering in lib.rs fails these tests loudly.
const SEP1: u32 = 1 << 0;
const SEP6: u32 = 1 << 1;
const SEP10: u32 = 1 << 2;
const SEP12: u32 = 1 << 3;
const SEP31: u32 = 1 << 5;
const SEP38: u32 = 1 << 6;
const PROBE_TOML: u32 = 1 << 0;
const PROBE_SEP31_INFO: u32 = 1 << 4;
const PROBE_SEP6_INFO: u32 = 1 << 5;
const PROBE_SEP6_AUTH: u32 = 1 << 6;

struct Fixture {
    env: Env,
    client: RegistryClient<'static>,
    admin: Address,
    attester: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let id = env.register(Registry, (admin.clone(), attester.clone()));
    let client = RegistryClient::new(&env, &id);
    Fixture {
        env,
        client,
        admin,
        attester,
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn domain(env: &Env) -> String {
    String::from_str(env, "testanchor.stellar.org")
}

#[test]
fn stores_and_reads_back_an_attestation() {
    let f = setup();
    let d = domain(&f.env);
    f.client.put_anchor(
        &d,
        &(SEP1 | SEP10 | SEP12 | SEP31 | SEP38),
        &hash(&f.env, 0xab),
        &(PROBE_TOML | PROBE_SEP31_INFO),
        &(PROBE_TOML | PROBE_SEP31_INFO),
        &f.attester,
    );

    let r = f.client.get_anchor(&d);
    assert_eq!(r.domain, d);
    assert_eq!(r.toml_hash, hash(&f.env, 0xab));
    assert_eq!(r.attester, f.attester);
    assert_eq!(f.client.domains().len(), 1);
}

#[test]
fn decodes_the_sep_bitmap_so_callers_never_see_it() {
    let f = setup();
    let d = domain(&f.env);
    f.client.put_anchor(
        &d,
        &(SEP10 | SEP31 | SEP38),
        &hash(&f.env, 1),
        &0,
        &0,
        &f.attester,
    );

    let seps = f.client.seps_for(&d);
    assert_eq!(seps.len(), 3);
    assert_eq!(seps.get(0).unwrap(), 10);
    assert_eq!(seps.get(1).unwrap(), 31);
    assert_eq!(seps.get(2).unwrap(), 38);
}

#[test]
fn re_attesting_updates_in_place_without_duplicating_the_domain() {
    let f = setup();
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    f.client
        .put_anchor(&d, &(SEP31 | SEP38), &hash(&f.env, 2), &0, &0, &f.attester);

    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.get_anchor(&d).toml_hash, hash(&f.env, 2));
}

// --- the staleness contract ---------------------------------------------
// An attestation is never "wrong", only old. These two tests are the reason
// attested_ledger exists at all.

#[test]
fn records_the_ledger_it_was_attested_at() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert_eq!(f.client.attested_at(&d), 1_000);
}

#[test]
fn staleness_grows_with_the_ledger() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert_eq!(f.client.staleness(&d), 0);

    f.env.ledger().set_sequence_number(401_000);
    assert_eq!(f.client.staleness(&d), 400_000);
}

// --- validation: the registry does not store whatever it is handed ---------

#[test]
fn rejects_a_probe_claimed_passed_without_being_run() {
    let f = setup();
    let d = domain(&f.env);
    let res = f.client.try_put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_TOML,                      // ran only the toml probe
        &(PROBE_TOML | PROBE_SEP31_INFO), // but claims two passed
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::PassedExceedsRun)));
}

#[test]
fn rejects_bits_outside_the_defined_range() {
    let f = setup();
    let d = domain(&f.env);
    let undefined_sep_bit = 1u32 << 20;
    let res = f.client.try_put_anchor(
        &d,
        &undefined_sep_bit,
        &hash(&f.env, 1),
        &0,
        &0,
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::UnknownBit)));

    let undefined_probe_bit = 1u32 << 20;
    let res = f.client.try_put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &undefined_probe_bit,
        &0,
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::UnknownBit)));

    // Bit 7 is index 7 (the 8th bit), which is currently undefined for PROBE_NAMES.
    let bit_7 = 1u32 << 7;
    let res = f
        .client
        .try_put_anchor(&d, &SEP31, &hash(&f.env, 1), &bit_7, &0, &f.attester);
    assert_eq!(res, Err(Ok(Error::UnknownBit)));
}

#[test]
fn unknown_domain_is_not_found_rather_than_a_default() {
    let f = setup();
    let res = f
        .client
        .try_get_anchor(&String::from_str(&f.env, "nope.example"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// --- the question operators actually ask ----------------------------------

#[test]
fn serves_sep31_requires_both_advertised_and_probed() {
    let f = setup();
    let d = domain(&f.env);

    // Advertises SEP-31 but the probe was never run: not a yes.
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert!(!f.client.serves_sep31(&d));

    // Probe ran and failed: still not a yes.
    f.client.put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &0,
        &f.attester,
    );
    assert!(!f.client.serves_sep31(&d));

    // Advertised and probed green.
    f.client.put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
    assert!(f.client.serves_sep31(&d));

    // Probed green but no longer advertised: not a yes either.
    f.client.put_anchor(
        &d,
        &SEP10,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
    assert!(!f.client.serves_sep31(&d));

    // Generic serves helper agrees
    assert!(!f.client.serves(&d, &10));
    assert!(!f.client.serves(&d, &999));
}

#[test]
fn serves_sep6_requires_both_advertised_and_probed() {
    let f = setup();
    let d = domain(&f.env);

    // Advertises SEP-6 but the probe was never run: not a yes.
    f.client
        .put_anchor(&d, &SEP6, &hash(&f.env, 1), &0, &0, &f.attester);
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));

    // Probe ran and failed: still not a yes.
    f.client.put_anchor(
        &d,
        &SEP6,
        &hash(&f.env, 1),
        &PROBE_SEP6_INFO,
        &0,
        &f.attester,
    );
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));

    // Advertised and probed green (sep6_info).
    f.client.put_anchor(
        &d,
        &SEP6,
        &hash(&f.env, 1),
        &(PROBE_SEP6_INFO | PROBE_SEP6_AUTH),
        &PROBE_SEP6_INFO,
        &f.attester,
    );
    assert!(f.client.serves_sep6(&d));
    assert!(f.client.serves(&d, &6));

    // Probed green but no longer advertised: not a yes either.
    f.client.put_anchor(
        &d,
        &SEP1,
        &hash(&f.env, 1),
        &PROBE_SEP6_INFO,
        &PROBE_SEP6_INFO,
        &f.attester,
    );
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));
}

#[test]
fn old_layout_record_still_answers_serves_sep31_correctly() {
    let f = setup();
    let d = domain(&f.env);

    // Simulate an old-layout record written when PROBE_NAMES only had 5 bits (0..=4).
    // It advertises SEP-31 and passed PROBE_TOML and PROBE_SEP31_INFO, but bits 5 and 6 (sep6) are 0.
    let old_probes_run = PROBE_TOML | PROBE_SEP31_INFO;
    let old_probes_passed = PROBE_TOML | PROBE_SEP31_INFO;
    f.client.put_anchor(
        &d,
        &(SEP1 | SEP31),
        &hash(&f.env, 1),
        &old_probes_run,
        &old_probes_passed,
        &f.attester,
    );

    // serves_sep31 and serves(31) should answer true
    assert!(f.client.serves_sep31(&d));
    assert!(f.client.serves(&d, &31));

    // serves_sep6 must be false for old records until re-attested
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));
}

// --- admin ---------------------------------------------------------------

#[test]
fn admin_can_rotate_the_attester() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.client.set_attester(&next);
    assert_eq!(f.client.attester(), next);
    assert_eq!(f.client.admin(), f.admin);
}

/// Property-ish: every subset of the defined SEP bits round-trips through the
/// bitmap and back out of seps_for() with no loss and in ascending order.
#[test]
fn every_sep_combination_round_trips() {
    let f = setup();
    let d = domain(&f.env);
    let n = SEP_NUMBERS.len();

    for mask in 0u32..(1u32 << n) {
        f.client
            .put_anchor(&d, &mask, &hash(&f.env, 1), &0, &0, &f.attester);
        let got = f.client.seps_for(&d);

        let mut expected_len = 0u32;
        let mut previous = 0u32;
        for (i, sep) in SEP_NUMBERS.iter().enumerate() {
            if mask & (1u32 << i) != 0 {
                let actual = got.get(expected_len).unwrap();
                assert_eq!(
                    actual, *sep,
                    "mask {mask}: wrong sep at index {expected_len}"
                );
                assert!(actual > previous, "mask {mask}: not ascending");
                previous = actual;
                expected_len += 1;
            }
        }
        assert_eq!(got.len(), expected_len, "mask {mask}: wrong count");
    }
}

// ─── Storage lifetime ────────────────────────────────────────────────────────
//
// Soroban entries expire and are archived after their TTL. The unit-test
// environment does NOT archive: an entry past its `live_until` is still readable
// there, so reading a record back after advancing the ledger proves nothing.
// These tests assert the lifetime itself (`get_ttl`, ledgers left until expiry),
// advancing the ledger the way a quiet network would, and read the record back
// only as a sanity check on top.

/// The test environment's default minimum persistent TTL: what an entry that
/// nobody extended is given. Spelled out so a lifetime measured against it
/// cannot pass merely because the default changed.
const DEFAULT_TTL: u32 = 4_096;

fn advance(f: &Fixture, ledgers: u32) {
    f.env.ledger().with_mut(|l| l.sequence_number += ledgers);
}

fn put(f: &Fixture, d: &String) {
    f.client.put_anchor(
        d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
}

fn record_ttl(f: &Fixture, d: &String) -> u32 {
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Anchor(d.clone()))
    })
}

fn instance_ttl(f: &Fixture) -> u32 {
    f.env
        .as_contract(&f.client.address, || f.env.storage().instance().get_ttl())
}

#[test]
fn a_write_extends_the_record_and_the_instance() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn a_record_outlives_the_default_ttl_by_a_wide_margin() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    advance(&f, DEFAULT_TTL + 1);

    // Past the point a bare `set` would have expired, the record and the
    // instance still have the rest of their extension to run.
    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - DEFAULT_TTL - 1);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO - DEFAULT_TTL - 1);
    // The list, the admin and the attester are all instance storage, and losing
    // it takes every read offline.
    assert_eq!(f.client.get_anchor(&d).domain, d);
    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.admin(), f.admin);
    assert_eq!(f.client.attester(), f.attester);
}

#[test]
fn a_bare_set_gets_only_the_default_ttl() {
    // What the contract used to do, measured: an entry written with a plain `set`
    // lives for the default TTL and no longer, which is the lifetime every
    // assertion above is an improvement on.
    let f = setup();
    let d = domain(&f.env);
    let record = AnchorRecord {
        domain: d.clone(),
        seps: SEP31,
        toml_hash: hash(&f.env, 1),
        probes_run: PROBE_SEP31_INFO,
        probes_passed: PROBE_SEP31_INFO,
        attested_ledger: f.env.ledger().sequence(),
        attester: f.attester.clone(),
    };
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Anchor(d.clone()), &record);
    });

    // The default counts the ledger the entry was created in, hence the one fewer.
    assert_eq!(record_ttl(&f, &d), DEFAULT_TTL - 1);
}

#[test]
fn bump_keeps_a_record_alive_without_re_attesting_it() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    put(&f, &d);
    let attested = f.client.attested_at(&d);

    // Nearly at the end of the lifetime a write bought, with nobody re-attesting.
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(record_ttl(&f, &d), 100);

    f.client.bump(&d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    // A thousand ledgers on, past the point the original extension would have
    // run out, it still has nearly the full lifetime left, and it is still exactly
    // as old as it was: a bump is not an attestation.
    advance(&f, 1_000);
    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - 1_000);
    assert_eq!(f.client.get_anchor(&d).domain, d);
    assert_eq!(f.client.attested_at(&d), attested);
    assert_eq!(f.client.staleness(&d), TTL_EXTEND_TO - 100 + 1_000);
}

#[test]
fn without_a_bump_the_lifetime_just_runs_down() {
    // What a bump saves a record from: nothing refreshes the lifetime by itself,
    // and reads do not extend it.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    advance(&f, TTL_EXTEND_TO - 1);
    let _ = f.client.get_anchor(&d);
    let _ = f.client.staleness(&d);

    assert_eq!(record_ttl(&f, &d), 1);
}

#[test]
fn bump_extends_the_instance_too() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(instance_ttl(&f), 100);

    f.client.bump(&d);

    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
    advance(&f, 1_000);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO - 1_000);
    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn bump_needs_no_authorisation() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    f.client.bump(&d);

    // `mock_all_auths` records every authorisation a call asked for; a
    // permissionless call asks for none.
    assert!(f.env.auths().is_empty());
}

#[test]
fn bumping_an_unknown_domain_is_not_found() {
    let f = setup();
    let d = String::from_str(&f.env, "never-attested.example");

    assert_eq!(f.client.try_bump(&d), Err(Ok(Error::NotFound)));
}

#[test]
fn a_write_inside_the_threshold_does_not_pay_for_another_extension() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    // A day later the record still has far more than the threshold left, so a
    // re-attestation leaves its lifetime alone rather than re-buying it.
    advance(&f, LEDGERS_PER_DAY);
    put(&f, &d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - LEDGERS_PER_DAY);
}

#[test]
fn rotating_the_attester_extends_the_instance() {
    let f = setup();
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(instance_ttl(&f), 100);

    f.client.set_attester(&Address::generate(&f.env));

    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn emits_full_attested_event_payload() {
    let f = setup();
    f.env.ledger().set_sequence_number(4_242);
    let d = domain(&f.env);
    let seps = SEP1 | SEP10 | SEP12 | SEP31 | SEP38;
    let probes_run = PROBE_TOML | PROBE_SEP31_INFO;
    let probes_passed = PROBE_TOML;
    let toml_hash = hash(&f.env, 0xcd);

    f.client.put_anchor(
        &d,
        &seps,
        &toml_hash,
        &probes_run,
        &probes_passed,
        &f.attester,
    );

    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected = Attested {
        domain: d,
        seps,
        toml_hash,
        probes_run,
        probes_passed,
        attested_ledger: 4_242,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected);
}

// ─── Metadata: observed receive assets, declared country ─────────────────────
//
// The two halves of a domain's record are written and read separately, and the
// tests below are the ones that matter most for the upgrade: an anchor record
// that predates metadata must stay readable, untouched, and must not silently
// gain an empty list that a consumer would read as "receives nothing".

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

/// Thirty-three distinct codes: enough to sit on both sides of
/// `MAX_RECEIVE_ASSETS` without tripping the duplicate check first.
const ASSET_NAMES: [&str; 33] = [
    "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "B0", "B1", "B2", "B3", "B4", "B5",
    "B6", "B7", "B8", "B9", "C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "D0", "D1",
    "D2",
];

/// An asset code exactly `MAX_ASSET_CODE_LEN` long, and one byte past it.
/// Written out rather than built so the length they assert is the length here.
const AT_LIMIT_CODE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const OVER_LIMIT_CODE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";

/// Attest the record, then write metadata on top of it — the order a sweep
/// submits in.
fn put_meta(f: &Fixture, d: &String, list: &[&str], c: Option<String>) {
    f.client.put_meta(d, &codes(&f.env, list), &c, &f.attester);
}

#[test]
fn stores_and_reads_back_metadata() {
    let f = setup();
    f.env.ledger().set_sequence_number(2_000);
    let d = domain(&f.env);
    put(&f, &d);

    put_meta(&f, &d, &["NGN", "KES"], country(&f.env, "NG"));

    let meta = f.client.get_meta(&d);
    assert_eq!(meta.domain, d);
    assert_eq!(meta.receive_assets, codes(&f.env, &["NGN", "KES"]));
    assert_eq!(meta.country, country(&f.env, "NG"));
    assert_eq!(meta.attested_ledger, 2_000);
    assert_eq!(meta.attester, f.attester);
}

#[test]
fn a_metadata_write_leaves_the_record_it_describes_alone() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    put(&f, &d);
    let before = f.client.get_anchor(&d);

    f.env.ledger().set_sequence_number(5_000);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));

    // Same bits, same toml hash, same attested ledger: metadata is a second key,
    // not a rewrite of the first. The two clocks stay distinguishable.
    let after = f.client.get_anchor(&d);
    assert_eq!(after, before);
    assert_eq!(after.attested_ledger, 1_000);
    assert_eq!(f.client.get_meta(&d).attested_ledger, 5_000);
    assert_eq!(f.client.staleness(&d), 4_000);
}

#[test]
fn re_attesting_the_record_does_not_erase_metadata() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN", "XOF"], country(&f.env, "NG"));

    put(&f, &d);

    assert_eq!(
        f.client.get_meta(&d).receive_assets,
        codes(&f.env, &["NGN", "XOF"])
    );
}

#[test]
fn a_record_with_no_metadata_reads_not_found_rather_than_empty() {
    // The pre-upgrade case: a record written by the previous version of this
    // contract. It must read exactly as it did before, and its absence of
    // metadata must not be reported as an anchor that receives nothing.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    let record = f.client.get_anchor(&d);
    assert_eq!(record.domain, d);
    assert!(f.client.serves_sep31(&d));

    assert_eq!(f.client.try_get_meta(&d), Err(Ok(Error::NotFound)));
    assert_eq!(
        f.client
            .try_receives_asset(&d, &String::from_str(&f.env, "NGN")),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn metadata_about_an_unattested_domain_is_refused() {
    let f = setup();
    let d = String::from_str(&f.env, "never-attested.example");

    let res = f.client.try_put_meta(
        &d,
        &codes(&f.env, &["NGN"]),
        &country(&f.env, "NG"),
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn receives_asset_answers_from_the_observed_list() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN", "KES"], country(&f.env, "NG"));

    assert!(f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "NGN")));
    // Not a substring, not a prefix, not a currency of the declared country.
    assert!(!f.client.receives_asset(&d, &String::from_str(&f.env, "NG")));
    assert!(!f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "USDC")));
}

#[test]
fn an_empty_receive_list_is_a_finding_not_an_absence() {
    // testanchor.stellar.org: advertises SEP-31, `/info` lists nothing. That is
    // the fact the registry exists to record, so it has to be storable.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    put_meta(&f, &d, &[], None);

    let meta = f.client.get_meta(&d);
    assert_eq!(meta.receive_assets.len(), 0);
    assert_eq!(meta.country, None);
    assert!(!f
        .client
        .receives_asset(&d, &String::from_str(&f.env, "NGN")));
}

#[test]
fn declares_no_country_without_inventing_one() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    put_meta(&f, &d, &["NGN"], None);
    assert_eq!(f.client.get_meta(&d).country, None);

    // A later sweep that does read a declaration replaces the absence.
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));
    assert_eq!(f.client.get_meta(&d).country, country(&f.env, "NG"));

    // And clearing a declaration that has gone away is expressible too.
    put_meta(&f, &d, &["NGN"], None);
    assert_eq!(f.client.get_meta(&d).country, None);
}

// --- bounds: the registry does not store whatever it is handed ---------------

#[test]
fn rejects_more_assets_than_the_bound_allows() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    // Exactly at the bound is accepted — the limit is a ceiling, not an
    // off-by-one trap for an honest writer.
    f.client
        .put_meta(&d, &codes(&f.env, &ASSET_NAMES[..32]), &None, &f.attester);
    assert_eq!(
        f.client.get_meta(&d).receive_assets.len(),
        MAX_RECEIVE_ASSETS
    );

    // One past it is refused.
    let res = f
        .client
        .try_put_meta(&d, &codes(&f.env, &ASSET_NAMES), &None, &f.attester);
    assert_eq!(res, Err(Ok(Error::TooManyAssets)));
}

#[test]
fn rejects_an_asset_code_that_is_not_a_code() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    assert_eq!(
        f.client
            .try_put_meta(&d, &codes(&f.env, &[""]), &None, &f.attester),
        Err(Ok(Error::InvalidAssetCode))
    );

    assert_eq!(
        f.client
            .try_put_meta(&d, &codes(&f.env, &[OVER_LIMIT_CODE]), &None, &f.attester),
        Err(Ok(Error::InvalidAssetCode))
    );

    // At the bound, accepted.
    f.client
        .put_meta(&d, &codes(&f.env, &[AT_LIMIT_CODE]), &None, &f.attester);
}

#[test]
fn rejects_the_same_asset_written_twice() {
    // len() is a count of assets an anchor receives; a list with a duplicate in
    // it would make that number a lie.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    assert_eq!(
        f.client.try_put_meta(
            &d,
            &codes(&f.env, &["NGN", "KES", "ngn"]),
            &None,
            &f.attester
        ),
        Ok(Ok(()))
    );
    assert_eq!(
        f.client.try_put_meta(
            &d,
            &codes(&f.env, &["NGN", "KES", "NGN"]),
            &None,
            &f.attester
        ),
        Err(Ok(Error::DuplicateAsset))
    );
}

#[test]
fn rejects_a_country_that_is_not_alpha2() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    for bad in ["ng", "NGA", "N", "", "N1"] {
        let res = f.client.try_put_meta(
            &d,
            &codes(&f.env, &["NGN"]),
            &country(&f.env, bad),
            &f.attester,
        );
        assert_eq!(res, Err(Ok(Error::InvalidCountry)), "accepted {bad:?}");
    }

    f.client
        .put_meta(&d, &codes(&f.env, &["NGN"]), &None, &f.attester);
}

#[test]
fn emits_its_own_event_for_metadata() {
    let f = setup();
    f.env.ledger().set_sequence_number(7_777);
    let d = domain(&f.env);

    let seps = SEP31;
    let probes = PROBE_SEP31_INFO;
    let toml_hash = hash(&f.env, 1);
    f.client
        .put_anchor(&d, &seps, &toml_hash, &probes, &probes, &f.attester);

    // The unit-test host reports the events of the invocation that just ran, so
    // each write is read back on its own. What is pinned is that a metadata
    // write publishes `meta_attested` and nothing else — it neither rides on the
    // bitmap event nor replaces it, which is what lets an indexer follow a sweep
    // that writes the two halves in one ledger.
    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected_attested = Attested {
        domain: d.clone(),
        seps,
        toml_hash,
        probes_run: probes,
        probes_passed: probes,
        attested_ledger: 7_777,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected_attested);

    let list = codes(&f.env, &["NGN"]);
    let c = country(&f.env, "NG");
    f.client.put_meta(&d, &list, &c, &f.attester);

    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected_meta = MetaAttested {
        domain: d,
        receive_assets: list,
        country: c,
        attested_ledger: 7_777,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected_meta);
}

#[test]
fn a_metadata_write_extends_the_metadata_entry() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));

    let meta_ttl = f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Meta(d.clone()))
    });
    assert_eq!(meta_ttl, TTL_EXTEND_TO);
}

#[test]
fn bump_keeps_metadata_alive_alongside_the_record() {
    // Metadata expires on its own key. If bump only extended the record, a quiet
    // domain would answer get_anchor forever while get_meta archived away — a
    // record that slowly loses half its facts.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    put_meta(&f, &d, &["NGN"], country(&f.env, "NG"));

    advance(&f, TTL_EXTEND_TO - 100);
    f.client.bump(&d);

    let (record_ttl, meta_ttl) = f.env.as_contract(&f.client.address, || {
        (
            f.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Anchor(d.clone())),
            f.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Meta(d.clone())),
        )
    });
    assert_eq!(record_ttl, TTL_EXTEND_TO);
    assert_eq!(meta_ttl, TTL_EXTEND_TO);
}
