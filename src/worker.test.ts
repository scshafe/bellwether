import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool, PoolClient } from "pg";

import type { LiveTradeCycleResult } from "./live-cycle.js";
import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type PortfolioSnapshot, type QuantPlaybook } from "./quant-playbook.js";
import { InMemoryQualitativeItemsStore, InMemorySourcesStore, type SourceRecord } from "./qualitative.js";
import type { ReasoningModel } from "./llm.js";
import type { StrategyRecord } from "./strategy.js";
import { InMemoryStrategyProposalsStore } from "./strategy-proposals.js";
import {
  createEveryNthCycleProposalPolicy,
  createOptionalStrategyProposalModel,
  createStrategyProposalStep,
  maybeStartXHandleIngestPoller,
  runClaimedJob
} from "./worker.js";

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

describe("worker strategy proposal wiring", () => {
  it("guards optional proposal model creation when the OAuth credential is missing", async () => {
    const warnings: unknown[][] = [];
    const model = await createOptionalStrategyProposalModel({
      credentialFile: `/tmp/opencode/missing-openai-oauth-${Date.now()}.json`,
      logger: { warn: (...args: unknown[]) => warnings.push(args) }
    });

    assert.equal(model, null);
    assert.match(String(warnings[0]?.[0] ?? ""), /Strategy proposal model unavailable/u);
  });

  it("thresholds proposal emission and skips when a pending proposal already exists", async () => {
    const store = new InMemoryStrategyProposalsStore();
    let proposeCalls = 0;
    const step = createStrategyProposalStep({
      store,
      createModel: async () => dummyModel,
      createAgent: () => ({
        propose: async (input) => {
          proposeCalls += 1;
          assert.deepEqual(input.qualitativeBrief, { links: [], quotes: [], signals: [] });
          return {
            suggestedCandidate: {
              name: "Every Other Cycle Candidate",
              mandate: "Review only after the threshold has been met.",
              suggestedParameters: { maxOpenPositions: 3 }
            },
            quantRationale: "Two completed cycles crossed the proposal threshold.",
            qualitativeEvidence: input.qualitativeBrief!
          };
        }
      }),
      emissionPolicy: createEveryNthCycleProposalPolicy(2),
      timeoutMs: 100,
      logger: silentLogger()
    });
    const result = liveCycleResult();
    const job = { id: "11111111-1111-4111-8111-111111111111", kind: "live_trade_cycle" as const };

    await step(result, job);
    assert.equal(proposeCalls, 0);
    assert.equal((await store.listPending()).length, 0);

    await step(result, job);
    assert.equal(proposeCalls, 1);
    assert.equal((await store.listPending()).length, 1);

    await step(result, job);
    assert.equal(proposeCalls, 1);
  });

  it("times out and swallows a hanging proposal without recording", async () => {
    const store = new InMemoryStrategyProposalsStore();
    const warnings: string[] = [];
    const step = createStrategyProposalStep({
      store,
      createModel: async () => dummyModel,
      createAgent: () => ({ propose: async () => new Promise(() => {}) }),
      emissionPolicy: () => true,
      timeoutMs: 1,
      logger: { ...silentLogger(), warn: (message: string) => warnings.push(message) }
    });

    await step(liveCycleResult(), { id: "11111111-1111-4111-8111-111111111111", kind: "live_trade_cycle" });

    assert.equal((await store.listPending()).length, 0);
    assert.match(warnings[0] ?? "", /timed out/u);
  });

  it("does not let a thrown proposal step relabel success or stop re-arm", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const client = new RecordingClient(runtimeRow({ enabled: true, active_job_id: jobId }));
    const warnings: string[] = [];
    const errors: string[] = [];

    await runClaimedJob(poolFromClient(client), { id: jobId, kind: "live_trade_cycle" }, 1234, {
      runLiveTradeCycle: async () => liveCycleResult(),
      proposalStep: async () => {
        throw new Error("proposal boom");
      },
      logger: {
        log() {},
        warn: (message: string) => warnings.push(message),
        error: (message: string) => errors.push(message)
      }
    });

    const jobUpdates = client.queries.filter((query) => query.text.includes("UPDATE agent_jobs SET status = $2"));
    const rearmInsert = client.queries.find((query) => query.text.includes("INSERT INTO agent_jobs"));
    const runtimeUpdate = client.queries.find((query) => query.text.includes("UPDATE agent_runtime_status"));

    assert.deepEqual(jobUpdates.map((query) => query.values), [[jobId, "done"]]);
    assert.deepEqual(rearmInsert?.values, [1234]);
    assert.deepEqual(runtimeUpdate?.values, [
      jobId,
      "succeeded",
      "Live cycle completed with placed; order order-1.",
      "22222222-2222-4222-8222-222222222222",
      client.nextJobId
    ]);
    assert.match(warnings[0] ?? "", /proposal boom/u);
    assert.deepEqual(errors, []);
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

const dummyModel: ReasoningModel = {
  async generateJson(): Promise<unknown> {
    throw new Error("dummy model should not be called directly in worker proposal tests");
  }
};

function liveCycleResult(): LiveTradeCycleResult {
  const strategy = baseStrategy();
  const portfolio = portfolioSnapshot();
  const playbook = quantPlaybook();

  return {
    cycleId: "job-11111111111141118111111111111111",
    strategy,
    playbook,
    portfolio,
    quantSignal: {
      asOf: "2026-06-17T14:00:00.000Z",
      symbol: "AAPL",
      score: 0.08,
      signals: playbook.candidates[0]!.signals,
      sizing: playbook.candidates[0]!.sizing
    },
    strategyAnalyst: {
      thesis: "AAPL is the top candidate.",
      proposedOrder: {
        clientOrderId: "atp-job-1",
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        timeInForce: "day",
        limitPrice: 100,
        estimatedNotional: 100
      }
    },
    risk: { approved: true, verdict: "approved", rationale: "Inside rails.", deterministicViolations: [] },
    execution: {
      decision: "placed",
      rationale: "Placed through the adapter.",
      order: {
        id: "order-1",
        clientOrderId: "atp-job-1",
        symbol: "AAPL",
        qty: "1",
        side: "buy",
        type: "limit",
        timeInForce: "day",
        status: "accepted"
      }
    },
    decisionLog: {
      id: "22222222-2222-4222-8222-222222222222",
      cycleId: "job-11111111111141118111111111111111",
      strategyId: strategy.id,
      createdAt: "2026-06-17T14:00:00.000Z",
      quantSignal: {
        asOf: "2026-06-17T14:00:00.000Z",
        symbol: "AAPL",
        score: 0.08,
        signals: playbook.candidates[0]!.signals,
        sizing: playbook.candidates[0]!.sizing
      },
      brokerSnapshot: {
        account: {
          id: "account-1",
          status: "ACTIVE",
          currency: "USD",
          cash: "5000",
          buyingPower: "10000",
          portfolioValue: "20000",
          equity: "20000",
          lastEquity: "19950",
          dailyPnl: "50"
        },
        positions: []
      },
      strategyAnalyst: {
        thesis: "AAPL is the top candidate.",
        proposedOrder: {
          clientOrderId: "atp-job-1",
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "limit",
          timeInForce: "day",
          limitPrice: 100,
          estimatedNotional: 100
        }
      },
      risk: { approved: true, verdict: "approved", rationale: "Inside rails.", deterministicViolations: [] },
      execution: {
        decision: "placed",
        rationale: "Placed through the adapter.",
        order: {
          id: "order-1",
          clientOrderId: "atp-job-1",
          symbol: "AAPL",
          qty: "1",
          side: "buy",
          type: "limit",
          timeInForce: "day",
          status: "accepted"
        }
      }
    }
  };
}

function baseStrategy(): StrategyRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Cycle-A one-share momentum",
    description: "Active test strategy.",
    status: "active",
    parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
    createdAt: "2026-06-17T13:00:00.000Z",
    updatedAt: "2026-06-17T13:00:00.000Z",
    approvedAt: "2026-06-17T13:01:00.000Z",
    activatedAt: "2026-06-17T13:02:00.000Z"
  };
}

function portfolioSnapshot(): PortfolioSnapshot {
  return { equity: 20_000, cash: 8_000, dailyPnl: 50, positions: [] };
}

function quantPlaybook(): QuantPlaybook {
  return {
    asOf: "2026-06-17T14:00:00.000Z",
    parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
    screenedUniverse: [
      {
        symbol: "AAPL",
        sector: "technology",
        lastPrice: 100,
        passed: true,
        rejectReasons: [],
        signals: { momentumFraction: 0.08, volatilityFraction: 0.02, averageDollarVolume: 2_500_000, score: 0.08 }
      }
    ],
    candidates: [
      {
        symbol: "AAPL",
        sector: "technology",
        side: "buy",
        score: 0.08,
        signals: { momentumFraction: 0.08, volatilityFraction: 0.02, averageDollarVolume: 2_500_000, score: 0.08 },
        sizing: { maxQty: 1, maxNotional: 100 }
      }
    ],
    rails: {
      asOf: "2026-06-17T14:00:00.000Z",
      equity: 20_000,
      maxOpenPositions: 5,
      openSymbols: [],
      dailyDrawdown: { maxLossFraction: 0.03, currentLossFraction: 0, triggered: false },
      symbols: {}
    }
  };
}

type QueryRecord = { text: string; values?: unknown[] };

class RecordingClient {
  readonly queries: QueryRecord[] = [];
  readonly nextJobId = "44444444-4444-4444-8444-444444444444";

  constructor(private readonly statusRow: Record<string, unknown>) {}

  async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });

    if (text.includes("FOR UPDATE")) {
      return { rows: [this.statusRow as T] };
    }

    if (text.includes("INSERT INTO agent_jobs")) {
      return { rows: [{ id: this.nextJobId } as T] };
    }

    return { rows: [] };
  }

  release(): void {}
}

function poolFromClient(client: RecordingClient): Pool {
  return {
    connect: async () => client as unknown as PoolClient
  } as unknown as Pool;
}

function runtimeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    enabled: false,
    active_job_id: null,
    last_cycle_job_id: null,
    last_cycle_status: null,
    last_cycle_summary: null,
    last_cycle_decision_log_id: null,
    last_cycle_completed_at: null,
    updated_at: "2026-06-17T14:00:00.000Z",
    ...overrides
  };
}

function silentLogger(): Pick<Console, "error" | "log" | "warn"> {
  return { error() {}, log() {}, warn() {} };
}
