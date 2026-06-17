import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryQualitativeItemsStore,
  InMemorySourcesStore,
  QUALITATIVE_EXCERPT_MAX_CHARS,
  type QualitativeItem,
  type QualitativeItemInput,
  type QualitativeItemsStore,
  type SourceRecord
} from "./qualitative.js";
import {
  normalizeXPost,
  parseXHandle,
  pollXHandleSourcesOnce,
  runXHandleIngestPoller,
  type XApiPost,
  type XApiTransport
} from "./x-handle-ingest.js";

describe("X handle ingest", () => {
  it("fetches recent posts through an injected transport and upserts qualitative items", async () => {
    const sourcesStore = new InMemorySourcesStore([xHandleSource()]);
    const itemsStore = new RecordingItemsStore();
    const transport = new RecordingXApiTransport([xPost()]);

    const result = await pollXHandleSourcesOnce({
      sourcesStore,
      itemsStore,
      transport,
      credential: { bearerToken: "x-paperless-token" },
      signal: new AbortController().signal
    });
    const recent = await itemsStore.listRecentItems({ ticker: "AAPL" });

    assert.deepEqual(result, { sourcesChecked: 1, postsSeen: 1, inserted: 1, duplicates: 0 });
    assert.deepEqual(transport.requests, [{ handle: "BellwetherAI", bearerToken: "x-paperless-token" }]);
    assert.equal(itemsStore.results.length, 1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.sourceId, "99999999-9999-4999-8999-999999999999");
    assert.equal(recent[0]?.sourceItemId, "1890000000000000001");
    assert.equal(recent[0]?.link, "https://x.com/BellwetherAI/status/1890000000000000001");
    assert.equal(recent[0]?.title, "X post by @BellwetherAI");
    assert.equal(recent[0]?.publishedAt, "2026-06-17T16:30:00.000Z");
    assert.deepEqual(recent[0]?.tickers, ["AAPL", "MSFT"]);
    assert.equal(recent[0]?.metadata.provider, "x-api-v2");
    assert.deepEqual(recent[0]?.metadata.embedRef, {
      provider: "x",
      postId: "1890000000000000001",
      url: "https://x.com/BellwetherAI/status/1890000000000000001"
    });
  });

  it("enforces the content-policy storage shape before persistence", () => {
    const longText = `${"AAPL ".repeat(80)}full post tail must not survive as stored text`;
    const item = normalizeXPost(xHandleSource(), "@BellwetherAI", xPost({ text: longText }));
    const serializedMetadata = JSON.stringify(item?.metadata);

    assert.ok(item);
    assert.ok(item.excerpt.length <= QUALITATIVE_EXCERPT_MAX_CHARS);
    assert.match(item.excerpt, /^@BellwetherAI: "/u);
    assert.match(item.excerpt, /\.\.\."$/u);
    assert.doesNotMatch(item.excerpt, /full post tail/u);
    assert.equal(item.title, "X post by @BellwetherAI");
    assert.doesNotMatch(item.title, /AAPL/u);
    assert.ok(serializedMetadata.includes("embedRef"));
    assert.ok(serializedMetadata.includes("1890000000000000001"));
    assert.doesNotMatch(serializedMetadata, /full post tail/u);
    assert.doesNotMatch(serializedMetadata, /AAPL AAPL AAPL/u);
  });

  it("dedups repeated X posts through the existing qualitative item store", async () => {
    const sourcesStore = new InMemorySourcesStore([xHandleSource()]);
    const itemsStore = new RecordingItemsStore();
    const transport = new RecordingXApiTransport([xPost(), xPost()]);

    const result = await pollXHandleSourcesOnce({
      sourcesStore,
      itemsStore,
      transport,
      credential: { bearerToken: "x-paperless-token" },
      signal: new AbortController().signal
    });

    assert.deepEqual(result, { sourcesChecked: 1, postsSeen: 2, inserted: 1, duplicates: 1 });
    assert.ok(itemsStore.results[0]);
    assert.equal(itemsStore.results[1], null);
  });

  it("does not start when the feature flag is off, credentials are absent, or no X sources are enabled", async () => {
    const transport = new RecordingXApiTransport([xPost()]);
    const controller = new AbortController();

    await runXHandleIngestPoller({
      sourcesStore: new InMemorySourcesStore([xHandleSource()]),
      itemsStore: new InMemoryQualitativeItemsStore(),
      credentialVault: new StaticXCredentialVault({ bearerToken: "x-paperless-token" }),
      transport,
      pollIntervalMs: 1,
      signal: controller.signal,
      env: {}
    });
    await runXHandleIngestPoller({
      sourcesStore: new InMemorySourcesStore([xHandleSource()]),
      itemsStore: new InMemoryQualitativeItemsStore(),
      credentialVault: new StaticXCredentialVault(null),
      transport,
      pollIntervalMs: 1,
      signal: controller.signal,
      env: { BELLWETHER_FEATURE_X_HANDLES: "true" },
      logger: { error() {}, log() {}, warn() {} }
    });
    await runXHandleIngestPoller({
      sourcesStore: new InMemorySourcesStore([{ ...xHandleSource(), enabled: false }]),
      itemsStore: new InMemoryQualitativeItemsStore(),
      credentialVault: new StaticXCredentialVault({ bearerToken: "x-paperless-token" }),
      transport,
      pollIntervalMs: 1,
      signal: controller.signal,
      env: { BELLWETHER_FEATURE_X_HANDLES: "true" }
    });

    assert.deepEqual(transport.requests, []);
  });

  it("parses supported X handle roster values", () => {
    assert.equal(parseXHandle("@BellwetherAI"), "BellwetherAI");
    assert.equal(parseXHandle("https://x.com/BellwetherAI"), "BellwetherAI");
    assert.equal(parseXHandle("https://twitter.com/BellwetherAI/status/1"), "BellwetherAI");
    assert.equal(parseXHandle("https://example.test/BellwetherAI"), null);
  });
});

function xHandleSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    sourceKey: "x-bellwether",
    name: "Bellwether X",
    sourceType: "x-handle",
    feedUrl: "https://x.com/BellwetherAI",
    enabled: true,
    qualityRating: 4,
    createdAt: "2026-06-17T16:00:00.000Z",
    updatedAt: "2026-06-17T16:00:00.000Z",
    ...overrides
  };
}

function xPost(overrides: Partial<XApiPost> = {}): XApiPost {
  return {
    id: "1890000000000000001",
    text: "Bellwether notes $AAPL momentum while MSFT keeps support.",
    created_at: "2026-06-17T16:30:00Z",
    author_id: "12345",
    conversation_id: "1890000000000000001",
    edit_history_tweet_ids: ["1890000000000000001"],
    entities: { cashtags: [{ tag: "AAPL" }] },
    ...overrides
  };
}

class RecordingXApiTransport implements XApiTransport {
  readonly requests: Array<{ handle: string; bearerToken: string }> = [];

  constructor(private readonly posts: XApiPost[]) {}

  async fetchRecentPosts(options: { handle: string; credential: { bearerToken: string } }): Promise<XApiPost[]> {
    this.requests.push({ handle: options.handle, bearerToken: options.credential.bearerToken });
    return this.posts;
  }
}

class StaticXCredentialVault {
  constructor(private readonly credential: { bearerToken: string } | null) {}

  async getXApiCredential(): Promise<{ bearerToken: string } | null> {
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
