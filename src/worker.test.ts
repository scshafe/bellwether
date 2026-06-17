import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryQualitativeItemsStore, InMemorySourcesStore, type SourceRecord } from "./qualitative.js";
import { maybeStartXHandleIngestPoller } from "./worker.js";

describe("worker X handle ingest gate", () => {
  it("does not start the X poller unless flag, credential, and enabled X sources are present", async () => {
    const itemsStore = new InMemoryQualitativeItemsStore();
    const logger = { error() {}, log() {}, warn() {} };

    assert.equal(
      (await maybeStartXHandleIngestPoller({
        sourcesStore: new InMemorySourcesStore([xHandleSource()]),
        itemsStore,
        credentialVault: new StaticXCredentialVault({ bearerToken: "x-paperless-token" }),
        pollIntervalMs: 1,
        signal: new AbortController().signal,
        env: {},
        logger
      })).poller,
      undefined
    );
    assert.equal(
      (await maybeStartXHandleIngestPoller({
        sourcesStore: new InMemorySourcesStore([xHandleSource()]),
        itemsStore,
        credentialVault: new StaticXCredentialVault(null),
        pollIntervalMs: 1,
        signal: new AbortController().signal,
        env: { BELLWETHER_FEATURE_X_HANDLES: "true" },
        logger
      })).poller,
      undefined
    );
    assert.equal(
      (await maybeStartXHandleIngestPoller({
        sourcesStore: new InMemorySourcesStore([{ ...xHandleSource(), enabled: false }]),
        itemsStore,
        credentialVault: new StaticXCredentialVault({ bearerToken: "x-paperless-token" }),
        pollIntervalMs: 1,
        signal: new AbortController().signal,
        env: { BELLWETHER_FEATURE_X_HANDLES: "true" },
        logger
      })).poller,
      undefined
    );
  });
});

function xHandleSource(): SourceRecord {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    sourceKey: "x-bellwether",
    name: "Bellwether X",
    sourceType: "x-handle",
    feedUrl: "https://x.com/BellwetherAI",
    enabled: true,
    qualityRating: 4,
    createdAt: "2026-06-17T16:00:00.000Z",
    updatedAt: "2026-06-17T16:00:00.000Z"
  };
}

class StaticXCredentialVault {
  constructor(private readonly credential: { bearerToken: string } | null) {}

  async getXApiCredential(): Promise<{ bearerToken: string } | null> {
    return this.credential;
  }
}
