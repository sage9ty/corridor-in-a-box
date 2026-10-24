import { createPublicKey } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import type { ExternalSigner } from "../index";

interface VaultTransitSignerOptions {
  address: string;
  token: string;
  keyName: string;
  /** Transit secrets-engine mount path. Defaults to `transit`. */
  mount?: string;
  /** Per-request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Encode each segment of a mount path (`team/transit`) but keep the slashes. */
function encodeMount(mount: string): string {
  return mount.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

interface TransitKeyResponse {
  data?: {
    type?: unknown;
    keys?: unknown;
  };
}

interface TransitSignResponse {
  data?: {
    signature?: unknown;
  };
}

/** Signs Stellar transaction hashes with an ed25519 key held by Vault Transit. */
export class VaultTransitSigner implements ExternalSigner {
  readonly publicKey: string;

  private constructor(
    private readonly address: string,
    private readonly token: string,
    private readonly keyName: string,
    private readonly mount: string,
    private readonly keyVersion: number,
    private readonly timeoutMs: number,
    publicKey: string,
  ) {
    this.publicKey = publicKey;
  }

  static async create(options: VaultTransitSignerOptions): Promise<VaultTransitSigner> {
    let address = options.address;
    while (address.endsWith("/")) address = address.slice(0, -1);
    if (!address || !options.token || !options.keyName) {
      throw new Error("Vault address, token, and Transit key name are required");
    }

    const mount = encodeMount(options.mount ?? "transit");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = await fetch(
      `${address}/v1/${mount}/keys/${encodeURIComponent(options.keyName)}`,
      { headers: { "X-Vault-Token": options.token }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) throw new Error(`Vault Transit key lookup failed (${response.status})`);

    const body = (await response.json()) as TransitKeyResponse;
    const data = body.data;
    if (data?.type !== "ed25519" || !data.keys || typeof data.keys !== "object") {
      throw new Error("Vault Transit key must be ed25519 and include key versions");
    }

    const versions = Object.entries(data.keys as Record<string, unknown>)
      .map(([version, value]) => ({ version: Number(version), value }))
      .filter(({ version }) => Number.isSafeInteger(version) && version > 0)
      .sort((a, b) => b.version - a.version);
    const latest = versions[0]?.value;
    const keyVersion = versions[0]?.version;
    if (
      keyVersion === undefined ||
      !latest ||
      typeof latest !== "object" ||
      !("public_key" in latest)
    ) {
      throw new Error("Vault Transit key response is missing its public key");
    }
    const pem = (latest as { public_key?: unknown }).public_key;
    if (typeof pem !== "string")
      throw new Error("Vault Transit public key must be PEM encoded");

    const der = createPublicKey(pem).export({ format: "der", type: "spki" });
    const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    if (
      der.length !== ed25519SpkiPrefix.length + 32 ||
      !der.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)
    ) {
      throw new Error("Vault Transit public key is not a raw ed25519 key");
    }

    const publicKey = StrKey.encodeEd25519PublicKey(der.subarray(ed25519SpkiPrefix.length));
    return new VaultTransitSigner(
      address,
      options.token,
      options.keyName,
      mount,
      keyVersion,
      timeoutMs,
      publicKey,
    );
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    if (data.byteLength !== 32)
      throw new Error("VaultTransitSigner expects a 32-byte Stellar hash");

    // Pin the key version the public key was read from. Without `key_version`
    // Vault signs with the LATEST version, so a rotation after startup would
    // silently produce signatures from a key that is not `publicKey`.
    const response = await fetch(
      `${this.address}/v1/${this.mount}/sign/${encodeURIComponent(this.keyName)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": this.token,
        },
        body: JSON.stringify({
          input: Buffer.from(data).toString("base64"),
          key_version: this.keyVersion,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) throw new Error(`Vault Transit signing failed (${response.status})`);

    const body = (await response.json()) as TransitSignResponse;
    const signature = body.data?.signature;
    if (typeof signature !== "string") {
      throw new Error("Vault Transit response is missing its signature");
    }
    const match = /^vault:v(\d+):([A-Za-z0-9+/]+={0,2})$/.exec(signature);
    if (!match) throw new Error("Vault Transit returned a malformed versioned signature");
    if (Number(match[1]) !== this.keyVersion) {
      throw new Error(
        `Vault Transit signed with key version ${match[1]}, expected ${this.keyVersion}`,
      );
    }

    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length !== 64) throw new Error("Vault Transit returned a non-ed25519 signature");
    return bytes;
  }
}

export type { VaultTransitSignerOptions };
