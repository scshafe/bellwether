import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool } from "pg";

import type { PortalQualitativeEvidence } from "./agent-team.js";
import type { LlmJsonRequest, ReasoningModel } from "./llm.js";
import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type PortfolioSnapshot, type QuantPlaybook } from "./quant-playbook.js";
import type { StrategyRecord } from "./strategy.js";
import {
  ensureStrategyProposalsSchema,
  InMemoryStrategyProposalsStore,
  PostgresStrategyProposalsStore,
  STRATEGY_PROPOSAL_STATUSES,
  StrategyProposalAgent,
  StrategyProposalNotFoundError,
  type StrategyProposalRecord
} from "./strategy-proposals.js";

class QueueReasoningModel implements ReasoningModel {
  readonly requests: LlmJsonRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async generateJson(request: LlmJsonRequest): Promise<unknown> {
    this.requests.push(request);
    const response = this.responses.shift();

    if (!response) {
      throw new Error(`missing mock LLM response for ${request.schemaName}`);
    }

    return response;
  }
}

describe("strategy proposals store", () => {
  it("records, lists pending, marks reviewed, and snapshots qualitative evidence in memory", async () => {
    const store = new InMemoryStrategyProposalsStore();
    const evidence = qualitativeEvidence();
    const recorded = await store.recordProposal({
      id: "11111111-1111-4111-8111-111111111111",
      strategyId: baseStrategy().id,
      suggestedCandidate: {
        name: "Quality Momentum",
        mandate: "Discuss a stricter momentum candidate.",
        suggestedParameters: { minMomentumFraction: 0.03, maxOpenPositions: 3 }
      },
      quantRationale: "A stronger momentum threshold would narrow the candidate set.",
      qualitativeEvidence: evidence,
      createdAt: "2026-06-17T14:00:00.000Z"
    });

    evidence.links[0]!.title = "mutated after record";
    const pending = await store.listPending();
    const reviewed = await store.markReviewed(recorded.id);

    assert.equal(recorded.status, "pending");
    assert.deepEqual(STRATEGY_PROPOSAL_STATUSES, ["pending", "reviewed", "dismissed"]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.qualitativeEvidence.links[0]?.title, "AAPL momentum update");
    assert.equal(reviewed.status, "reviewed");
    assert.ok(reviewed.reviewedAt);
    assert.equal((await store.listPending()).length, 0);
  });

  it("uses idempotent bootstrap SQL and maps Postgres proposal rows", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const rows: StrategyProposalRow[] = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("INSERT INTO strategy_proposals")) {
          const row: StrategyProposalRow = {
            id: String(values?.[0]),
            status: String(values?.[1]) as StrategyProposalRecord["status"],
            strategy_id: values?.[2] ? String(values[2]) : null,
            suggested_candidate: JSON.parse(String(values?.[3])) as StrategyProposalRecord["suggestedCandidate"],
            quant_rationale: String(values?.[4]),
            qualitative_evidence: JSON.parse(String(values?.[5])) as PortalQualitativeEvidence,
            created_at: String(values?.[6]),
            reviewed_at: null
          };
          rows.push(row);
          return { rows: [row] };
        }

        if (text.includes("WHERE status = 'pending'")) {
          return { rows: rows.filter((row) => row.status === "pending") };
        }

        if (text.includes("UPDATE strategy_proposals")) {
          const row = rows.find((candidate) => candidate.id === values?.[0]);

          if (!row) {
            return { rows: [] };
          }

          row.status = values?.[1] as StrategyProposalRecord["status"];
          row.reviewed_at = "2026-06-17T14:05:00.000Z";
          return { rows: [row] };
        }

        return { rows: [] };
      }
    } as unknown as Pool;
    const store = new PostgresStrategyProposalsStore(pool);

    await ensureStrategyProposalsSchema(pool);
    await ensureStrategyProposalsSchema(pool);
    const recorded = await store.recordProposal({
      id: "22222222-2222-4222-8222-222222222222",
      strategyId: baseStrategy().id,
      suggestedCandidate: {
        name: "Liquidity Momentum",
        mandate: "Review a higher-liquidity candidate.",
        suggestedParameters: { minAverageDollarVolume: 2_000_000 }
      },
      quantRationale: "Liquidity filter is the binding quant lever.",
      qualitativeEvidence: qualitativeEvidence(),
      createdAt: "2026-06-17T14:01:00.000Z"
    });
    const pending = await store.listPending(500);
    const dismissed = await store.markReviewed(recorded.id, "dismissed");

    assert.match(queries[0]?.text ?? "", /CREATE TABLE IF NOT EXISTS strategy_proposals/u);
    assert.match(queries[0]?.text ?? "", /CONSTRAINT strategy_proposals_status_check CHECK \(status IN \('pending', 'reviewed', 'dismissed'\)\)/u);
    assert.match(queries[0]?.text ?? "", /CREATE INDEX IF NOT EXISTS strategy_proposals_status_created_idx/u);
    assert.match(queries[1]?.text ?? "", /CREATE TABLE IF NOT EXISTS strategy_proposals/u);
    assert.match(queries[2]?.text ?? "", /INSERT INTO strategy_proposals/u);
    assert.equal(queries[2]?.values?.[1], "pending");
    assert.equal(queries[2]?.values?.[4], "Liquidity filter is the binding quant lever.");
    assert.match(queries[3]?.text ?? "", /WHERE status = 'pending'/u);
    assert.deepEqual(queries[3]?.values, [100]);
    assert.equal(pending.length, 1);
    assert.equal(dismissed.status, "dismissed");
    assert.equal(dismissed.reviewedAt, "2026-06-17T14:05:00.000Z");
  });

  it("raises a typed not-found error when reviewing an unknown proposal", async () => {
    const store = new InMemoryStrategyProposalsStore();

    await assert.rejects(
      store.markReviewed("missing"),
      (error: unknown) => error instanceof StrategyProposalNotFoundError && /missing/u.test(error.message)
    );
  });
});

describe("strategy proposal agent", () => {
  it("returns a validated advisory candidate and empty qualitative snapshot when no brief exists", async () => {
    const model = new QueueReasoningModel([
      {
        suggestedCandidate: {
          name: "Narrow Momentum Candidate",
          mandate: "Discuss tightening the momentum screen before any operator action.",
          suggestedParameters: { minMomentumFraction: 0.04, maxOpenPositions: 2 }
        },
        quantRationale: "The leading candidate has strong momentum while the current strategy admits too many weaker names."
      }
    ]);
    const agent = new StrategyProposalAgent(model);

    const output = await agent.propose({
      strategy: baseStrategy(),
      playbook: playbook(),
      portfolio: portfolio()
    });

    assert.equal(StrategyProposalAgent.length, 1);
    assert.equal(output.suggestedCandidate.name, "Narrow Momentum Candidate");
    assert.deepEqual(output.suggestedCandidate.suggestedParameters, { minMomentumFraction: 0.04, maxOpenPositions: 2 });
    assert.deepEqual(output.qualitativeEvidence, { links: [], quotes: [], signals: [] });
    assert.equal(model.requests[0]?.schemaName, "strategy_proposal_candidate");
    assert.match(model.requests[0]?.systemPrompt ?? "", /never claim that a strategy, parameter set, lifecycle state, or order has been changed/u);
    assert.match(model.requests[0]?.systemPrompt ?? "", /Do not propose or discuss order placement/u);
    assert.equal(JSON.stringify(model.requests).includes("paper"), false);
  });

  it("rejects invalid candidate parameters before persistence", async () => {
    const model = new QueueReasoningModel([
      {
        suggestedCandidate: {
          name: "Invalid Candidate",
          mandate: "This should fail validation.",
          suggestedParameters: { maxOpenPositions: 0 }
        },
        quantRationale: "Invalid."
      }
    ]);
    const agent = new StrategyProposalAgent(model);

    await assert.rejects(
      agent.propose({ strategy: baseStrategy(), playbook: playbook(), portfolio: portfolio(), qualitativeBrief: qualitativeEvidence() }),
      /maxOpenPositions must be a positive integer/u
    );
  });

  it("has no broker or mutable strategy store path to place orders or mutate strategies", async () => {
    let brokerOrderCalls = 0;
    let strategyMutationCalls = 0;
    const forbiddenBroker = { placeOrder: () => { brokerOrderCalls += 1; } };
    const forbiddenStrategyStore = { updateStrategy: () => { strategyMutationCalls += 1; } };
    const strategy = baseStrategy();
    const before = JSON.stringify(strategy);
    const model = new QueueReasoningModel([
      {
        suggestedCandidate: {
          name: "Advisory Candidate",
          mandate: "Discuss this candidate in the proposal inbox.",
          suggestedParameters: { maxPositionNotional: 1_500 }
        },
        quantRationale: "Sizing is the quant lever to review."
      }
    ]);
    const agent = new StrategyProposalAgent(model);

    await agent.propose({ strategy, playbook: playbook(), portfolio: portfolio(), qualitativeBrief: qualitativeEvidence() });

    assert.equal(typeof forbiddenBroker.placeOrder, "function");
    assert.equal(typeof forbiddenStrategyStore.updateStrategy, "function");
    assert.equal(brokerOrderCalls, 0);
    assert.equal(strategyMutationCalls, 0);
    assert.equal(JSON.stringify(strategy), before);
    assert.equal(JSON.stringify(model.requests).includes("placeOrder"), false);
    assert.equal(JSON.stringify(model.requests).includes("updateStrategy"), false);
  });
});

function baseStrategy(): StrategyRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Active momentum",
    description: "Baseline active strategy.",
    status: "active",
    parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
    createdAt: "2026-06-17T13:00:00.000Z",
    updatedAt: "2026-06-17T13:00:00.000Z",
    approvedAt: "2026-06-17T13:01:00.000Z",
    activatedAt: "2026-06-17T13:02:00.000Z"
  };
}

function portfolio(): PortfolioSnapshot {
  return {
    equity: 20_000,
    cash: 8_000,
    dailyPnl: 50,
    positions: [{ symbol: "MSFT", qty: 1, marketValue: 410, sector: "technology" }]
  };
}

function playbook(): QuantPlaybook {
  return {
    asOf: "2026-06-17T14:00:00.000Z",
    parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
    screenedUniverse: [
      {
        symbol: "AAPL",
        sector: "technology",
        lastPrice: 210,
        passed: true,
        rejectReasons: [],
        signals: { momentumFraction: 0.08, volatilityFraction: 0.02, averageDollarVolume: 2_500_000, score: 0.07 }
      }
    ],
    candidates: [
      {
        symbol: "AAPL",
        sector: "technology",
        side: "buy",
        score: 0.07,
        signals: { momentumFraction: 0.08, volatilityFraction: 0.02, averageDollarVolume: 2_500_000, score: 0.07 },
        sizing: { maxQty: 3, maxNotional: 630 }
      }
    ],
    rails: {
      asOf: "2026-06-17T14:00:00.000Z",
      equity: 20_000,
      maxOpenPositions: 5,
      openSymbols: ["MSFT"],
      dailyDrawdown: { maxLossFraction: 0.03, currentLossFraction: 0, triggered: false },
      symbols: {}
    }
  };
}

function qualitativeEvidence(): PortalQualitativeEvidence {
  return {
    links: [{ href: "https://news.example.test/aapl", title: "AAPL momentum update", source: "curated-feed" }],
    quotes: [{ quote: "AAPL demand stayed constructive.", source: "curated-feed", href: "https://news.example.test/aapl" }],
    signals: [{ label: "Tone", value: "Constructive", source: "curated-feed" }]
  };
}

type StrategyProposalRow = {
  id: string;
  status: StrategyProposalRecord["status"];
  strategy_id: string | null;
  suggested_candidate: StrategyProposalRecord["suggestedCandidate"];
  quant_rationale: string;
  qualitative_evidence: PortalQualitativeEvidence;
  created_at: string;
  reviewed_at: string | null;
};
