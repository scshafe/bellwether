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

export type QuantPlaybookParameterKey = keyof QuantPlaybookParameters;

export const quantPlaybookParameterKeys: QuantPlaybookParameterKey[] = [
  "minPrice",
  "minAverageDollarVolume",
  "signalLookbackBars",
  "minMomentumFraction",
  "maxVolatilityFraction",
  "volatilityPenalty",
  "maxPositionNotional",
  "maxPositionEquityFraction",
  "maxSectorEquityFraction",
  "maxLiquidityParticipationFraction",
  "maxOpenPositions",
  "dailyDrawdownStopFraction"
];

// Mirrors the engine's DEFAULT_QUANT_PLAYBOOK_PARAMETERS so create/edit forms start from deployed defaults.
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
