import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { ExternalSigner } from "../index";

/** Fails fast unless a signer returns a valid ed25519 signature for its account. */
export async function assertSignerProducesValidSignatures(
  signer: ExternalSigner,
): Promise<void> {
  const hash = randomBytes(32);
  const signature = Buffer.from(await signer.sign(hash));
  if (signature.length !== 64) {
    throw new Error(`Signer returned ${signature.length} signature bytes; expected 64`);
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(signer.publicKey);
  } catch {
    throw new Error("Signer returned an invalid Stellar public key");
  }
  if (!keypair.verify(hash, signature)) {
    throw new Error("Signer returned a signature that does not verify for its public key");
  }
}
