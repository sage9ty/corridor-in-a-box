// The one spelling of an anchor's home domain that may be attested.
//
// MIRROR of `is_canonical_domain` in `contracts/attester/src/lib.rs`. The chain
// rejects a domain that is not canonical; this rejects it before the job signs,
// simulates and pays for a transaction that would only revert. Written as the
// same label-by-label byte walk as the contract rather than a regex, so the two
// can be read against each other. Keep them in step.

/** RFC 1035 maximum hostname length, in bytes. Same bound as the contract. */
export const MAX_DOMAIN_LEN = 253;

const isLowerAlpha = (c: string): boolean => c >= "a" && c <= "z";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlnum = (c: string): boolean => isLowerAlpha(c) || isDigit(c);

/**
 * One label, `s[start..end]`: non-empty, alphanumeric at both ends, and nothing
 * but lowercase letters, digits and inner hyphens in between. An empty label — a
 * leading, trailing or doubled dot — fails on the spot.
 */
function isCanonicalLabel(s: string, start: number, end: number): boolean {
  if (start === end) return false;
  if (!isAlnum(s[start]) || !isAlnum(s[end - 1])) return false;
  for (let i = start; i < end; i++) {
    if (!isAlnum(s[i]) && s[i] !== "-") return false;
  }
  return true;
}

/**
 * Labels of lowercase ASCII letters and digits, with `-` allowed inside a label
 * but never first or last, joined by single dots. At most 253 bytes.
 *
 * A domain is a registry key, and a domain that is merely spelled differently
 * (`Cowrie.Exchange`, `cowrie.exchange.`, `https://cowrie.exchange/`) becomes a
 * second permanent record for the same anchor — one of 512 slots nobody can
 * reclaim, and two conflicting facts about one host for every reader.
 */
export function isCanonicalDomain(domain: string): boolean {
  const bytes = Buffer.byteLength(domain, "utf8");
  if (bytes === 0 || bytes > MAX_DOMAIN_LEN) return false;

  let labelStart = 0;
  for (let i = 0; i <= domain.length; i++) {
    if (i === domain.length || domain[i] === ".") {
      if (!isCanonicalLabel(domain, labelStart, i)) return false;
      labelStart = i + 1;
    }
  }
  return true;
}
