import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AlpacaPaperAdapter } from "./broker.js";
import {
  ExecutionAgent,
  InMemoryAgentDecisionLogStore,
  runMinimalAgentTeamTrade,
  type RiskAgentDecision
} from "./agent-team.js";
import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type PriceVolumeBar, type PortfolioSnapshot } from "./quant-playbook.js";
import { InMemorySecretsStore, SecretsBackedBrokerCredentialVault } from "./secrets.js";
import { buildStrategyQuantPlaybook, InMemoryStrategyStore, type StrategyRecord } from "./strategy.js";
import type { LlmJsonRequest, ReasoningModel } from "./llm.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

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

function testVault(): SecretsBackedBrokerCredentialVault {
  return new SecretsBackedBrokerCredentialVault(
    new InMemorySecretsStore({
      "broker-credentials/alpaca-paper/key-id": "test-key-id",
      "broker-credentials/alpaca-paper/secret-key": "test-secret-key"
    })
  );
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function bars(symbol: string, closes: number[], volume: number): PriceVolumeBar[] {
  return closes.map((close, index) => ({
    symbol,
    timestamp: `2026-06-${String(index + 1).padStart(2, "0")}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume
  }));
}

async function activeStrategy(): Promise<{ strategy: StrategyRecord; store: InMemoryStrategyStore }> {
  const store = new InMemoryStrategyStore();
  const strategy = await store.createStrategy({
    id: "33333333-3333-3333-3333-333333333333",
    name: "Minimal active momentum",
    parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
  });

  await store.approveStrategy(strategy.id);
  return { strategy: await store.activateStrategy(strategy.id), store };
}

function portfolio(): PortfolioSnapshot {
  return {
    equity: 20_000,
    cash: 5_000,
    dailyPnl: 50,
    positions: []
  };
}

function alpacaOrderResponse(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "order-1",
    client_order_id: payload.client_order_id,
    symbol: payload.symbol as string,
    qty: payload.qty as string,
    side: payload.side,
    type: payload.type,
    time_in_force: payload.time_in_force,
    status: "accepted"
  };
}

describe("minimal agent team trade", () => {
  it("places one within-rails order for an Active strategy and persists the glass-box decision log", async () => {
    const { strategy, store } = await activeStrategy();
    const currentPortfolio = portfolio();
    const playbook = buildStrategyQuantPlaybook(strategy, {
      asOf: "2026-06-17T14:30:00Z",
      universe: [{ symbol: "AAPL", sector: "technology" }],
      bars: bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000),
      portfolio: currentPortfolio
    });
    const calls: FetchCall[] = [];
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      orderGuardRails: () => playbook.rails,
      strategyGate: store,
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });

        if (url.toString().endsWith("/v2/account")) {
          return responseJson({
            id: "account-1",
            status: "ACTIVE",
            currency: "USD",
            cash: "5000",
            buying_power: "10000",
            portfolio_value: "20000"
          });
        }

        if (url.toString().endsWith("/v2/positions")) {
          return responseJson([]);
        }

        assert.equal(url.toString(), "https://paper-api.alpaca.markets/v2/orders");
        return responseJson(alpacaOrderResponse(JSON.parse(init?.body as string) as Record<string, unknown>));
      }
    });
    const model = new QueueReasoningModel([
      { thesis: "AAPL has positive momentum with acceptable volatility.", symbol: "AAPL", qty: 1, limitPrice: 110 },
      { verdict: "approved", rationale: "The proposed notional is inside the computed rails." },
      { decision: "place", rationale: "Submit the approved limit order through the adapter." }
    ]);
    const decisionLogStore = new InMemoryAgentDecisionLogStore();

    const result = await runMinimalAgentTeamTrade({
      strategy,
      playbook,
      portfolio: currentPortfolio,
      broker: adapter,
      model,
      decisionLogStore,
      cycleId: "cycle-1"
    });

    assert.equal(result.execution.decision, "placed");
    assert.equal(result.execution.order?.status, "accepted");
    assert.equal(result.quantSignal.symbol, "AAPL");
    assert.equal(result.risk.verdict, "approved");
    assert.equal(result.decisionLog.strategyAnalyst.thesis, "AAPL has positive momentum with acceptable volatility.");
    assert.equal(result.decisionLog.risk.rationale, "The proposed notional is inside the computed rails.");
    assert.equal(result.decisionLog.execution.rationale, "Submit the approved limit order through the adapter.");
    assert.deepEqual(await decisionLogStore.getDecision(result.decisionLog.id), result.decisionLog);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://paper-api.alpaca.markets/v2/account");
    assert.equal(calls[1]?.url, "https://paper-api.alpaca.markets/v2/positions");
    assert.equal(calls[2]?.url, "https://paper-api.alpaca.markets/v2/orders");
    assert.equal(model.requests.length, 3);
    assert.equal(JSON.stringify(model.requests).includes("paper"), false);
  });

  it("keeps rails and strategy gate structural even if execution tries an unsafe approved order", async () => {
    const { strategy, store } = await activeStrategy();
    const currentPortfolio = portfolio();
    const playbook = buildStrategyQuantPlaybook(strategy, {
      asOf: "2026-06-17T14:30:00Z",
      universe: [{ symbol: "AAPL", sector: "technology" }],
      bars: bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000),
      portfolio: currentPortfolio
    });
    let fetchCalls = 0;
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      orderGuardRails: playbook.rails,
      strategyGate: store,
      fetchFn: async () => {
        fetchCalls += 1;
        return responseJson({});
      }
    });
    const execution = new ExecutionAgent(
      new QueueReasoningModel([{ decision: "place", rationale: "Try to place despite impossible size." }]),
      adapter
    );
    const riskDecision: RiskAgentDecision = {
      approved: true,
      verdict: "approved",
      rationale: "mocked approval",
      deterministicViolations: []
    };

    const result = await execution.execute({
      strategy,
      riskDecision,
      cycleId: "unsafe-cycle",
      analystDecision: {
        thesis: "Malicious oversize proposal.",
        proposedOrder: {
          strategyId: strategy.id,
          symbol: "AAPL",
          qty: 19,
          side: "buy",
          type: "limit",
          timeInForce: "day",
          limitPrice: 110,
          estimatedNotional: 2_090
        }
      }
    });

    assert.equal(result.decision, "rejected");
    assert.match(result.brokerRejection ?? "", /order violates quant guard rails/u);
    assert.equal(fetchCalls, 0);

    const draftStore = new InMemoryStrategyStore();
    const draftStrategy = await draftStore.createStrategy({
      id: "44444444-4444-4444-4444-444444444444",
      name: "Draft cannot trade",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    const draftAdapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      orderGuardRails: playbook.rails,
      strategyGate: draftStore,
      fetchFn: async () => {
        fetchCalls += 1;
        return responseJson({});
      }
    });
    const draftExecution = new ExecutionAgent(
      new QueueReasoningModel([{ decision: "place", rationale: "Try to place before approval." }]),
      draftAdapter
    );

    const draftResult = await draftExecution.execute({
      strategy: draftStrategy,
      riskDecision,
      cycleId: "draft-cycle",
      analystDecision: {
        thesis: "Premature proposal.",
        proposedOrder: {
          strategyId: draftStrategy.id,
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "limit",
          timeInForce: "day",
          limitPrice: 110,
          estimatedNotional: 110
        }
      }
    });

    assert.equal(draftResult.decision, "rejected");
    assert.match(draftResult.brokerRejection ?? "", /only active strategies can trade/u);
    assert.equal(fetchCalls, 0);
  });
});
