# Signing-key management

The distribution account's secret seed is the most sensitive thing in a
deployment: whoever holds it can move the bridge asset. `corridor-in-a-box`
isolates all key access behind a single port so the seed never has to live in
your application process.

## The `ExternalSigner` port

```ts
interface ExternalSigner {
  readonly publicKey: string; // G…
  sign(data: Uint8Array): Promise<Uint8Array>; // 64-byte ed25519 sig over the 32-byte tx hash
}
```

Everything that needs a signature — the settlement submitter and the SEP-10
challenge signer — depends only on this interface. It is the _only_ component
that ever touches key material.

```ts
import { StellarSettlementSubmitter, StellarSep10Signer } from "@corridor/stellar";

const submitter = new StellarSettlementSubmitter({ signer: myKmsSigner, horizonUrl });
const sep10 = new StellarSep10Signer(myKmsSigner);
```

## Dev vs production

| Environment     | Signer                                                          | Where the seed lives                                    |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Local / testnet | `LocalKeypairSigner` (or pass a raw `Keypair` / `signerSecret`) | In process — acceptable only for throwaway testnet keys |
| **Production**  | A KMS/HSM-backed `ExternalSigner`                               | In the vault; never in the app, env, or repo            |

**Never** put a mainnet seed in source, a `.env` file, a container image, CI
secrets that print to logs, or anywhere it is decrypted into application memory
for longer than a single signing call.

## Implementing a KMS-backed signer

The Stellar package includes `VaultTransitSigner` for a Vault Transit key of
type `ed25519`. It reads the key's public key once during construction and
submits each 32-byte Stellar transaction hash to Transit. The seed remains in
Vault; the returned `vault:vN:` signature wrapper is decoded to the 64-byte
ed25519 signature expected by Stellar.

For the service, set `CORRIDOR_SIGNER=vault`, `VAULT_ADDR`, `VAULT_TOKEN`, and
`VAULT_TRANSIT_KEY`. The process runs `assertSignerProducesValidSignatures`
before listening so an incompatible key or signature response fails at startup.
For a local dev Vault, enable Transit and create an ed25519 key:

```sh
vault secrets enable transit
vault write -f transit/keys/corridor-signing type=ed25519
```

Vault Transit API fields and paths follow HashiCorp's
[Transit API documentation](https://developer.hashicorp.com/vault/api-docs/secret/transit):
`GET /v1/transit/keys/:name` returns key metadata and the versioned public key;
`POST /v1/transit/sign/:name` accepts base64 `input` and returns a versioned
`data.signature`.

Two details worth knowing. The signer pins the key version it read the public key
from and sends it as `key_version`, so rotating the Transit key (`vault write -f
transit/keys/<name>/rotate`) does not silently change the signing key under a running
process: signing keeps using the old version, and a response signed by another version
is rejected. Restart the service to pick up the new key (and fund/authorise its new
account first). A non-default Transit mount can be set with `VAULT_TRANSIT_MOUNT`.

A KMS/HSM that supports ed25519 (e.g. AWS KMS, GCP KMS, HashiCorp Vault Transit,
a YubiHSM) implements `ExternalSigner` by delegating `sign` to the vault:

```ts
class KmsSigner implements ExternalSigner {
  constructor(
    public readonly publicKey: string, // the G… address of the KMS-held key
    private readonly kms: MyKmsClient,
    private readonly keyId: string,
  ) {}

  async sign(data: Uint8Array): Promise<Uint8Array> {
    // The vault signs the 32-byte transaction hash; the raw seed never leaves it.
    return this.kms.signEd25519({ keyId: this.keyId, message: data });
  }
}
```

The engine builds and hashes the transaction, hands the hash to `sign`, and
attaches the returned signature — so the application only ever sees the public
key and a finished signature.

## Operational hygiene

- **Least privilege.** The distribution account should hold only the working
  float for in-flight settlements, topped up from cold storage — not the
  treasury.
- **Rotation.** Rotate the signing key on a schedule and after any suspected
  exposure. Because callers depend on `ExternalSigner`, rotation is a config
  change, not a code change.
- **Separation.** Use distinct keys per network (testnet vs public) and ideally
  per corridor risk tier.
- **Auditability.** Pair this with the engine's audit trail (every settlement is
  recorded) so each signature maps to a known payment.
