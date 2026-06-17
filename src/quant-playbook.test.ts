import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getOrderGuardRailViolations } from "./order-rails.js";
import { buildQuantPlaybook, type PriceVolumeBar } from "./quant-playbook.js";

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

describe("Quant Playbook Engine", () => {
  it("emits deterministic universe screens, signals, candidate sizing, and rails", () => {
    const playbook = buildQuantPlaybook({
      asOf: "2026-06-17T14:30:00Z",
      universe: [
        { symbol: "aapl", sector: "technology" },
        { symbol: "msft", sector: "technology" },
        { symbol: "penny", sector: "speculative" },
        { symbol: "thin", sector: "industrial" }
      ],
      bars: [
        ...bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000),
        ...bars("MSFT", [200, 199, 201, 198, 202, 200], 20_000),
        ...bars("PENNY", [2, 2.1, 2.2, 2.3, 2.4, 2.5], 1_000_000),
        ...bars("THIN", [50, 51, 52, 53, 54, 55], 100)
      ],
      portfolio: {
        equity: 20_000,
        cash: 5_000,
        dailyPnl: 100,
        positions: [{ symbol: "QQQ", qty: 10, marketValue: 5_500, sector: "technology" }]
      }
    });

    assert.deepEqual(
      playbook.screenedUniverse.map((asset) => [asset.symbol, asset.passed]),
      [
        ["AAPL", true],
        ["MSFT", true],
        ["PENNY", false],
        ["THIN", false]
      ]
    );
    assert.equal(playbook.screenedUniverse.find((asset) => asset.symbol === "PENNY")?.rejectReasons[0]?.includes("last price"), true);
    assert.equal(playbook.screenedUniverse.find((asset) => asset.symbol === "THIN")?.rejectReasons[0]?.includes("average dollar volume"), true);

    const aapl = playbook.screenedUniverse.find((asset) => asset.symbol === "AAPL");
    assert.ok(aapl);
    assert.equal(aapl.signals.momentumFraction > 0.09, true);
    assert.equal(aapl.signals.volatilityFraction < 0.01, true);
    assert.equal(aapl.signals.averageDollarVolume > 2_000_000, true);

    assert.equal(playbook.candidates[0]?.symbol, "AAPL");
    assert.deepEqual(playbook.candidates[0]?.sizing, { maxQty: 4, maxNotional: 440 });
    assert.equal(playbook.rails.symbols.AAPL?.maxBuyQty, 4);
    assert.equal(playbook.rails.symbols.AAPL?.remainingSectorBuyNotional, 500);
    assert.equal(playbook.rails.dailyDrawdown.triggered, false);
  });

  it("keeps the action space and guard rails closed when portfolio stops are hit", () => {
    const playbook = buildQuantPlaybook({
      asOf: "2026-06-17T14:30:00Z",
      universe: [{ symbol: "AAPL", sector: "technology" }],
      bars: bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000),
      portfolio: {
        equity: 20_000,
        cash: 5_000,
        dailyPnl: -700,
        positions: []
      }
    });

    assert.equal(playbook.rails.dailyDrawdown.triggered, true);
    assert.equal(playbook.candidates.length, 0);
    assert.deepEqual(getOrderGuardRailViolations({ symbol: "AAPL", qty: 1, side: "buy", limitPrice: 110 }, playbook.rails), [
      "daily drawdown stop is active (3.50% >= 3.00%)",
      "buy quantity 1 exceeds max buy quantity 0 for AAPL",
      "buy notional 110.00 exceeds max buy notional 0.00 for AAPL"
    ]);
  });

  it("blocks new candidates when max open positions is reached", () => {
    const playbook = buildQuantPlaybook({
      asOf: "2026-06-17T14:30:00Z",
      universe: [{ symbol: "AAPL", sector: "technology" }],
      bars: bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000),
      portfolio: {
        equity: 20_000,
        cash: 5_000,
        dailyPnl: 100,
        positions: [{ symbol: "MSFT", qty: 1, marketValue: 200, sector: "technology" }]
      },
      parameters: { maxOpenPositions: 1 }
    });

    assert.equal(playbook.candidates.length, 0);
    assert.equal(playbook.rails.symbols.AAPL?.maxBuyQty, 0);
    assert.equal(
      getOrderGuardRailViolations({ symbol: "AAPL", qty: 1, side: "buy", limitPrice: 110 }, playbook.rails).includes(
        "max open positions limit 1 is reached"
      ),
      true
    );
  });
});
