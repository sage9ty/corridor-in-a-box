import { fail, ok, type Outcome } from "@corridor/types";

type FetchLike = typeof fetch;

/**
 * Signs a SEP-10 challenge. The concrete implementation is supplied by the
 * caller, keeping this package independent of a Stellar SDK.
 */
export interface Sep10Signer {
  /** The Stellar account (G…) being authenticated. */
  readonly account: string;
  /** Sign the base64 challenge XDR and return the signed XDR. */
  signChallenge(challengeXdr: string, networkPassphrase: string): Promise<string>;
}

/** Decode a JWT's `exp` claim (epoch ms) without verifying it. */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Shared SEP-10 challenge/response client for adapter implementations. */
export class Sep10Client {
  private readonly fetchImpl: FetchLike;
  private cachedToken?: { token: string; expMs: number };

  constructor(
    private readonly webAuth: string | undefined,
    private readonly homeDomain: string,
    private readonly signer: Sep10Signer | undefined,
    fetchImpl: FetchLike = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  /**
   * Return a cached JWT or perform the SEP-10 handshake.
   *
   * No signer means anonymous access is intentional. Once a signer is
   * configured, every handshake failure is returned as a retryable error so
   * callers cannot accidentally continue unauthenticated.
   */
  async token(): Promise<Outcome<string | undefined>> {
    if (!this.webAuth || !this.signer) return ok(undefined);

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expMs - 30_000 > now) {
      return ok(this.cachedToken.token);
    }

    const authFailed = (why: string) =>
      fail("ANCHOR_UNAVAILABLE", `SEP-10 auth failed (${why})`, { retryable: true });

    try {
      const url = new URL(this.webAuth);
      url.searchParams.set("account", this.signer.account);
      url.searchParams.set("home_domain", this.homeDomain);
      const challengeRes = await this.fetchImpl(url.toString());
      if (!challengeRes.ok) return authFailed(`challenge HTTP ${challengeRes.status}`);
      const challenge = (await challengeRes.json()) as {
        transaction?: string;
        network_passphrase?: string;
      };
      if (!challenge.transaction || !challenge.network_passphrase) {
        return authFailed("challenge response missing transaction/network_passphrase");
      }

      const signed = await this.signer.signChallenge(
        challenge.transaction,
        challenge.network_passphrase,
      );
      const tokenRes = await this.fetchImpl(this.webAuth, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: signed }),
      });
      if (!tokenRes.ok) return authFailed(`token HTTP ${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token?: string };
      if (!token) return authFailed("token response missing `token`");

      this.cachedToken = { token, expMs: jwtExpiryMs(token) ?? now + 15 * 60_000 };
      return ok(token);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", "SEP-10 auth request failed", {
        retryable: true,
        cause,
      });
    }
  }
}
