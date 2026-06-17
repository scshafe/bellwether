import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool } from "pg";

import {
  ingestAlpacaNewsConnectionOnce,
  normalizeAlpacaNewsEvent,
  runAlpacaNewsIngestStream,
  type AlpacaNewsSocketFactory
} from "./alpaca-news.js";
import { ALPACA_PAPER_BROKER_ACCOUNT_ID } from "./broker.js";
import {
  ALPACA_NEWS_SOURCE_ID,
  ensureAlpacaNewsSource,
  InMemoryQualitativeItemsStore,
  type QualitativeItem,
  type QualitativeItemInput,
  type QualitativeItemsStore,
  type SourceRow
} from "./qualitative.js";
import type { BrokerCredential, BrokerCredentialVault } from "./secrets.js";

describe("Alpaca News websocket ingest", () => {
  it("authenticates with the reused alpaca-paper credential and dedups redelivered news", async () => {
    const controller = new AbortController();
    const sentFrames: unknown[] = [];
    const itemsStore = new RecordingItemsStore();
    const credential: BrokerCredential = { keyId: "paper-key", secretKey: "paper-secret" };
    const socketFactory: AlpacaNewsSocketFactory = async () => ({
      async send(message) {
        sentFrames.push(JSON.parse(message) as unknown);
      },
      messages: (async function* () {
        yield [newsEvent(), newsEvent()];
        controller.abort();
      })(),
      close() {}
    });
    const vault = new RecordingBrokerCredentialVault(credential);

    await runAlpacaNewsIngestStream({
      credentialVault: vault,
      itemsStore,
      socketFactory,
      signal: controller.signal,
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 2
    });
    const recent = await itemsStore.listRecentItems({ ticker: "AAPL" });

    assert.deepEqual(vault.requests, [ALPACA_PAPER_BROKER_ACCOUNT_ID]);
    assert.deepEqual(sentFrames, [
      { action: "auth", key: "paper-key", secret: "paper-secret" },
      { action: "subscribe", news: ["*"] }
    ]);
    assert.equal(itemsStore.results.length, 2);
    assert.ok(itemsStore.results[0]);
    assert.equal(itemsStore.results[1], null);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.sourceId, ALPACA_NEWS_SOURCE_ID);
    assert.equal(recent[0]?.sourceItemId, "24918784");
    assert.equal(recent[0]?.title, "AAPL rallies as MSFT holds support");
    assert.equal(recent[0]?.link, "https://www.benzinga.com/news/26/06/24918784/aapl-rallies");
    assert.equal(recent[0]?.publishedAt, "2026-06-17T12:30:00.000Z");
    assert.deepEqual(recent[0]?.tickers, ["AAPL", "MSFT"]);
    assert.match(recent[0]?.excerpt ?? "", /^Benzinga reports/u);
    assert.ok((recent[0]?.excerpt.length ?? 0) <= 240);
  });

  it("normalizes tickerless events by extracting symbols from headline and summary", () => {
    const item = normalizeAlpacaNewsEvent({
      T: "n",
      id: "vendor-2",
      headline: "$NVDA expands data-center supply",
      summary: "Analysts say AMD and NVDA demand remains resilient.",
      url: "https://www.benzinga.com/news/nvda",
      created_at: "2026-06-17T13:30:00Z",
      symbols: []
    });

    assert.deepEqual(item?.tickers, ["AMD", "NVDA"]);
    assert.equal(item?.sourceItemId, "vendor-2");
  });

  it("reconnects with backoff after a stream error and respects abort", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const delays: number[] = [];
    const socketFactory: AlpacaNewsSocketFactory = async () => {
      attempts += 1;
      return {
        send() {},
        messages:
          attempts === 1
            ? (async function* () {
                throw new Error("socket dropped");
              })()
            : (async function* () {
                controller.abort();
              })(),
        close() {}
      };
    };

    await runAlpacaNewsIngestStream({
      credentialVault: new RecordingBrokerCredentialVault({ keyId: "paper-key", secretKey: "paper-secret" }),
      itemsStore: new InMemoryQualitativeItemsStore(),
      socketFactory,
      signal: controller.signal,
      reconnectInitialDelayMs: 25,
      reconnectMaxDelayMs: 30,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
      logger: { error() {}, log() {}, warn() {} }
    });

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [25]);
  });

  it("logs once and disables the stream when credentials are missing", async () => {
    let factoryCalled = false;
    const warnings: string[] = [];
    const vault = new RecordingBrokerCredentialVault(null);

    await runAlpacaNewsIngestStream({
      credentialVault: vault,
      itemsStore: new InMemoryQualitativeItemsStore(),
      socketFactory: async () => {
        factoryCalled = true;
        throw new Error("must not connect");
      },
      signal: new AbortController().signal,
      logger: { error() {}, log() {}, warn(message) { warnings.push(String(message)); } }
    });

    assert.deepEqual(vault.requests, [ALPACA_PAPER_BROKER_ACCOUNT_ID]);
    assert.equal(factoryCalled, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /missing broker credentials for alpaca-paper/u);
  });

  it("ingests a single connection and reports insert versus duplicate counts", async () => {
    const itemsStore = new RecordingItemsStore();
    const result = await ingestAlpacaNewsConnectionOnce({
      credential: { keyId: "paper-key", secretKey: "paper-secret" },
      itemsStore,
      socketFactory: async () => ({
        send() {},
        messages: (async function* () {
          yield JSON.stringify([newsEvent(), newsEvent({ id: 2, headline: "TSLA update", symbols: ["TSLA"] })]);
        })(),
        close() {}
      }),
      signal: new AbortController().signal
    });

    assert.deepEqual(result, { eventsSeen: 2, inserted: 2, duplicates: 0 });
  });
});

describe("alpaca-news source seed", () => {
  it("is idempotent and keeps the stable built-in source id", async () => {
    let rowCount = 0;
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const row: SourceRow = {
      id: ALPACA_NEWS_SOURCE_ID,
      source_key: "alpaca-news",
      name: "Alpaca News",
      source_type: "programmatic",
      feed_url: null,
      enabled: true,
      quality_rating: 4,
      created_at: "2026-06-17T12:00:00.000Z",
      updated_at: "2026-06-17T12:00:00.000Z"
    };
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        rowCount = 1;
        return { rows: [row] };
      }
    } as unknown as Pool;

    const first = await ensureAlpacaNewsSource(pool);
    const second = await ensureAlpacaNewsSource(pool);

    assert.equal(rowCount, 1);
    assert.equal(first.id, ALPACA_NEWS_SOURCE_ID);
    assert.equal(second.id, ALPACA_NEWS_SOURCE_ID);
    assert.equal(first.sourceKey, "alpaca-news");
    assert.equal(first.sourceType, "programmatic");
    assert.equal(first.feedUrl, undefined);
    assert.match(queries[0]?.text ?? "", /ON CONFLICT \(source_key\) DO UPDATE/u);
    assert.deepEqual(queries[0]?.values, [ALPACA_NEWS_SOURCE_ID, "alpaca-news", "Alpaca News"]);
    assert.equal(queries.length, 2);
  });
});

function newsEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    T: "n",
    id: 24918784,
    headline: "AAPL rallies as MSFT holds support",
    summary:
      "Benzinga reports $AAPL momentum improved while MSFT held support. This intentionally long second sentence should be trimmed before becoming full article redistribution, preserving only a short attributed excerpt for operator context in the qualitative store.",
    author: "Benzinga Newsdesk",
    created_at: "2026-06-17T12:30:00Z",
    updated_at: "2026-06-17T12:30:01Z",
    url: "https://www.benzinga.com/news/26/06/24918784/aapl-rallies#section",
    content: "<p>Full body must not be stored.</p>",
    symbols: ["AAPL", "MSFT"],
    source: "benzinga",
    ...overrides
  };
}

class RecordingBrokerCredentialVault implements BrokerCredentialVault {
  readonly requests: string[] = [];

  constructor(private readonly credential: BrokerCredential | null) {}

  async getBrokerCredential(brokerAccountId: string): Promise<BrokerCredential | null> {
    this.requests.push(brokerAccountId);
    return this.credential;
  }
}

class RecordingItemsStore implements QualitativeItemsStore {
  readonly results: Array<QualitativeItem | null> = [];
  private readonly delegate = new InMemoryQualitativeItemsStore();

  async upsertItem(input: QualitativeItemInput): Promise<QualitativeItem | null> {
    const result = await this.delegate.upsertItem(input);
    this.results.push(result);
    return result;
  }

  async listRecentItems(options?: { limit?: number; ticker?: string }): Promise<QualitativeItem[]> {
    return this.delegate.listRecentItems(options);
  }
}
