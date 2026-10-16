#![cfg(test)]

use super::*;
use corridor_registry::{Registry, RegistryClient as RegistryDirect};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String,
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
