// The declared country is the only field in the registry that nobody verified,
// so the interesting property of this parser is what it REFUSES to invent. A
// wrong code on chain is a claim about a jurisdiction; a missing one is the
// absence of a claim, and the two have to stay distinguishable.

import { describe, expect, it } from "vitest";
import { declaredCountry, probeAnchor, toAlpha2 } from "@corridor/probe";

/** A stellar.toml whose only content is a DOCUMENTATION address line. */
const tomlWithAddress = (address: string, quote = '"') =>
  `[DOCUMENTATION]\nCORDA_HOST = "example"\nORG_PHYSICAL_ADDRESS = ${quote}${address}${quote}\n`;

describe("declaredCountry", () => {
  it("reads a country name from the tail of the address", () => {
    expect(declaredCountry(tomlWithAddress("12 Marina Way, Ikeja, Lagos, Nigeria"))).toBe(
      "NG",
    );
    expect(declaredCountry(tomlWithAddress("4th Floor, Ridge, Accra, Ghana"))).toBe("GH");
  });

  it("accepts either quote style", () => {
    expect(declaredCountry(tomlWithAddress("Yaba, Lagos, Nigeria", "'"))).toBe("NG");
  });

  it("accepts alpha-3 and alpha-2 tails, which is what anchors actually write", () => {
    expect(declaredCountry(tomlWithAddress("Plot 4, Wuse II, Abuja, NGA"))).toBe("NG");
    expect(declaredCountry(tomlWithAddress("142 Herbert Macaulay St, Yaba, NG"))).toBe("NG");
  });

  it("keeps accented and unaccented spellings equivalent", () => {
    expect(declaredCountry(tomlWithAddress("Rue des Jardins, Abidjan, Côte d'Ivoire"))).toBe(
      "CI",
    );
    expect(declaredCountry(tomlWithAddress("Rue des Jardins, Abidjan, Cote d'Ivoire"))).toBe(
      "CI",
    );
  });

  it("drops punctuation around a code", () => {
    expect(declaredCountry(tomlWithAddress("1 Westend Avenue, Ikoyi, (Nigeria)"))).toBe("NG");
    expect(
      declaredCountry(tomlWithAddress("Ridgeland, Hillcrest, Durban, South Africa.")),
    ).toBe("ZA");
  });

  it("returns nothing rather than guessing when the tail is not a country", () => {
    // A city, a state abbreviation and a postcode are all plausible last
    // segments, and none of them is a jurisdiction the anchor named.
    expect(
      declaredCountry(tomlWithAddress("142 Herbert Macaulay Street, Yaba")),
    ).toBeUndefined();
    expect(
      declaredCountry(tomlWithAddress("Broadway House, Togogo Terrace, Oxford OX4 1EG")),
    ).toBeUndefined();
    expect(declaredCountry(tomlWithAddress("350 Fifth Avenue, New York, NY"))).toBeUndefined();
    expect(declaredCountry(tomlWithAddress("Lagos, La"))).toBeUndefined();
  });

  it("says nothing when the toml says nothing", () => {
    expect(declaredCountry(undefined)).toBeUndefined();
    expect(declaredCountry('VERSION = "2.0.0"\n')).toBeUndefined();
    expect(declaredCountry('[DOCUMENTATION]\nORG_NAME = "Acme"\n')).toBeUndefined();
  });

  it("ignores an address inside a currency block", () => {
    // [[CURRENCIES]] entries can carry their own fields; reading one as the
    // anchor's location would attribute a naira asset's issuer to the anchor's
    // home country whether the anchor said so or not.
    const toml = `VERSION = "2.0.0"\n\n[[CURRENCIES]]\ncode = "NGN"\nORG_PHYSICAL_ADDRESS = "Lagos, Nigeria"\n`;
    expect(declaredCountry(toml)).toBeUndefined();
  });

  it("reads a root-level address that SEP-1 does not describe", () => {
    expect(declaredCountry('ORG_PHYSICAL_ADDRESS = "Lagos, Nigeria"\n')).toBe("NG");
  });
});

describe("toAlpha2", () => {
  it("recognises the forms an address line uses", () => {
    expect(toAlpha2("Nigeria")).toBe("NG");
    expect(toAlpha2("NGA")).toBe("NG");
    expect(toAlpha2("ng")).toBe("NG");
    expect(toAlpha2(" Philippines ")).toBe("PH");
  });

  it("will not turn an arbitrary token into a country", () => {
    expect(toAlpha2("")).toBeUndefined();
    expect(toAlpha2("Lagos")).toBeUndefined();
    expect(toAlpha2("XYZ")).toBeUndefined();
    expect(toAlpha2("Nigeria, Ghana")).toBeUndefined();
  });
});

describe("probeAnchor carries the declared country", () => {
  const fetchToml = (toml: string) =>
    (async () => ({
      ok: true,
      status: 200,
      text: async () => toml,
    })) as unknown as typeof fetch;

  it("records it when the toml declares one", async () => {
    const result = await probeAnchor("a.example", {
      fetchImpl: fetchToml(tomlWithAddress("Lagos, Nigeria")),
    });
    expect(result.country).toBe("NG");
  });

  it("omits the key entirely when it does not", async () => {
    const result = await probeAnchor("a.example", {
      fetchImpl: fetchToml('VERSION = "2.0.0"\n'),
    });
    expect("country" in result).toBe(false);
  });
});
