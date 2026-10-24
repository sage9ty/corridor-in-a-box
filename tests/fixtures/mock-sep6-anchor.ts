// In-process scripted SEP-6 anchor fixture (`fetchImpl`) for unit and
// conformance tests. Serves SEP-6 `/info`, SEP-10 `/auth`, SEP-12 `/customer`,
// SEP-38 `/quote`, SEP-6 `/withdraw-exchange`, and `/transaction` with a
// configurable status progression and zero network access.

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

export interface MockSep6AnchorOptions {
  /**
   * Scripted status progression for `GET /transaction`. Each poll advances to
   * the next entry and stays on the final entry once the list is exhausted.
   * Defaults to `["pending_anchor", "completed"]`.
   */
  readonly statuses?: readonly string[];
  /** SEP-12 customer status returned by `GET /customer`. Defaults to `"ACCEPTED"`. */
  readonly kycStatus?: "ACCEPTED" | "PROCESSING" | "NEEDS_INFO" | "REJECTED";
  /** Deposit account returned by `/withdraw-exchange` and `/transaction`. */
  readonly anchorAccount?: string;
  /** Memo returned by `/withdraw-exchange` and `/transaction`. */
  readonly memo?: string;
  /** Memo type returned by `/withdraw-exchange` and `/transaction`. */
  readonly memoType?: "text" | "hash" | "id";
  /**
   * When true, `GET /withdraw-exchange` omits `account_id` from the initiation
   * response (SEP-6 >= v3.24.0 behaviour) so the adapter reads deposit
   * instructions from the follow-up `GET /transaction`.
   */
  readonly omitAccountOnInitiate?: boolean;
  /** Quote price (dest units per 1 source unit). Defaults to `"250"`. */
  readonly price?: string;
  /** Optional `refunds` object attached to the `/transaction` record. */
  readonly refunds?: Record<string, unknown>;
  /** Network passphrase reported by SEP-10 `GET /auth`. */
  readonly networkPassphrase?: string;
  /** Asset entries advertised under `withdraw` and `withdraw-exchange` in `/info`. */
  readonly assets?: readonly string[];
}

export interface MockSep6Anchor {
  readonly fetchImpl: typeof fetch;
  readonly calls: readonly RecordedCall[];
}

function makeJwt(expSecondsFromNow = 900): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  } as Response;
}

export function createMockSep6Anchor(opts: MockSep6AnchorOptions = {}): MockSep6Anchor {
  const statuses =
    opts.statuses && opts.statuses.length > 0
      ? [...opts.statuses]
      : ["pending_anchor", "completed"];
  const kycStatus = opts.kycStatus ?? "ACCEPTED";
  const anchorAccount =
    opts.anchorAccount ?? "GANCHORSEP6MOCK00000000000000000000000000000000000000000";
  const memo = opts.memo ?? "aGVsbG8=";
  const memoType = opts.memoType ?? "hash";
  const price = opts.price ?? "250";
  const passphrase = opts.networkPassphrase ?? "Test SDF Network ; September 2015";
  const assets = opts.assets ?? ["ARS", "USD"];
  const token = makeJwt(900);

  const calls: RecordedCall[] = [];
  let quoteCounter = 0;
  let txCounter = 0;

  const knownTxs = new Map<
    string,
    {
      pollIndex: number;
      amountIn: string;
      sourceAsset: string;
    }
  >();

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = input.toString();
    const parsedUrl = new URL(rawUrl);
    const pathname = parsedUrl.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: rawUrl, method, headers, body });

    // 1. SEP-10 Web Auth (`GET /auth` challenge, `POST /auth` token)
    if (pathname.endsWith("/auth")) {
      if (method === "GET") {
        return jsonResponse({
          transaction: "MOCK_SEP10_CHALLENGE_XDR",
          network_passphrase: passphrase,
        });
      }
      if (method === "POST") {
        return jsonResponse({ token });
      }
    }

    // 2. SEP-6 `GET /info`
    if (method === "GET" && pathname.endsWith("/info")) {
      const section: Record<string, unknown> = {};
      for (const code of assets) {
        section[code] = {
          enabled: true,
          authentication_required: true,
          min_amount: 1,
          max_amount: 10000,
          fee_fixed: 0,
          fee_percent: 0,
          types: {
            bank_account: {
              fields: {
                dest: { description: "Bank account number" },
                dest_extra: { description: "Routing or branch code", optional: true },
              },
            },
          },
        };
      }
      return jsonResponse({
        withdraw: section,
        "withdraw-exchange": section,
      });
    }

    // 3. SEP-12 `GET /customer`
    if (method === "GET" && pathname.endsWith("/customer")) {
      const customerId = parsedUrl.searchParams.get("id") ?? "cust-mock-1";
      return jsonResponse({
        id: customerId,
        status: kycStatus,
      });
    }

    // 4. SEP-38 `POST /quote`
    if (method === "POST" && pathname.endsWith("/quote")) {
      const reqBody = (body ?? {}) as {
        sell_amount?: string;
        sell_asset?: string;
      };
      const sellAmount = reqBody.sell_amount ?? "5.00";
      const numericSell = Number(sellAmount);
      const numericPrice = Number(price);
      const buyAmount =
        Number.isFinite(numericSell) && Number.isFinite(numericPrice)
          ? (numericSell * numericPrice).toFixed(2)
          : "1250.00";
      return jsonResponse({
        id: `q-sep6-${++quoteCounter}`,
        price,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: sellAmount,
        buy_amount: buyAmount,
      });
    }

    // 5. SEP-6 `GET /withdraw-exchange`
    if (method === "GET" && pathname.endsWith("/withdraw-exchange")) {
      const id = `tx-sep6-${++txCounter}`;
      const amountIn = parsedUrl.searchParams.get("amount") ?? "5.00";
      const sourceAsset = parsedUrl.searchParams.get("source_asset") ?? "stellar:USDC:GISSUER";
      knownTxs.set(id, {
        pollIndex: 0,
        amountIn,
        sourceAsset,
      });
      if (opts.omitAccountOnInitiate) {
        return jsonResponse({ id });
      }
      return jsonResponse({
        id,
        account_id: anchorAccount,
        memo,
        memo_type: memoType,
      });
    }

    // 6. SEP-6 `GET /transaction`
    if (method === "GET" && pathname.endsWith("/transaction")) {
      const id = parsedUrl.searchParams.get("id") ?? "";
      const record = knownTxs.get(id);
      if (!record) {
        return jsonResponse({ error: `transaction ${id} not found` }, 404);
      }
      const idx = Math.min(record.pollIndex, statuses.length - 1);
      const status = statuses[idx] ?? "completed";
      record.pollIndex += 1;
      return jsonResponse({
        transaction: {
          id,
          kind: "withdrawal-exchange",
          status,
          amount_in: record.amountIn,
          amount_in_asset: record.sourceAsset,
          withdraw_anchor_account: anchorAccount,
          withdraw_memo: memo,
          withdraw_memo_type: memoType,
          ...(opts.refunds ? { refunds: opts.refunds } : {}),
        },
      });
    }

    return jsonResponse({ error: `unhandled route ${method} ${pathname}` }, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}
