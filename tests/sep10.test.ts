import { describe, expect, it, vi } from "vitest";
import { Sep10Client, type Sep10Signer } from "@corridor/adapter-kit";

const PASSPHRASE = "Test SDF Network ; September 2015";

function jwt(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expMs / 1000 })).toString("base64url");
  return `header.${payload}.signature`;
}

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

function signer(): Sep10Signer {
  return {
    account: "GSIGNER",
    signChallenge: async (challenge, networkPassphrase) => {
      expect(challenge).toBe("CHALLENGE_XDR");
      expect(networkPassphrase).toBe(PASSPHRASE);
      return "SIGNED_CHALLENGE_XDR";
    },
  };
}

describe("Sep10Client", () => {
  it("returns anonymous access when no signer is configured", async () => {
    const fetchImpl = vi.fn();
    const client = new Sep10Client(
      "https://anchor.example/auth",
      "anchor.example",
      undefined,
      fetchImpl,
    );

    const result = await client.token();

    expect(result).toEqual({ ok: true, value: undefined });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed with a retryable error when the challenge is unavailable", async () => {
    const fetchImpl = vi.fn(async () => response({}, false, 500));
    const client = new Sep10Client(
      "https://anchor.example/auth",
      "anchor.example",
      signer(),
      fetchImpl,
    );

    const result = await client.token();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches a JWT until the 30-second expiry safety window", async () => {
    const now = 1_700_000_000_000;
    const token = jwt(now + 60_000);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
      )
      .mockResolvedValueOnce(response({ token }));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const client = new Sep10Client(
      "https://anchor.example/auth",
      "anchor.example",
      signer(),
      fetchImpl,
    );

    await expect(client.token()).resolves.toEqual({ ok: true, value: token });
    await expect(client.token()).resolves.toEqual({ ok: true, value: token });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(now + 30_000);
    fetchImpl
      .mockResolvedValueOnce(
        response({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
      )
      .mockResolvedValueOnce(response({ token: "refreshed-token" }));

    await expect(client.token()).resolves.toEqual({ ok: true, value: "refreshed-token" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    nowSpy.mockRestore();
  });
});
