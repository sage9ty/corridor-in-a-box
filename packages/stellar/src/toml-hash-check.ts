import type { CheckResult, GateCheck } from "@corridor/engine";
import { isSafeUrl, tomlHash } from "@corridor/probe";
import { isUnattestedDomainAllowed, type AttestationSourceLike } from "@corridor/router";

const CHECK_NAME = "anchor.toml.hash";
const DEFAULT_TIMEOUT_MS = 15_000;
const HASH_PREFIX_LENGTH = 10;
const VALID_HASH = /^[0-9a-f]{64}$/;

export interface TomlHashCheckOptions {
  /**
   * The attestation source to read the recorded hash from. Only `tomlHash` is
   * used, so either shape of source is accepted.
   */
  readonly registry: AttestationSourceLike;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly allowUnattestedDomains?: readonly string[];
}

function result(startedAt: number, passed: boolean, detail: string): CheckResult {
  return {
    name: CHECK_NAME,
    passed,
    ...(passed ? {} : { code: "PRESETTLE_ANCHOR_DRIFT" as const }),
    detail,
    durationMs: Date.now() - startedAt,
  };
}

export function tomlHashCheck(options: TomlHashCheckOptions): GateCheck {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowUnattestedDomains = options.allowUnattestedDomains ?? [];

  return {
    name: CHECK_NAME,
    async run(ctx) {
      const startedAt = Date.now();
      const domain = ctx.corridor.dest.endpoints.home_domain;

      if (isUnattestedDomainAllowed(domain, allowUnattestedDomains)) {
        return result(startedAt, true, "unattested domain allowed");
      }

      const url = `https://${domain}/.well-known/stellar.toml`;
      if (!isSafeUrl(url)) {
        return result(startedAt, false, "stellar.toml URL rejected by safety policy");
      }

      let attestedHash: string;
      try {
        attestedHash = await options.registry.tomlHash(domain);
      } catch {
        return result(startedAt, false, "attestation hash lookup failed");
      }
      if (!VALID_HASH.test(attestedHash)) {
        return result(startedAt, false, "attestation hash is missing or invalid");
      }

      let response: Response;
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        return result(startedAt, false, "stellar.toml fetch failed");
      }
      if (!response.ok) {
        return result(startedAt, false, `stellar.toml fetch returned HTTP ${response.status}`);
      }

      let toml: string;
      try {
        toml = await response.text();
      } catch {
        return result(startedAt, false, "stellar.toml response could not be read");
      }

      const liveHash = tomlHash(toml);
      if (liveHash !== attestedHash) {
        return result(
          startedAt,
          false,
          `stellar.toml hash mismatch: attested=${attestedHash.slice(0, HASH_PREFIX_LENGTH)} live=${liveHash.slice(0, HASH_PREFIX_LENGTH)}`,
        );
      }

      return result(startedAt, true, "stellar.toml hash matches attestation");
    },
  };
}
