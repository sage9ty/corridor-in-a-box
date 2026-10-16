#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, BytesN, Env, String};

/// Bit indices, mirroring SEP_NUMBERS / PROBE_NAMES. Spelled out here rather
/// than imported so a silent reordering in lib.rs fails these tests loudly.
const SEP1: u32 = 1 << 0;
const SEP10: u32 = 1 << 2;
const SEP12: u32 = 1 << 3;
const SEP31: u32 = 1 << 5;
const SEP38: u32 = 1 << 6;
const PROBE_TOML: u32 = 1 << 0;
const PROBE_SEP31_INFO: u32 = 1 << 4;

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
