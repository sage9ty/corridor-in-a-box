// The declared country, read out of a stellar.toml.
//
// This is the DECLARED half of the registry's metadata: not a fact a probe
// verified, but a thing the anchor says about itself, which is worth recording
// precisely because it can then be compared with what the anchor does. The
// registry's rule still applies — an unverified field has to be labelled, and it
// is: it lives beside an observed asset list, and the chain stamps it with the
// ledger and the attester that read it.
//
// The machine-readable source is `[DOCUMENTATION] ORG_PHYSICAL_ADDRESS`. A
// currency is not a country — anchors serve diaspora corridors, so a toml full of
// `USD` says nothing about where the anchor is — and the free-text address line
// is the only place an anchor states it at all.
//
// Deliberately conservative. Most real anchors write a full country name there,
// some write a city and a postcode, a few write nothing. This returns a code only
// where the tail of the address maps to one without a judgement call, and
// `undefined` otherwise. `undefined` is not "this anchor has no country", it is
// "the toml did not say one in a form we can record", and on chain the two are
// different: the first would be a claim, the second is the absence of one.
//
// See the note on `tomlValue` in ./index.ts: this is not a TOML parser either. It
// tracks which table it is inside, and reads one key out of `[DOCUMENTATION]`.

/**
 * Country names, alpha-3 codes and alpha-2 codes this probe will accept, mapped
 * to ISO-3166-1 alpha-2.
 *
 * An allowlist rather than a parser, and deliberately not the whole of ISO-3166.
 * A guess about which of two similarly-named jurisdictions an anchor meant is a
 * judgement, and judgements belong in a resolver, not in an attester that writes
 * to a public record. Extend it when a corridor is worked on, not before.
 */
const TO_ALPHA2: Readonly<Record<string, string>> = Object.freeze({
  // West Africa
  nigeria: "NG",
  niger: "NE",
  ghana: "GH",
  senegal: "SN",
  "cote d'ivoire": "CI",
  "côte d'ivoire": "CI",
  ivorycoast: "CI",
  "ivory coast": "CI",
  cameroon: "CM",
  "sierra leone": "SL",
  liberia: "LR",
  "gambia, the": "GM",
  gambia: "GM",
  guinea: "GN",
  mali: "ML",
  benin: "BJ",
  burkinafaso: "BF",
  "burkina faso": "BF",
  togo: "TG",
  // East and southern Africa
  kenya: "KE",
  tanzania: "TZ",
  "united republic of tanzania": "TZ",
  uganda: "UG",
  rwanda: "RW",
  zambia: "ZM",
  zimbabwe: "ZW",
  malawi: "MW",
  mozambique: "MZ",
  "south africa": "ZA",
  botswana: "BW",
  namibia: "NA",
  "democratic republic of the congo": "CD",
  congo: "CG",
  ethiopia: "ET",
  somalia: "SO",
  sudan: "SD",
  // Americas
  mexico: "MX",
  brazil: "BR",
  argentina: "AR",
  colombia: "CO",
  peru: "PE",
  chile: "CL",
  ecuador: "EC",
  uruguay: "UY",
  paraguay: "PY",
  venezuela: "VE",
  bolivia: "BO",
  "costa rica": "CR",
  panama: "PA",
  guatemala: "GT",
  honduras: "HN",
  elsalvador: "SV",
  "el salvador": "SV",
  nicaragua: "NI",
  jamaica: "JM",
  haiti: "HT",
  "dominican republic": "DO",
  "united states": "US",
  "united states of america": "US",
  canada: "CA",
  // Asia-Pacific
  india: "IN",
  pakistan: "PK",
  bangladesh: "BD",
  philippines: "PH",
  vietnam: "VN",
  indonesia: "ID",
  thailand: "TH",
  malaysia: "MY",
  singapore: "SG",
  china: "CN",
  "people's republic of china": "CN",
  japan: "JP",
  "south korea": "KR",
  korea: "KR",
  nepal: "NP",
  srilanka: "LK",
  "sri lanka": "LK",
  myanmar: "MM",
  cambodia: "KH",
  australia: "AU",
  newzealand: "NZ",
  "new zealand": "NZ",
  // Europe, Middle East and Africa (north)
  turkey: "TR",
  ukraine: "UA",
  poland: "PL",
  romania: "RO",
  moldova: "MD",
  georgia: "GE",
  armenia: "AM",
  azerbaijan: "AZ",
  egypt: "EG",
  morocco: "MA",
  tunisia: "TN",
  algeria: "DZ",
  "united arab emirates": "AE",
  uae: "AE",
  saudi: "SA",
  "saudi arabia": "SA",
  qatar: "QA",
  kuwait: "KW",
  bahrain: "BH",
  oman: "OM",
  jordan: "JO",
  lebanon: "LB",
  iraq: "IQ",
  iran: "IR",
  israel: "IL",
  "united kingdom": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  germany: "DE",
  france: "FR",
  spain: "ES",
  portugal: "PT",
  italy: "IT",
  netherlands: "NL",
  belgium: "BE",
  austria: "AT",
  switzerland: "CH",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  ireland: "IE",
  iceland: "IS",
  czechia: "CZ",
  croatia: "HR",
  serbia: "RS",
  greece: "GR",
  cyprus: "CY",
  malta: "MT",
  luxembourg: "LU",
  lithuania: "LT",
  latvia: "LV",
  estonia: "EE",
  slovenia: "SI",
  slovakia: "SK",
  hungary: "HU",
  bulgaria: "BG",
  albania: "AL",
  northmacedonia: "MK",
  "north macedonia": "MK",
  bosnia: "BA",
  montenegro: "ME",
  russia: "RU",
  belarus: "BY",
  kazakhstan: "KZ",
  uzbekistan: "UZ",
  // United States outlying areas that anchors list as their location.
  puertorico: "PR",
  "puerto rico": "PR",
});

/**
 * Alpha-3 forms of the codes above. Built from the allowlist rather than written
 * out beside it, so a country cannot be added in one place and forgotten in the
 * other.
 *
 * Not the whole of ISO-3166-1 alpha-3 either: only codes that appear in an
 * address line for a jurisdiction this probe already recognises. `MEX`, `KEN`,
 * `PHL`, `PAK`, `BGD`, `NGA` and friends are what anchors actually write.
 */
const ALPHA3_TO_ALPHA2: Readonly<Record<string, string>> = Object.freeze({
  NGA: "NG",
  NER: "NE",
  GHA: "GH",
  SEN: "SN",
  CIV: "CI",
  CMR: "CM",
  SLE: "SL",
  LBR: "LR",
  GMB: "GM",
  GIN: "GN",
  MLI: "ML",
  BEN: "BJ",
  BFA: "BF",
  TGO: "TG",
  KEN: "KE",
  TZA: "TZ",
  UGA: "UG",
  RWA: "RW",
  ZMB: "ZM",
  ZWE: "ZW",
  MWI: "MW",
  MOZ: "MZ",
  ZAF: "ZA",
  BWA: "BW",
  NAM: "NA",
  COD: "CD",
  COG: "CG",
  ETH: "ET",
  SOM: "SO",
  SDN: "SD",
  MEX: "MX",
  BRA: "BR",
  ARG: "AR",
  COL: "CO",
  PER: "PE",
  CHL: "CL",
  ECU: "EC",
  URY: "UY",
  PRY: "PY",
  VEN: "VE",
  BOL: "BO",
  CRI: "CR",
  PAN: "PA",
  GTM: "GT",
  HND: "HN",
  SLV: "SV",
  NIC: "NI",
  JAM: "JM",
  HTI: "HT",
  DOM: "DO",
  USA: "US",
  CAN: "CA",
  IND: "IN",
  PAK: "PK",
  BGD: "BD",
  PHL: "PH",
  VNM: "VN",
  IDN: "ID",
  THA: "TH",
  MYS: "MY",
  SGP: "SG",
  CHN: "CN",
  JPN: "JP",
  KOR: "KR",
  NPL: "NP",
  LKA: "LK",
  MMR: "MM",
  KHM: "KH",
  AUS: "AU",
  NZL: "NZ",
  TUR: "TR",
  UKR: "UA",
  POL: "PL",
  ROU: "RO",
  MDA: "MD",
  GEO: "GE",
  ARM: "AM",
  AZE: "AZ",
  EGY: "EG",
  MAR: "MA",
  TUN: "TN",
  DZA: "DZ",
  ARE: "AE",
  SAU: "SA",
  QAT: "QA",
  KWT: "KW",
  BHR: "BH",
  OMN: "OM",
  JOR: "JO",
  LBN: "LB",
  IRQ: "IQ",
  IRN: "IR",
  ISR: "IL",
  GBR: "GB",
  DEU: "DE",
  FRA: "FR",
  ESP: "ES",
  PRT: "PT",
  ITA: "IT",
  NLD: "NL",
  BEL: "BE",
  AUT: "AT",
  CHE: "CH",
  SWE: "SE",
  NOR: "NO",
  DNK: "DK",
  FIN: "FI",
  IRL: "IE",
  ISL: "IS",
  CZE: "CZ",
  HRV: "HR",
  SRB: "RS",
  GRC: "GR",
  CYP: "CY",
  MLT: "MT",
  LUX: "LU",
  LTU: "LT",
  LVA: "LV",
  EST: "EE",
  SVN: "SI",
  SVK: "SK",
  HUN: "HU",
  BGR: "BG",
  ALB: "AL",
  MKD: "MK",
  BIH: "BA",
  MNE: "ME",
  RUS: "RU",
  BLR: "BY",
  KAZ: "KZ",
  UZB: "UZ",
  PRI: "PR",
});

const ALPHA2 = new Set<string>(Object.values(TO_ALPHA2));

/** The tail of an address line, as a key into the tables above. */
function normaliseTail(segment: string): string {
  return trimSpaceAndDashes(segment.replace(/[().]+/g, "")).toLowerCase();
}

/**
 * Strip whitespace and hyphens from both ends. A loop rather than `/[\s-]+$/`: that
 * pattern backtracks quadratically on a long run of whitespace that does not end the
 * string, and the input is text from an anchor's own stellar.toml.
 */
function trimSpaceAndDashes(text: string): string {
  const isEdge = (ch: string) => ch === "-" || ch.trim() === "";
  let start = 0;
  let end = text.length;
  while (start < end && isEdge(text.charAt(start))) start += 1;
  while (end > start && isEdge(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * Map one piece of an address to an ISO-3166-1 alpha-2 code, or `undefined` when
 * it is not a country this probe recognises.
 *
 * Accepts an alpha-2 code, an alpha-3 code, or a name in the allowlist. Rejects
 * anything else rather than deciding it is probably a country: a two-letter token
 * that is not a code ("Lagos, La") must not become a jurisdiction.
 */
export function toAlpha2(raw: string): string | undefined {
  const cleaned = raw.replace(/[().]+/g, "").trim();
  if (!cleaned) return undefined;

  const upper = cleaned.toUpperCase();
  if (upper.length === 2 && ALPHA2.has(upper)) return upper;
  if (upper.length === 3 && ALPHA3_TO_ALPHA2[upper]) return ALPHA3_TO_ALPHA2[upper];

  const key = normaliseTail(cleaned);
  if (key.length === 2 && ALPHA2.has(key.toUpperCase())) return key.toUpperCase();
  return TO_ALPHA2[key];
}

/**
 * Read `[DOCUMENTATION] ORG_PHYSICAL_ADDRESS` out of a stellar.toml.
 *
 * Table-aware in exactly one way, and no more: a key is only accepted at the
 * document root or inside `[DOCUMENTATION]`, so an `ORG_PHYSICAL_ADDRESS`-shaped
 * line inside a `[[CURRENCIES]]` block cannot be mistaken for the anchor's own
 * address. Same restraint as `tomlValue` — both quote styles, nothing else.
 */
function orgPhysicalAddress(toml: string): string | undefined {
  // Which table the current line sits in; undefined while at the document root.
  let table: string | undefined;
  for (const line of toml.split(/\r?\n/)) {
    const header = line.match(/^[ \t]*\[\[?[ \t]*([A-Za-z0-9_.-]+)[ \t]*\]\]?/);
    if (header) {
      table = header[1].toUpperCase();
      continue;
    }
    // SEP-1 puts this key in [DOCUMENTATION]. A root-level line is not what the
    // spec describes, but it is what a hand-written toml sometimes contains, and
    // accepting it costs nothing. Anywhere else — inside a [[CURRENCIES]] block,
    // say — the line describes that entry rather than the anchor, so it is
    // skipped rather than mistaken for the anchor's own address.
    if (table !== undefined && table !== "DOCUMENTATION") continue;
    const m = line.match(/^[ \t]*ORG_PHYSICAL_ADDRESS[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/);
    const value = (m?.[1] ?? m?.[2])?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The country an anchor declares about itself, as an ISO-3166-1 alpha-2 code.
 *
 * The last comma-separated segment of `ORG_PHYSICAL_ADDRESS` is where an address
 * puts the country, so that is the only segment consulted — a city, state or
 * postcode earlier in the line is not evidence about jurisdiction.
 */
export function declaredCountry(toml: string | undefined): string | undefined {
  if (!toml) return undefined;
  const address = orgPhysicalAddress(toml);
  if (!address) return undefined;
  const segments = address.split(",");
  return toAlpha2(segments[segments.length - 1] ?? "");
}
