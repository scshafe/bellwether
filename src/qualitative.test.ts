import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool } from "pg";

import {
  ensureQualitativeItemsSchema,
  ensureSourcesSchema,
  InMemoryQualitativeItemsStore,
  InMemorySourcesStore,
  pollQualitativeFeedsOnce,
  PostgresQualitativeItemsStore,
  PostgresSourcesStore,
  runRssAtomIngestPoller,
  type QualitativeFetch,
  type QualitativeItemRow,
  type SourceRow
} from "./qualitative.js";

describe("qualitative source registry", () => {
  it("creates enabled and programmatic sources with quality ratings", async () => {
    const store = new InMemorySourcesStore();
    await store.createSource({
      id: "11111111-1111-4111-8111-111111111111",
      sourceKey: "curated-feed",
      name: "Curated Feed",
      sourceType: "rss",
      feedUrl: "https://feeds.example.test/rss.xml",
      enabled: true,
      qualityRating: 5
    });
    await store.createSource({
      id: "22222222-2222-4222-8222-222222222222",
      sourceKey: "alpaca-news",
      name: "Alpaca News",
      sourceType: "programmatic",
      enabled: true,
      qualityRating: 4
    });
    await store.createSource({
      sourceKey: "disabled-feed",
      name: "Disabled Feed",
      sourceType: "atom",
      feedUrl: "https://feeds.example.test/atom.xml",
      enabled: false,
      qualityRating: 2
    });

    const enabled = await store.listEnabledSources();

    assert.deepEqual(
      enabled.map((source) => [source.sourceKey, source.qualityRating, source.feedUrl]),
      [
        ["alpaca-news", 4, undefined],
        ["curated-feed", 5, "https://feeds.example.test/rss.xml"]
      ]
    );
    await assert.rejects(
      () => store.createSource({ sourceKey: "bad-quality", name: "Bad", feedUrl: "https://example.test/rss", qualityRating: 6 }),
      /qualityRating must be an integer from 1 to 5/u
    );
  });
});

describe("RSS/Atom qualitative ingest", () => {
  it("normalizes RSS entries into short excerpts and dedups repeated polls", async () => {
    const sourcesStore = new InMemorySourcesStore();
    const itemsStore = new InMemoryQualitativeItemsStore();
    await sourcesStore.createSource({
      id: "33333333-3333-4333-8333-333333333333",
      sourceKey: "rss-feed",
      name: "RSS Feed",
      sourceType: "rss",
      feedUrl: "https://feeds.example.test/rss.xml",
      enabled: true,
      qualityRating: 5
    });
    const fetchFn: QualitativeFetch = async () => ({
      ok: true,
      async text() {
        return `<?xml version="1.0"?>
          <rss><channel>
            <item>
              <title>$AAPL breaks higher while MSFT holds support</title>
              <guid>vendor-guid-1</guid>
              <link>https://news.example.test/story?utm_source=feed#section</link>
              <pubDate>Wed, 17 Jun 2026 12:30:00 GMT</pubDate>
              <description><![CDATA[<p>RSS Source reports that $AAPL momentum improved after the open. This second sentence adds context without preserving a full article body. This extra sentence is intentionally long so the stored excerpt truncates before it can become full-text redistribution of the source article.</p>]]></description>
            </item>
          </channel></rss>`;
      }
    });

    const first = await pollQualitativeFeedsOnce({ sourcesStore, itemsStore, fetchFn });
    const second = await pollQualitativeFeedsOnce({ sourcesStore, itemsStore, fetchFn });
    const recent = await itemsStore.listRecentItems({ ticker: "AAPL" });

    assert.deepEqual(first, { sourcesChecked: 1, entriesSeen: 1, inserted: 1, duplicates: 0 });
    assert.deepEqual(second, { sourcesChecked: 1, entriesSeen: 1, inserted: 0, duplicates: 1 });
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.sourceItemId, "vendor-guid-1");
    assert.equal(recent[0]?.link, "https://news.example.test/story?utm_source=feed");
    assert.equal(recent[0]?.publishedAt, "2026-06-17T12:30:00.000Z");
    assert.deepEqual(recent[0]?.tickers, ["AAPL", "MSFT"]);
    assert.match(recent[0]?.excerpt ?? "", /^RSS Source reports/u);
    assert.match(recent[0]?.excerpt ?? "", /\.\.\.$/u);
    assert.ok((recent[0]?.excerpt.length ?? 0) <= 240);
    assert.equal(recent[0]?.metadata.qualityRating, 5);
  });

  it("parses Atom entries and falls back to per-source link identity", async () => {
    const sourcesStore = new InMemorySourcesStore();
    const itemsStore = new InMemoryQualitativeItemsStore();
    await sourcesStore.createSource({
      id: "44444444-4444-4444-8444-444444444444",
      sourceKey: "atom-feed",
      name: "Atom Feed",
      sourceType: "atom",
      feedUrl: "https://feeds.example.test/atom.xml",
      enabled: true,
      qualityRating: 3
    });
    const fetchFn: QualitativeFetch = async () => ({
      ok: true,
      async text() {
        return `<feed>
          <entry>
            <title>NVDA demand update</title>
            <link rel="alternate" href="https://research.example.test/nvda" />
            <updated>2026-06-17T13:00:00Z</updated>
            <summary>Analysts cite $NVDA demand and margin discipline.</summary>
          </entry>
        </feed>`;
      }
    });

    const result = await pollQualitativeFeedsOnce({ sourcesStore, itemsStore, fetchFn });
    const recent = await itemsStore.listRecentItems({ ticker: "NVDA" });

    assert.equal(result.inserted, 1);
    assert.equal(recent[0]?.sourceItemId, "https://research.example.test/nvda");
    assert.equal(recent[0]?.title, "NVDA demand update");
    assert.deepEqual(recent[0]?.tickers, ["NVDA"]);
  });

  it("exits the background poller when the AbortSignal is aborted", async () => {
    const controller = new AbortController();
    const sourcesStore = new InMemorySourcesStore();
    const itemsStore = new InMemoryQualitativeItemsStore();

    controller.abort();
    await runRssAtomIngestPoller({
      sourcesStore,
      itemsStore,
      pollIntervalMs: 1,
      signal: controller.signal
    });
  });
});

describe("Postgres qualitative stores", () => {
  it("use bootstrap SQL and per-source dedup conflict handling", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const sourceRow: SourceRow = {
      id: "55555555-5555-4555-8555-555555555555",
      source_key: "pg-feed",
      name: "PG Feed",
      source_type: "rss",
      feed_url: "https://feeds.example.test/rss.xml",
      enabled: true,
      quality_rating: 4,
      created_at: "2026-06-17T12:00:00.000Z",
      updated_at: "2026-06-17T12:00:00.000Z"
    };
    const itemRow: QualitativeItemRow = {
      id: "66666666-6666-4666-8666-666666666666",
      source_id: sourceRow.id,
      source_item_id: "stable-guid",
      link: "https://news.example.test/aapl",
      title: "AAPL update",
      excerpt: "AAPL update excerpt.",
      published_at: "2026-06-17T12:05:00.000Z",
      tickers: ["AAPL"],
      metadata: { qualityRating: 4 },
      created_at: "2026-06-17T12:06:00.000Z"
    };
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("INSERT INTO sources")) {
          return { rows: [sourceRow] };
        }

        if (text.includes("FROM sources")) {
          return { rows: [sourceRow] };
        }

        if (text.includes("INSERT INTO qualitative_items")) {
          return { rows: [itemRow] };
        }

        if (text.includes("FROM qualitative_items")) {
          return { rows: [itemRow] };
        }

        return { rows: [] };
      }
    } as unknown as Pool;
    const sourcesStore = new PostgresSourcesStore(pool);
    const itemsStore = new PostgresQualitativeItemsStore(pool);

    await ensureSourcesSchema(pool);
    await ensureQualitativeItemsSchema(pool);
    const source = await sourcesStore.createSource({
      id: sourceRow.id,
      sourceKey: sourceRow.source_key,
      name: sourceRow.name,
      sourceType: sourceRow.source_type,
      feedUrl: sourceRow.feed_url ?? undefined,
      enabled: true,
      qualityRating: sourceRow.quality_rating
    });
    const enabled = await sourcesStore.listEnabledSources();
    const inserted = await itemsStore.upsertItem({
      sourceId: source.id,
      sourceItemId: "stable-guid",
      link: itemRow.link,
      title: itemRow.title,
      excerpt: itemRow.excerpt,
      publishedAt: typeof itemRow.published_at === "string" ? itemRow.published_at : itemRow.published_at?.toISOString(),
      tickers: itemRow.tickers,
      metadata: itemRow.metadata
    });
    const recent = await itemsStore.listRecentItems({ ticker: "aapl", limit: 5 });

    assert.match(queries[0]?.text ?? "", /CREATE TABLE IF NOT EXISTS sources/u);
    assert.match(queries[0]?.text ?? "", /quality_rating integer NOT NULL DEFAULT 3 CHECK \(quality_rating BETWEEN 1 AND 5\)/u);
    assert.match(queries[1]?.text ?? "", /CREATE TABLE IF NOT EXISTS qualitative_items/u);
    assert.match(queries[1]?.text ?? "", /UNIQUE \(source_id, source_item_id\)/u);
    assert.match(queries[4]?.text ?? "", /ON CONFLICT \(source_id, source_item_id\) DO NOTHING/u);
    assert.equal(queries[4]?.values?.[2], "stable-guid");
    assert.equal(queries[4]?.values?.[8], JSON.stringify(itemRow.metadata));
    assert.match(queries[5]?.text ?? "", /\$2 = ANY\(tickers\)/u);
    assert.deepEqual(queries[5]?.values, [5, "AAPL"]);
    assert.equal(enabled[0]?.qualityRating, 4);
    assert.equal(inserted?.id, itemRow.id);
    assert.equal(recent[0]?.metadata.qualityRating, 4);
  });
});
