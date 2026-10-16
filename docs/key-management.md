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
