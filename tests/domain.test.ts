// `isCanonicalDomain` is the TypeScript mirror of `is_canonical_domain` in
// `contracts/attester/src/lib.rs`. The chain is the authority; this is the
// early check that stops `pnpm attest` paying for a simulation that reverts.
// These spellings are the same ones `contracts/attester/src/test.rs` pins, so
// the two sides are read against each other rather than trusted to agree.

import { describe, expect, it } from "vitest";
import { MAX_DOMAIN_LEN, isCanonicalDomain } from "@corridor/probe";

describe("isCanonicalDomain", () => {
  it.each([
    "cowrie.exchange",
    "testanchor.stellar.org",
    "mint.zeam.money",
    "anchor-1.test-anchor.stellar.org",
    "a.example",
    "localhost",
    "xn--80ak6aa92e.com",
    "1.example",
  ])("accepts %s", (domain) => {
    expect(isCanonicalDomain(domain)).toBe(true);
  });

  // One anchor, three records: every one of these is `cowrie.exchange` spelled
  // another way, and the registry keys by the raw string.
  it.each([
    ["uppercase", "Cowrie.Exchange"],
    ["trailing dot", "cowrie.exchange."],
    ["leading dot", ".cowrie.exchange"],
    ["scheme", "https://cowrie.exchange/"],
    ["bare scheme prefix", "http:cowrie.exchange"],
    ["path", "cowrie.exchange/.well-known"],
    ["port", "cowrie.exchange:8000"],
    ["empty label", "cowrie..exchange"],
    ["leading hyphen", "-cowrie.exchange"],
    ["trailing hyphen", "cowrie.exchange-"],
    ["space", "cowrie exchange"],
    ["underscore", "cow_rie.exchange"],
    ["non-ascii", "cowrié.exchange"],
    ["trailing newline", "cowrie.exchange\n"],
    ["empty", ""],
  ])("rejects %s", (_label, domain) => {
    expect(isCanonicalDomain(domain)).toBe(false);
  });

  it("rejects a domain over 253 bytes", () => {
    // 253 is the RFC 1035 hostname limit the contract enforces on bytes, not
    // characters: the same spelling in punycode is what gets measured.
    const label = "a".repeat(63);
    expect(
      isCanonicalDomain(`${label}.${label}.${label}.${label}`.slice(0, MAX_DOMAIN_LEN)),
    ).toBe(true);
    expect(isCanonicalDomain(`${label}.${label}.${label}.${label}b`)).toBe(false);
  });
});
