import { type OrderGuardRails, type SymbolOrderRail } from "./order-rails.js";

export type PriceVolumeBar = {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type UniverseAsset = {
  symbol: string;
  sector?: string;
};

export type PortfolioPosition = {
  symbol: string;
  qty: number;
  marketValue: number;
  sector?: string;
};

export type PortfolioSnapshot = {
  equity: number;
  cash: number;
  dailyPnl: number;
  positions: PortfolioPosition[];
};

export type QuantPlaybookParameters = {
  minPrice: number;
  minAverageDollarVolume: number;
  signalLookbackBars: number;
  minMomentumFraction: number;
  maxVolatilityFraction: number;
  volatilityPenalty: number;
  maxPositionNotional: number;
  maxPositionEquityFraction: number;
  maxSectorEquityFraction: number;
  maxLiquidityParticipationFraction: number;
  maxOpenPositions: number;
  dailyDrawdownStopFraction: number;
};

export type QuantPlaybookInput = {
  asOf: string;
  universe: UniverseAsset[];
  bars: PriceVolumeBar[];
  portfolio: PortfolioSnapshot;
  parameters?: Partial<QuantPlaybookParameters>;
};

export type QuantSignalSet = {
  momentumFraction: number;
  volatilityFraction: number;
  averageDollarVolume: number;
  score: number;
};

export type ScreenedAsset = UniverseAsset & {
  lastPrice: number;
  passed: boolean;
  rejectReasons: string[];
  signals: QuantSignalSet;
};

export type CandidateAction = {
  symbol: string;
  sector: string;
  side: "buy";
  score: number;
  signals: QuantSignalSet;
  sizing: {
    maxQty: number;
    maxNotional: number;
  };
};

export type QuantPlaybook = {
  asOf: string;
  parameters: QuantPlaybookParameters;
  screenedUniverse: ScreenedAsset[];
  candidates: CandidateAction[];
  rails: OrderGuardRails;
};

export const DEFAULT_QUANT_PLAYBOOK_PARAMETERS: QuantPlaybookParameters = {
  minPrice: 5,
  minAverageDollarVolume: 1_000_000,
  signalLookbackBars: 5,
  minMomentumFraction: 0.01,
  maxVolatilityFraction: 0.08,
  volatilityPenalty: 0.5,
  maxPositionNotional: 2_000,
  maxPositionEquityFraction: 0.1,
  maxSectorEquityFraction: 0.3,
  maxLiquidityParticipationFraction: 0.01,
  maxOpenPositions: 5,
  dailyDrawdownStopFraction: 0.03
};

export function buildQuantPlaybook(input: QuantPlaybookInput): QuantPlaybook {
  const parameters = { ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS, ...input.parameters };
  const barsBySymbol = groupBarsBySymbol(input.bars);
  const positionsBySymbol = groupPositionsBySymbol(input.portfolio.positions);
  const openSymbols = input.portfolio.positions
    .filter((position) => position.qty > 0)
    .map((position) => position.symbol.trim().toUpperCase());
  const sectorExposure = calculateSectorExposure(input.portfolio.positions);
  const dailyLossFraction = input.portfolio.equity > 0 ? Math.max(0, -input.portfolio.dailyPnl / input.portfolio.equity) : 1;
  const dailyDrawdownTriggered = dailyLossFraction >= parameters.dailyDrawdownStopFraction;
  const screenedUniverse = input.universe.map((asset) => screenAsset(asset, barsBySymbol, parameters));
  const symbols: Record<string, SymbolOrderRail> = {};
  const candidates: CandidateAction[] = [];

  for (const asset of screenedUniverse) {
    const symbol = normalizeSymbol(asset.symbol);
    const sector = asset.sector ?? "unknown";
    const position = positionsBySymbol[symbol];
    const currentPositionNotional = position?.marketValue ?? 0;
    const remainingPositionNotional = Math.max(
      0,
      Math.min(parameters.maxPositionNotional, input.portfolio.equity * parameters.maxPositionEquityFraction) -
        currentPositionNotional
    );
    const remainingSectorBuyNotional = Math.max(
      0,
      input.portfolio.equity * parameters.maxSectorEquityFraction - (sectorExposure[sector] ?? 0)
    );
    const liquidityBoundNotional = asset.signals.averageDollarVolume * parameters.maxLiquidityParticipationFraction;
    const maxOpenPositionsReached = !openSymbols.includes(symbol) && openSymbols.length >= parameters.maxOpenPositions;
    const maxBuyNotional = asset.passed && !dailyDrawdownTriggered && !maxOpenPositionsReached
      ? Math.max(0, Math.min(remainingPositionNotional, remainingSectorBuyNotional, liquidityBoundNotional, input.portfolio.cash))
      : 0;
    const maxBuyQty = Math.floor(maxBuyNotional / asset.lastPrice);
    const maxSellQty = position?.qty ?? 0;
    const maxSellNotional = maxSellQty * asset.lastPrice;

    symbols[symbol] = {
      symbol,
      sector,
      lastPrice: asset.lastPrice,
      averageDollarVolume: asset.signals.averageDollarVolume,
      maxBuyQty,
      maxBuyNotional: maxBuyQty * asset.lastPrice,
      maxSellQty,
      maxSellNotional,
      remainingSectorBuyNotional
    };

    if (asset.passed && maxBuyQty > 0 && asset.signals.momentumFraction >= parameters.minMomentumFraction) {
      candidates.push({
        symbol,
        sector,
        side: "buy",
        score: asset.signals.score,
        signals: asset.signals,
        sizing: {
          maxQty: maxBuyQty,
          maxNotional: maxBuyQty * asset.lastPrice
        }
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));

  return {
    asOf: input.asOf,
    parameters,
    screenedUniverse,
    candidates,
    rails: {
      asOf: input.asOf,
      equity: input.portfolio.equity,
      maxOpenPositions: parameters.maxOpenPositions,
      openSymbols,
      dailyDrawdown: {
        maxLossFraction: parameters.dailyDrawdownStopFraction,
        currentLossFraction: dailyLossFraction,
        triggered: dailyDrawdownTriggered
      },
      symbols
    }
  };
}

function screenAsset(
  asset: UniverseAsset,
  barsBySymbol: Record<string, PriceVolumeBar[]>,
  parameters: QuantPlaybookParameters
): ScreenedAsset {
  const symbol = normalizeSymbol(asset.symbol);
  const bars = barsBySymbol[symbol] ?? [];
  const rejectReasons: string[] = [];
  const requiredBars = parameters.signalLookbackBars + 1;

  if (bars.length < requiredBars) {
    rejectReasons.push(`requires at least ${requiredBars} bars`);
  }

  const signalBars = bars.slice(-requiredBars);
  const latest = signalBars.at(-1);
  const first = signalBars.at(0);
  const averageDollarVolume = signalBars.length > 0
    ? average(signalBars.map((bar) => bar.close * bar.volume))
    : 0;
  const momentumFraction = latest && first ? latest.close / first.close - 1 : 0;
  const volatilityFraction = calculateVolatility(signalBars);
  const score = momentumFraction - volatilityFraction * parameters.volatilityPenalty;

  if (latest && latest.close < parameters.minPrice) {
    rejectReasons.push(`last price ${latest.close} is below ${parameters.minPrice}`);
  }

  if (averageDollarVolume < parameters.minAverageDollarVolume) {
    rejectReasons.push(`average dollar volume ${averageDollarVolume.toFixed(2)} is below ${parameters.minAverageDollarVolume}`);
  }

  if (volatilityFraction > parameters.maxVolatilityFraction) {
    rejectReasons.push(`volatility ${volatilityFraction.toFixed(4)} exceeds ${parameters.maxVolatilityFraction}`);
  }

  return {
    symbol,
    sector: asset.sector,
    lastPrice: latest?.close ?? 0,
    passed: rejectReasons.length === 0,
    rejectReasons,
    signals: {
      momentumFraction,
      volatilityFraction,
      averageDollarVolume,
      score
    }
  };
}

function groupBarsBySymbol(bars: PriceVolumeBar[]): Record<string, PriceVolumeBar[]> {
  const grouped: Record<string, PriceVolumeBar[]> = {};

  for (const bar of bars) {
    const symbol = normalizeSymbol(bar.symbol);
    grouped[symbol] ??= [];
    grouped[symbol].push({ ...bar, symbol });
  }

  for (const symbol of Object.keys(grouped)) {
    grouped[symbol].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  return grouped;
}

function groupPositionsBySymbol(positions: PortfolioPosition[]): Record<string, PortfolioPosition> {
  const grouped: Record<string, PortfolioPosition> = {};

  for (const position of positions) {
    grouped[normalizeSymbol(position.symbol)] = position;
  }

  return grouped;
}

function calculateSectorExposure(positions: PortfolioPosition[]): Record<string, number> {
  const exposure: Record<string, number> = {};

  for (const position of positions) {
    const sector = position.sector ?? "unknown";
    exposure[sector] = (exposure[sector] ?? 0) + Math.max(0, position.marketValue);
  }

  return exposure;
}

function calculateVolatility(bars: PriceVolumeBar[]): number {
  if (bars.length < 2) {
    return 0;
  }

  const returns: number[] = [];

  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];

    if (previous.close > 0) {
      returns.push(current.close / previous.close - 1);
    }
  }

  if (returns.length === 0) {
    return 0;
  }

  const mean = average(returns);
  const variance = average(returns.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}
