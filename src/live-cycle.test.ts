import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  ALPACA_PAPER_CREDENTIAL_FILE,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerFill,
  type BrokerFillStreamOptions,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerPosition
} from "./broker.js";
import { InMemoryAgentDecisionLogStore } from "./agent-team.js";
import { LLM_OAUTH_CREDENTIAL_FILE, type LlmJsonRequest, type ReasoningModel } from "./llm.js";
import { type GetDailyBarsOptions, type MarketDataClient } from "./market-data.js";
import { type PriceVolumeBar } from "./quant-playbook.js";
import { runLiveTradeCycle } from "./live-cycle.js";

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

class StaticMarketDataClient implements MarketDataClient {
  readonly calls: { symbols: string[]; options: GetDailyBarsOptions }[] = [];

  constructor(private readonly bars: PriceVolumeBar[]) {}

  async getDailyBars(symbols: string[], options: GetDailyBarsOptions): Promise<PriceVolumeBar[]> {
    this.calls.push({ symbols, options });
    return this.bars;
  }
}

class RecordingBrokerAdapter implements BrokerAdapter {
  readonly orders: BrokerOrderRequest[] = [];

  async getAccount(): Promise<BrokerAccount> {
    return {
      id: "account-1",
      status: "ACTIVE",
      currency: "USD",
      cash: "5000",
      buyingPower: "10000",
      portfolioValue: "20000"
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [];
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrder> {
    this.orders.push(order);
    return {
      id: "order-1",
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      qty: order.qty.toString(),
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      status: "accepted"
    };
  }

  async cancelOrder(): Promise<void> {}

  async *streamFills(_options?: BrokerFillStreamOptions): AsyncIterable<BrokerFill> {}
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("live trade cycle composition root", () => {
  it("wires market data, strategy, agents, broker, and decision log into one cycle", async () => {
    const marketData = new StaticMarketDataClient(bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000));
    const broker = new RecordingBrokerAdapter();
    const model = new QueueReasoningModel([
      { thesis: "AAPL is the top deterministic live-cycle candidate.", symbol: "AAPL", qty: 1, limitPrice: 110 },
      { verdict: "approved", rationale: "One share is inside the active strategy rails." },
      { decision: "place", rationale: "Place the active-strategy order through the adapter." }
    ]);
    const decisionLogStore = new InMemoryAgentDecisionLogStore();

    const result = await runLiveTradeCycle({
      cycleId: "live-a-test",
      now: () => new Date("2026-06-17T14:30:00Z"),
      marketDataClient: marketData,
      broker,
      model,
      decisionLogStore
    });

    assert.equal(result.execution.decision, "placed");
    assert.equal(result.execution.order?.clientOrderId, "atp-live-a-test");
    assert.equal(result.quantSignal.symbol, "AAPL");
    assert.equal(result.risk.verdict, "approved");
    assert.equal(result.strategy.status, "active");
    assert.equal(result.playbook.candidates[0]?.sizing.maxQty, 1);
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0]?.qty, 1);
    assert.deepEqual(marketData.calls[0]?.symbols, ["AAPL"]);
    assert.deepEqual(await decisionLogStore.getDecision(result.decisionLog.id), result.decisionLog);
    assert.equal(model.requests.length, 3);
    assert.equal(JSON.stringify(model.requests).includes("paper"), false);
  });
});

describe("live trade cycle integration", async () => {
  const hasBrokerCredential = await fileExists(ALPACA_PAPER_CREDENTIAL_FILE);
  const hasOauthCredential = await fileExists(LLM_OAUTH_CREDENTIAL_FILE);
  const skipReason = !hasBrokerCredential
    ? `${ALPACA_PAPER_CREDENTIAL_FILE} is not mounted`
    : !hasOauthCredential
      ? `${LLM_OAUTH_CREDENTIAL_FILE} is not mounted`
      : false;

  it(
    "runs one real OpenAI-OAuth reasoned cycle into one Alpaca paper order when credentials are mounted",
    { skip: skipReason, timeout: 180_000 },
    async () => {
      const result = await runLiveTradeCycle();
      const order = result.execution.order;

      assert.equal(result.execution.decision, "placed");
      assert.ok(order, "live execution should return a broker order");
      assert.equal(order.id.length > 0, true);
      assert.equal(order.qty, "1");
      assert.match(order.status, /^(accepted|pending_new|new)$/u);
      assert.equal(result.decisionLog.quantSignal.symbol, result.quantSignal.symbol);
      assert.equal(result.decisionLog.strategyAnalyst.thesis.length > 0, true);
      assert.equal(result.decisionLog.risk.rationale.length > 0, true);
      assert.equal(result.decisionLog.execution.rationale.length > 0, true);

      console.log(
        JSON.stringify({
          smoke: "live-trade-cycle",
          orderId: order.id,
          orderStatus: order.status,
          clientOrderId: order.clientOrderId,
          decisionLogId: result.decisionLog.id,
          strategyAnalystVerdict: `proposed ${result.strategyAnalyst.proposedOrder.qty} ${result.strategyAnalyst.proposedOrder.symbol}`,
          riskVerdict: result.risk.verdict,
          executionVerdict: result.execution.decision
        })
      );
    }
  );
});
