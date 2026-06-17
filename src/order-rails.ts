export type GuardRailOrderSide = "buy" | "sell";

export type GuardRailOrder = {
  symbol: string;
  qty: number;
  side: GuardRailOrderSide;
  limitPrice?: number;
  estimatedNotional?: number;
};

export type SymbolOrderRail = {
  symbol: string;
  sector: string;
  lastPrice: number;
  averageDollarVolume: number;
  maxBuyQty: number;
  maxBuyNotional: number;
  maxSellQty: number;
  maxSellNotional: number;
  remainingSectorBuyNotional: number;
};

export type DailyDrawdownRail = {
  maxLossFraction: number;
  currentLossFraction: number;
  triggered: boolean;
};

export type OrderGuardRails = {
  asOf: string;
  equity: number;
  maxOpenPositions: number;
  openSymbols: string[];
  dailyDrawdown: DailyDrawdownRail;
  symbols: Record<string, SymbolOrderRail>;
};

export function getOrderGuardRailViolations(order: GuardRailOrder, rails: OrderGuardRails): string[] {
  const violations: string[] = [];
  const symbol = order.symbol.trim().toUpperCase();
  const rail = rails.symbols[symbol];
  const estimatedNotional = estimateGuardRailOrderNotional(order);

  if (rails.dailyDrawdown.triggered) {
    violations.push(
      `daily drawdown stop is active (${formatPercent(rails.dailyDrawdown.currentLossFraction)} >= ${formatPercent(
        rails.dailyDrawdown.maxLossFraction
      )})`
    );
  }

  if (!rail) {
    violations.push(`${symbol || "order symbol"} is outside the playbook universe`);
    return violations;
  }

  if (estimatedNotional === null || !Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
    violations.push("order estimated notional is required for guard rails");
    return violations;
  }

  if (!Number.isFinite(order.qty) || order.qty <= 0) {
    violations.push("order quantity must be positive");
    return violations;
  }

  if (order.side === "buy") {
    if (!rails.openSymbols.includes(symbol) && rails.openSymbols.length >= rails.maxOpenPositions) {
      violations.push(`max open positions limit ${rails.maxOpenPositions} is reached`);
    }

    if (order.qty > rail.maxBuyQty) {
      violations.push(`buy quantity ${order.qty} exceeds max buy quantity ${rail.maxBuyQty} for ${symbol}`);
    }

    if (estimatedNotional > rail.maxBuyNotional) {
      violations.push(
        `buy notional ${estimatedNotional.toFixed(2)} exceeds max buy notional ${rail.maxBuyNotional.toFixed(2)} for ${symbol}`
      );
    }

    if (estimatedNotional > rail.remainingSectorBuyNotional) {
      violations.push(
        `buy notional ${estimatedNotional.toFixed(2)} exceeds remaining ${rail.sector} sector capacity ${rail.remainingSectorBuyNotional.toFixed(
          2
        )}`
      );
    }
  } else {
    if (order.qty > rail.maxSellQty) {
      violations.push(`sell quantity ${order.qty} exceeds max sell quantity ${rail.maxSellQty} for ${symbol}`);
    }

    if (estimatedNotional > rail.maxSellNotional) {
      violations.push(
        `sell notional ${estimatedNotional.toFixed(2)} exceeds max sell notional ${rail.maxSellNotional.toFixed(2)} for ${symbol}`
      );
    }
  }

  return violations;
}

function estimateGuardRailOrderNotional(order: GuardRailOrder): number | null {
  if (order.estimatedNotional !== undefined) {
    return order.estimatedNotional;
  }

  if (order.limitPrice !== undefined) {
    return order.qty * order.limitPrice;
  }

  return null;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
