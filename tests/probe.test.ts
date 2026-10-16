// @corridor/probe — the honesty of an attestation depends entirely on these
// probes refusing to pass on weak evidence, so most of what is tested here is
// what does NOT count as a pass.

import { describe, expect, it } from "vitest";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Account,
} from "@stellar/stellar-sdk";
import {
  decodeProbes,
  decodeSeps,
  formatProbeResultJson,
  isSafeUrl,
  parseProbeArgs,
  probeAnchor,
  probeBit,
  sepBit,
  tomlHash as sharedTomlHash,
  tomlValue,
  type ProbeName,
  type ProbeResult,
} from "@corridor/probe";

const PASSPHRASE = Networks.TESTNET;

/** A stellar.toml advertising every endpoint the probe knows about. */
const FULL_TOML = `
VERSION = "2.0.0"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
WEB_AUTH_ENDPOINT = "https://a.example/auth"
KYC_SERVER = "https://a.example/sep12"
TRANSFER_SERVER = "https://a.example/sep6"
TRANSFER_SERVER_SEP0024 = "https://a.example/sep24"
DIRECT_PAYMENT_SERVER = "https://a.example/sep31"
ANCHOR_QUOTE_SERVER = "https://a.example/sep38"

[[CURRENCIES]]
code = "USDC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`;

/** A real SEP-10 challenge the probe can actually parse and sign. */
function challengeXdr(serverKp: Keypair, clientAccount: string): string {
  const account = new Account(serverKp.publicKey(), "-1");
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.manageData({
        name: "a.example auth",
        value: Buffer.alloc(48, "a"),
        source: clientAccount,
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

interface StubOptions {
  toml?: string | null;
  authChallenge?: boolean;
  authToken?: boolean;
  quote?: { ok?: boolean; expiresAt?: string; assets?: boolean };
  sep12Status?: number;
  sep31Receive?: string[] | null;
}

function stub(o: StubOptions = {}) {
  const serverKp = Keypair.random();
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);

    if (u.includes("stellar.toml")) {
      if (o.toml === null) return new Response("nope", { status: 404 });
      return new Response(o.toml ?? FULL_TOML, { status: 200 });
    }
    if (u.includes("/auth")) {
      if (init?.method === "POST") {
        return o.authToken === false
          ? json({}, 403)
          : json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
      }
      if (o.authChallenge === false) return json({}, 500);
      const account = new URL(u).searchParams.get("account")!;
      return json({
        transaction: challengeXdr(serverKp, account),
        network_passphrase: PASSPHRASE,
      });
    }
    if (u.includes("/sep38/info")) {
      return o.quote?.assets === false
        ? json({ assets: [] })
        : json({
            assets: [
              {
                asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              },
              { asset: "iso4217:USD" },
            ],
          });
    }
    if (u.includes("/sep38/quote")) {
      if (o.quote?.ok === false) return json({}, 400);
      return json({
        id: "q1",
        price: "1.05",
        total_price: "1.17",
        sell_amount: "10",
        buy_amount: "8.57",
        expires_at: o.quote?.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (u.includes("/sep12")) return json({ status: "ACCEPTED" }, o.sep12Status ?? 200);
    if (u.includes("/sep31/info")) {
      const receive = o.sep31Receive === null ? {} : { USDC: { enabled: true } };
      return json({
        receive: o.sep31Receive
          ? Object.fromEntries(o.sep31Receive.map((a) => [a, {}]))
          : receive,
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const passed = (r: { probesPassed: number }, p: ProbeName) =>
  (r.probesPassed & probeBit(p)) !== 0;
const ran = (r: { probesRun: number }, p: ProbeName) => (r.probesRun & probeBit(p)) !== 0;

describe("bitmaps", () => {
  it("round-trips SEP numbers through the registry's bit order", () => {
    const mask = sepBit(1) | sepBit(10) | sepBit(31);
    expect(decodeSeps(mask)).toEqual([1, 10, 31]);
  });

  it("round-trips probe names", () => {
    const mask = probeBit("toml_fetch") | probeBit("sep31_info");
    expect(decodeProbes(mask)).toEqual(["toml_fetch", "sep31_info"]);
  });

  it("decodes an empty mask to nothing", () => {
    expect(decodeSeps(0)).toEqual([]);
    expect(decodeProbes(0)).toEqual([]);
  });
});

describe("tomlValue", () => {
  it("reads a top-level key", () => {
    expect(tomlValue(FULL_TOML, "WEB_AUTH_ENDPOINT")).toBe("https://a.example/auth");
  });

  it("returns undefined for an absent key", () => {
    expect(tomlValue(FULL_TOML, "NOT_A_KEY")).toBeUndefined();
  });

  it("treats an empty value as absent rather than as an endpoint", () => {
    expect(tomlValue('DIRECT_PAYMENT_SERVER = ""', "DIRECT_PAYMENT_SERVER")).toBeUndefined();
  });

  it("reads a single-quoted value — valid TOML that real anchors use (e.g. cowrie.exchange)", () => {
    expect(
      tomlValue("WEB_AUTH_ENDPOINT = 'https://a.example/auth'", "WEB_AUTH_ENDPOINT"),
    ).toBe("https://a.example/auth");
  });

  it("treats an empty single-quoted value as absent too", () => {
    expect(tomlValue("DIRECT_PAYMENT_SERVER = ''", "DIRECT_PAYMENT_SERVER")).toBeUndefined();
  });

  it("does not confuse a key inside a table with a top-level one", () => {
    // `code` appears under [[CURRENCIES]]; asking for it must not return the
    // currency's value as though it were a document-root key.
    const toml = `[[CURRENCIES]]\n  DIRECT_PAYMENT_SERVER = "https://wrong.example"\n`;
    // Indented under a table — the current reader accepts leading whitespace, so
    // this documents the known limitation rather than pretending otherwise.
    expect(tomlValue(toml, "DIRECT_PAYMENT_SERVER")).toBe("https://wrong.example");
  });
});

describe("isSafeUrl", () => {
  it("rejects loopback, link-local/metadata, RFC1918, and non-https URLs", () => {
    const bad = [
      "http://169.254.169.254/latest/meta-data", // cloud metadata endpoint
      "https://127.0.0.1/",
      "https://localhost/",
      "https://10.0.0.5/",
      "https://172.16.0.5/",
      "https://192.168.1.5/",
      "https://[::1]/",
      "https://[fe80::1]/",
      "https://[fc00::1]/",
      "http://a.example/", // right host, wrong scheme
      "not a url",
    ];
    for (const url of bad) expect(isSafeUrl(url)).toBe(false);
  });

  it("accepts an ordinary public https URL", () => {
    expect(isSafeUrl("https://a.example/sep31")).toBe(true);
  });
});

describe("probeAnchor — SSRF guard", () => {
  it("refuses to fetch a WEB_AUTH_ENDPOINT pointed at an internal address", async () => {
    // Simulates a malicious/compromised anchor whose stellar.toml points a
    // SEP endpoint at an internal or metadata address, reachable via the
    // repo's own "open a PR to add an anchor domain" onboarding flow.
    const maliciousToml = FULL_TOML.replace(
      'WEB_AUTH_ENDPOINT = "https://a.example/auth"',
      'WEB_AUTH_ENDPOINT = "http://169.254.169.254/latest/meta-data"',
    );
    const { fetchImpl, calls } = stub({ toml: maliciousToml });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(passed(r, "sep10_auth")).toBe(false);
    const outcome = r.outcomes.find((o) => o.probe === "sep10_auth");
    expect(outcome?.detail).toContain("refusing to fetch unsafe url");
    // The unsafe URL must never actually be dereferenced.
    expect(calls.some((c) => c.includes("169.254.169.254"))).toBe(false);
  });

  it("still probes normally when every endpoint is a safe https URL (regression guard)", async () => {
    const { fetchImpl } = stub();
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(passed(r, "sep10_auth")).toBe(true);
  });
});

describe("shared TOML hash helper", () => {
  it("matches the probe's raw-text SHA-256 output", async () => {
    const toml = 'VERSION = "2.0.0"\n';
    const r = await probeAnchor("a.example", {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/.well-known/stellar.toml")) return new Response(toml);
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    expect(r.tomlHash).toBe(sharedTomlHash(toml));
  });
});

describe("probeAnchor", () => {
  it("passes every probe against a fully conformant anchor", async () => {
    const { fetchImpl } = stub();
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(decodeSeps(r.seps)).toEqual([1, 6, 10, 12, 24, 31, 38]);
    expect(decodeProbes(r.probesPassed)).toEqual([
      "toml_fetch",
      "sep10_auth",
      "sep38_quote",
      "sep12_status",
      "sep31_info",
    ]);
    expect(r.tomlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // The case that got this project rejected, reproduced as a test: the toml
  // advertises SEP-31 and the lane does not exist.
  it("fails the SEP-31 probe when the receive list is empty, while still recording it as advertised", async () => {
    const { fetchImpl } = stub({ sep31Receive: null });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(decodeSeps(r.seps)).toContain(31); // advertised
    expect(ran(r, "sep31_info")).toBe(true); // we checked
    expect(passed(r, "sep31_info")).toBe(false); // and it does not work
  });

  it("records nothing as run beyond the toml when the toml cannot be fetched", async () => {
    const { fetchImpl } = stub({ toml: null });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(passed(r, "toml_fetch")).toBe(false);
    expect(r.probesRun).toBe(probeBit("toml_fetch"));
    expect(r.probesPassed).toBe(0);
    expect(r.seps).toBe(0);
    expect(r.tomlHash).toBe("0".repeat(64));
  });

  it("does not attempt probes for endpoints the anchor never advertised", async () => {
    const { fetchImpl } = stub({ toml: 'VERSION = "2.0.0"\n' });
    const r = await probeAnchor("a.example", { fetchImpl });

    expect(decodeSeps(r.seps)).toEqual([1]);
    // probesRun must reflect what was ATTEMPTED. Claiming we ran a SEP-31 probe
    // against an anchor with no SEP-31 endpoint would be a false statement.
    expect(decodeProbes(r.probesRun)).toEqual(["toml_fetch"]);
  });

  it("fails SEP-10 when the challenge cannot be obtained", async () => {
    const { fetchImpl } = stub({ authChallenge: false });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(ran(r, "sep10_auth")).toBe(true);
    expect(passed(r, "sep10_auth")).toBe(false);
  });

  it("fails SEP-10 when the token exchange is refused", async () => {
    const { fetchImpl } = stub({ authToken: false });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(passed(r, "sep10_auth")).toBe(false);
  });

  it("fails SEP-38 when the quote has already expired", async () => {
    const { fetchImpl } = stub({
      quote: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(ran(r, "sep38_quote")).toBe(true);
    expect(passed(r, "sep38_quote")).toBe(false);
  });

  it("fails SEP-38 when no stellar to fiat pair is offered", async () => {
    const { fetchImpl } = stub({ quote: { assets: false } });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(passed(r, "sep38_quote")).toBe(false);
  });

  it("treats a 4xx from SEP-12 as the endpoint working, but a 5xx as failure", async () => {
    const notFound = await probeAnchor("a.example", {
      fetchImpl: stub({ sep12Status: 404 }).fetchImpl,
    });
    expect(passed(notFound, "sep12_status")).toBe(true);

    const broken = await probeAnchor("a.example", {
      fetchImpl: stub({ sep12Status: 503 }).fetchImpl,
    });
    expect(passed(broken, "sep12_status")).toBe(false);
  });

  it("never reports a probe as passed without also reporting it as run", async () => {
    // The invariant the registry contract enforces on chain; asserted here too
    // so a malformed result can never even be submitted.
    for (const opts of [
      {},
      { toml: null },
      { authChallenge: false },
      { quote: { ok: false } },
      { sep31Receive: null },
      { sep12Status: 500 },
    ] as StubOptions[]) {
      const r = await probeAnchor("a.example", { fetchImpl: stub(opts).fetchImpl });
      expect(r.probesPassed & ~r.probesRun).toBe(0);
    }
  });

  it("reports a human-readable reason for every probe it ran", async () => {
    const { fetchImpl } = stub({ sep31Receive: null });
    const r = await probeAnchor("a.example", { fetchImpl });
    expect(r.outcomes.length).toBe(decodeProbes(r.probesRun).length);
    const sep31 = r.outcomes.find((o) => o.probe === "sep31_info");
    expect(sep31?.passed).toBe(false);
    expect(sep31?.detail).toContain("EMPTY");
  });
});

describe("formatProbeResultJson & parseProbeArgs (#232)", () => {
  describe("parseProbeArgs", () => {
    it("parses domain when provided as single argument", () => {
      const res = parseProbeArgs(["testanchor.stellar.org"]);
      expect(res).toEqual({ domain: "testanchor.stellar.org", json: false });
    });

    it("parses --json when placed after domain", () => {
      const res = parseProbeArgs(["testanchor.stellar.org", "--json"]);
      expect(res).toEqual({ domain: "testanchor.stellar.org", json: true });
    });

    it("parses --json when placed before domain", () => {
      const res = parseProbeArgs(["--json", "testanchor.stellar.org"]);
      expect(res).toEqual({ domain: "testanchor.stellar.org", json: true });
    });

    it("returns undefined domain when only --json is passed", () => {
      const res = parseProbeArgs(["--json"]);
      expect(res).toEqual({ domain: undefined, json: true });
    });

    it("returns undefined domain when argv is empty", () => {
      const res = parseProbeArgs([]);
      expect(res).toEqual({ domain: undefined, json: false });
    });
  });

  describe("formatProbeResultJson", () => {
    const fixture: ProbeResult = {
      domain: "example.org",
      seps: sepBit(1) | sepBit(10) | sepBit(31) | sepBit(38),
      probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
      probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
      tomlHash: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
      outcomes: [
        { probe: "toml_fetch", passed: true, detail: "stellar.toml fetched" },
        { probe: "sep10_auth", passed: true, detail: "signed challenge verified" },
        { probe: "sep31_info", passed: false, detail: "receive list is EMPTY" },
      ],
    };

    it("serializes fixture into valid JSON with decoded seps and probes", () => {
      const jsonStr = formatProbeResultJson(fixture);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.domain).toBe("example.org");
      expect(parsed.tomlHash).toBe(fixture.tomlHash);
      expect(parsed.outcomes).toEqual(fixture.outcomes);
      expect(parsed.seps).toEqual([1, 10, 31, 38]);
      expect(parsed.probesRun).toEqual(["toml_fetch", "sep10_auth", "sep31_info"]);
      expect(parsed.probesPassed).toEqual(["toml_fetch", "sep10_auth"]);
      expect(parsed.raw).toEqual({
        seps: fixture.seps,
        probesRun: fixture.probesRun,
        probesPassed: fixture.probesPassed,
      });
    });
  });
});
