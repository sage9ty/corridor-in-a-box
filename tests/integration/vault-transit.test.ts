// Opt-in integration test against a running HashiCorp Vault Transit engine.
// Provision an ed25519 key first:
//   vault secrets enable transit
//   vault write -f transit/keys/corridor-test type=ed25519
// Then set CORRIDOR_TEST_VAULT_ADDR, CORRIDOR_TEST_VAULT_TOKEN, and
// CORRIDOR_TEST_VAULT_TRANSIT_KEY before running:
//   pnpm exec vitest run tests/integration/vault-transit.test.ts

import { describe, expect, it } from "vitest";
import { assertSignerProducesValidSignatures, VaultTransitSigner } from "@corridor/stellar";

const address = process.env.CORRIDOR_TEST_VAULT_ADDR;
const token = process.env.CORRIDOR_TEST_VAULT_TOKEN;
const keyName = process.env.CORRIDOR_TEST_VAULT_TRANSIT_KEY;
const integration = address && token && keyName ? describe : describe.skip;

integration("Vault Transit signer (live Vault)", () => {
  it("signs a Stellar hash that verifies against the Transit public key", async () => {
    const signer = await VaultTransitSigner.create({
      address: address!,
      token: token!,
      keyName: keyName!,
    });
    await expect(assertSignerProducesValidSignatures(signer)).resolves.toBeUndefined();
  });
});
