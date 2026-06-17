import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type PriceVolumeBar } from "./quant-playbook.js";
import {
  buildStrategyQuantPlaybook,
  getStrategyTradingGateViolation,
  InMemoryStrategyStore,
  StrategyLifecycleError
} from "./strategy.js";

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

describe("Strategy entity", () => {
  it("persists strategy parameters and uses them to build the quant playbook", async () => {
    const store = new InMemoryStrategyStore();
    const strategy = await store.createStrategy({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Single slot momentum",
      parameters: {
        ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
        maxOpenPositions: 1,
        minMomentumFraction: 0.05
      }
    });

    const persisted = await store.getStrategy(strategy.id);
    assert.equal(persisted?.parameters.maxOpenPositions, 1);
    assert.equal(persisted?.parameters.minMomentumFraction, 0.05);

    const playbook = buildStrategyQuantPlaybook(strategy, {
      asOf: "2026-06-17T14:30:00Z",
      universe: [{ symbol: "AAPL", sector: "technology" }],
      bars: bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000),
      portfolio: {
        equity: 20_000,
        cash: 5_000,
        dailyPnl: 100,
        positions: [{ symbol: "MSFT", qty: 1, marketValue: 200, sector: "technology" }]
      }
    });

    assert.equal(playbook.parameters.maxOpenPositions, 1);
    assert.equal(playbook.candidates.length, 0);
    assert.equal(playbook.rails.symbols.AAPL?.maxBuyQty, 0);
  });

  it("requires Draft to be Approved before Active", async () => {
    const store = new InMemoryStrategyStore();
    const strategy = await store.createStrategy({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Approval gated strategy",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });

    await assert.rejects(() => store.activateStrategy(strategy.id), StrategyLifecycleError);
    assert.equal(
      await getStrategyTradingGateViolation(store, strategy.id),
      "strategy 22222222-2222-2222-2222-222222222222 is draft; only active strategies can trade"
    );

    const approved = await store.approveStrategy(strategy.id);
    assert.equal(approved.status, "approved");
    assert.equal(
      await getStrategyTradingGateViolation(store, strategy.id),
      "strategy 22222222-2222-2222-2222-222222222222 is approved; only active strategies can trade"
    );

    const active = await store.activateStrategy(strategy.id);
    assert.equal(active.status, "active");
    assert.equal(await getStrategyTradingGateViolation(store, strategy.id), null);
  });
});
