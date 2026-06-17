import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LlmJsonRequest, ReasoningModel } from "./llm.js";
import { InMemoryQualitativeItemsStore } from "./qualitative.js";
import { emptyQualitativeEvidence, QualitativeBriefService } from "./qualitative-brief.js";
import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS } from "./quant-playbook.js";
import type { StrategyRecord } from "./strategy.js";

class QueueReasoningModel implements ReasoningModel {
  readonly requests: LlmJsonRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async generateJson(request: LlmJsonRequest): Promise<unknown> {
    this.requests.push(request);
    const response = this.responses.shift();

    if (response instanceof Error) {
      throw response;
    }

    if (!response) {
      throw new Error(`missing mock LLM response for ${request.schemaName}`);
    }

    return response;
  }
}

const strategy: StrategyRecord = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Qualitative test strategy",
  status: "active",
  parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
  createdAt: "2026-06-17T12:00:00.000Z",
  updatedAt: "2026-06-17T12:00:00.000Z"
};

describe("qualitative brief builder", () => {
  it("builds portal-shaped evidence and drops invented links and quotes", async () => {
    const itemsStore = new InMemoryQualitativeItemsStore();
    const stored = await itemsStore.upsertItem({
      id: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      sourceItemId: "story-1",
      link: "https://news.example.test/aapl-momentum",
      title: "AAPL momentum improves",
      excerpt: "Curated Feed reports AAPL momentum improved after the open.",
      publishedAt: "2026-06-17T13:00:00.000Z",
      tickers: ["AAPL"],
      metadata: { sourceKey: "curated-feed", qualityRating: 5 }
    });
    assert.ok(stored);
    await itemsStore.upsertItem({
      id: "33333333-3333-4333-8333-333333333333",
      sourceId: "44444444-4444-4444-8444-444444444444",
      sourceItemId: "story-2",
      link: "https://other.example.test/msft",
      title: "MSFT update",
      excerpt: "Other Feed reports MSFT is steady.",
      publishedAt: "2026-06-17T12:30:00.000Z",
      tickers: ["MSFT"],
      metadata: { sourceKey: "other-feed", qualityRating: 3 }
    });
    const model = new QueueReasoningModel([
      {
        links: [
          { href: "https://news.example.test/aapl-momentum", title: "AAPL", source: "curated-feed" },
          { href: "https://invented.example.test/fake", title: "Fake", source: "invented" }
        ],
        quotes: [
          {
            quote: "AAPL momentum improved after the open.",
            source: "curated-feed",
            href: "https://news.example.test/aapl-momentum"
          },
          { quote: "Invented quote.", source: "curated-feed", href: "https://news.example.test/aapl-momentum" }
        ],
        signals: [
          { label: "Momentum read", value: "AAPL tone is improving", source: "curated-feed" },
          { label: "Bad source", value: "Ignore", source: "invented" }
        ]
      }
    ]);

    const brief = await new QualitativeBriefService().buildBrief({
      strategy,
      tickers: ["AAPL"],
      itemsStore,
      model,
      limit: 10
    });

    assert.deepEqual(brief, {
      links: [{ href: "https://news.example.test/aapl-momentum", title: "AAPL momentum improves", source: "curated-feed" }],
      quotes: [
        {
          quote: "AAPL momentum improved after the open.",
          source: "curated-feed",
          href: "https://news.example.test/aapl-momentum"
        }
      ],
      signals: [{ label: "Momentum read", value: "AAPL tone is improving", source: "curated-feed" }]
    });
    assert.equal(model.requests[0]?.schemaName, "qualitative_brief");
    assert.match(model.requests[0]?.userPrompt ?? "", /AAPL momentum improved/u);
  });

  it("returns empty evidence without an LLM call when no relevant items exist", async () => {
    const model = new QueueReasoningModel([]);
    const brief = await new QualitativeBriefService().buildBrief({
      strategy,
      tickers: ["AAPL"],
      itemsStore: new InMemoryQualitativeItemsStore(),
      model
    });

    assert.deepEqual(brief, emptyQualitativeEvidence());
    assert.equal(model.requests.length, 0);
  });

  it("returns empty evidence when the LLM seam fails", async () => {
    const itemsStore = new InMemoryQualitativeItemsStore();
    await itemsStore.upsertItem({
      sourceId: "22222222-2222-4222-8222-222222222222",
      sourceItemId: "story-1",
      link: "https://news.example.test/aapl",
      title: "AAPL update",
      excerpt: "Curated Feed reports AAPL remains in focus.",
      tickers: ["AAPL"],
      metadata: { sourceKey: "curated-feed" }
    });
    const model = new QueueReasoningModel([new Error("timeout")]);

    const brief = await new QualitativeBriefService().buildBrief({ strategy, tickers: ["AAPL"], itemsStore, model });

    assert.deepEqual(brief, emptyQualitativeEvidence());
    assert.equal(model.requests.length, 1);
  });
});
