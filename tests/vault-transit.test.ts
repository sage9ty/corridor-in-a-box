import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { assertSignerProducesValidSignatures, VaultTransitSigner } from "@corridor/stellar";

function publicKeyPem(keypair: Keypair): string {
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    keypair.rawPublicKey(),
  ]).toString("base64");
  return `-----BEGIN PUBLIC KEY-----\n${der.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

async function withVaultStub(
  keypair: Keypair,
  run: (address: string, requests: string[], bodies: unknown[]) => Promise<void>,
  opts: { mount?: string; signVersion?: number } = {},
): Promise<void> {
  const mount = opts.mount ?? "transit";
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(`${request.method} ${request.url}`);
    if (request.headers["x-vault-token"] !== "test-token") {
      response.writeHead(403).end();
      return;
    }

    if (request.method === "GET" && request.url === `/v1/${mount}/keys/stellar`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            type: "ed25519",
            keys: { "1": { public_key: publicKeyPem(keypair) } },
          },
        }),
      );
      return;
    }

    if (request.method === "POST" && request.url === `/v1/${mount}/sign/stellar`) {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string };
      bodies.push(payload);
      const signature = Buffer.from(
        keypair.sign(Buffer.from(payload.input, "base64")),
      ).toString("base64");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: { signature: `vault:v${opts.signVersion ?? 1}:${signature}` },
        }),
      );
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Vault stub did not bind a TCP port");
  try {
    await run(`http://127.0.0.1:${address.port}`, requests, bodies);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("VaultTransitSigner", () => {
  it("reads the ed25519 public key and passes conformance against Transit HTTP", async () => {
    const keypair = Keypair.random();
    await withVaultStub(keypair, async (address, requests) => {
      const signer = await VaultTransitSigner.create({
        address,
        token: "test-token",
        keyName: "stellar",
      });
      expect(signer.publicKey).toBe(keypair.publicKey());
      await assertSignerProducesValidSignatures(signer);
      expect(requests).toEqual([
        "GET /v1/transit/keys/stellar",
        "POST /v1/transit/sign/stellar",
      ]);
    });
  });

  it("pins the key version it read the public key from", async () => {
    const keypair = Keypair.random();
    await withVaultStub(keypair, async (address, _requests, bodies) => {
      const signer = await VaultTransitSigner.create({
        address,
        token: "test-token",
        keyName: "stellar",
      });
      await signer.sign(new Uint8Array(32));
      expect(bodies).toEqual([expect.objectContaining({ key_version: 1 })]);
    });
  });

  it("rejects a signature from a different key version (rotation after startup)", async () => {
    const keypair = Keypair.random();
    await withVaultStub(
      keypair,
      async (address) => {
        const signer = await VaultTransitSigner.create({
          address,
          token: "test-token",
          keyName: "stellar",
        });
        await expect(signer.sign(new Uint8Array(32))).rejects.toThrow(
          /signed with key version 2, expected 1/,
        );
      },
      { signVersion: 2 },
    );
  });

  it("uses a custom Transit mount", async () => {
    const keypair = Keypair.random();
    await withVaultStub(
      keypair,
      async (address, requests) => {
        const signer = await VaultTransitSigner.create({
          address,
          token: "test-token",
          keyName: "stellar",
          mount: "team/transit",
        });
        await assertSignerProducesValidSignatures(signer);
        expect(requests).toEqual([
          "GET /v1/team/transit/keys/stellar",
          "POST /v1/team/transit/sign/stellar",
        ]);
      },
      { mount: "team/transit" },
    );
  });
});
