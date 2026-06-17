import {
  ALPACA_PAPER_BROKER_ACCOUNT_ID,
  AlpacaPaperAdapter,
  createAlpacaPaperSecretsStore,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerPosition
} from "./broker.js";
import {
  ensureAgentDecisionLogSchema,
  PostgresAgentDecisionLogStore,
  runMinimalAgentTeamTrade,
  type AgentDecisionLogStore,
  type AgentTeamTradeCycleResult,
  type PortalQualitativeEvidence
} from "./agent-team.js";
import type { Pool } from "pg";
import { createPool } from "./db.js";
import {
  AlpacaIexMarketDataClient,
  type MarketDataClient
} from "./market-data.js";
import {
  DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
  type PortfolioSnapshot,
  type PriceVolumeBar,
  type QuantPlaybook,
  type QuantPlaybookParameters,
  type UniverseAsset
} from "./quant-playbook.js";
import { SecretsBackedBrokerCredentialVault } from "./secrets.js";
import {
  buildStrategyQuantPlaybook,
  InMemoryStrategyStore,
  type StrategyRecord,
  type StrategyStore,
  type StrategyTradingGate
} from "./strategy.js";
import {
  createOpenAiOAuthSecretsStore,
  createReasoningModel,
  OPENAI_OAUTH_PROVIDER_ID,
  SecretsBackedLlmCredentialVault,
  type LlmJsonRequest,
  type ReasoningModel
} from "./llm.js";
import { PostgresQualitativeItemsStore, type QualitativeItemsStore } from "./qualitative.js";
import { emptyQualitativeEvidence, QualitativeBriefService } from "./qualitative-brief.js";

const liveCycleUniverse: UniverseAsset[] = [{ symbol: "AAPL", sector: "technology" }];
const liveCycleStrategyId = "55555555-5555-5555-5555-555555555555";
const lookbackDays = 30;

export type LiveTradeCycleStrategyStore = StrategyStore & StrategyTradingGate;

export type RunLiveTradeCycleOptions = {
  now?: () => Date;
  cycleId?: string;
  universe?: UniverseAsset[];
  marketDataClient?: MarketDataClient;
  broker?: BrokerAdapter;
  model?: ReasoningModel;
  decisionLogStore?: AgentDecisionLogStore;
  pool?: Pool;
  databaseUrl?: string;
  strategyStore?: LiveTradeCycleStrategyStore;
  brokerCredentialFile?: string;
  oauthCredentialFile?: string;
  fetchFn?: typeof fetch;
  qualitativeItemsStore?: QualitativeItemsStore;
};

export type LiveTradeCycleResult = AgentTeamTradeCycleResult & {
  strategy: StrategyRecord;
  playbook: QuantPlaybook;
  portfolio: PortfolioSnapshot;
  qualitativeBrief?: PortalQualitativeEvidence;
};

export async function runLiveTradeCycle(options: RunLiveTradeCycleOptions = {}): Promise<LiveTradeCycleResult> {
  const now = options.now?.() ?? new Date();
  const cycleId = options.cycleId ?? defaultLiveCycleId(now);
  const universe = options.universe ?? liveCycleUniverse;
  const pool = options.decisionLogStore ? null : options.pool ?? createPool(options.databaseUrl);
  const shouldClosePool = Boolean(pool && !options.pool);

  try {
    if (pool) {
      await ensureAgentDecisionLogSchema(pool);
    }

    const brokerCredentialVault = options.marketDataClient && options.broker
      ? null
      : new SecretsBackedBrokerCredentialVault(await createAlpacaPaperSecretsStore({ filePath: options.brokerCredentialFile }));
    const marketDataClient = options.marketDataClient ?? new AlpacaIexMarketDataClient(requiredBrokerCredentialVault(brokerCredentialVault), { fetchFn: options.fetchFn });
    const strategyStore = options.strategyStore ?? new InMemoryStrategyStore();
    let playbook: QuantPlaybook | null = null;
    const broker = options.broker ?? new AlpacaPaperAdapter(requiredBrokerCredentialVault(brokerCredentialVault), ALPACA_PAPER_BROKER_ACCOUNT_ID, {
      fetchFn: options.fetchFn,
      strategyGate: strategyStore,
      orderGuardRails: () => {
        if (!playbook) {
          throw new Error("live trade cycle guard rails are not ready");
        }

        return playbook.rails;
      }
    });
    const account = await broker.getAccount();
    const positions = await broker.getPositions();
    const portfolio = brokerSnapshotToPortfolio(account, positions, universe);
    const bars = await marketDataClient.getDailyBars(universe.map((asset) => asset.symbol), {
      start: formatIsoDate(new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)),
      end: formatIsoDate(now),
      limit: 20
    });
    const strategy = await createActiveLiveStrategy(strategyStore, buildLiveCycleParameters(universe, bars));
    playbook = buildStrategyQuantPlaybook(strategy, {
      asOf: now.toISOString(),
      universe,
      bars,
      portfolio
    });

    if (playbook.candidates.length === 0) {
      throw new Error("live trade cycle requires at least one quant candidate from live market data");
    }

    const model = options.model ?? withLiveCycleSchemaHints(createReasoningModel(
      new SecretsBackedLlmCredentialVault(await createOpenAiOAuthSecretsStore({ filePath: options.oauthCredentialFile })),
      { providerId: OPENAI_OAUTH_PROVIDER_ID, fetchFn: options.fetchFn }
    ));
    const qualitativeItemsStore = options.qualitativeItemsStore ?? (pool ? new PostgresQualitativeItemsStore(pool) : null);
    const qualitativeBrief = qualitativeItemsStore
      ? await new QualitativeBriefService().buildBrief({
        strategy,
        tickers: [...universe.map((asset) => asset.symbol), ...playbook.candidates.map((candidate) => candidate.symbol)],
        itemsStore: qualitativeItemsStore,
        model
      })
      : emptyQualitativeEvidence();

    const decisionLogStore = options.decisionLogStore ?? new PostgresAgentDecisionLogStore(requiredPool(pool));
    const result = await runMinimalAgentTeamTrade({
      strategy,
      playbook,
      portfolio,
      broker,
      model,
      decisionLogStore,
      cycleId,
      qualitativeBrief
    });

    return {
      ...result,
      strategy,
      playbook,
      portfolio,
      qualitativeBrief
    };
  } finally {
    if (shouldClosePool) {
      await pool?.end();
    }
  }
}

function defaultLiveCycleId(now: Date): string {
  return `live-a-${formatIsoDate(now)}`;
}

function withLiveCycleSchemaHints(model: ReasoningModel): ReasoningModel {
  return {
    generateJson: (request) => model.generateJson({
      ...request,
      systemPrompt: `${request.systemPrompt}\n\n${liveCycleSchemaHint(request)}`
    })
  };
}

function liveCycleSchemaHint(request: LlmJsonRequest): string {
  if (request.schemaName === "strategy_analyst_decision") {
    return "Schema: return exactly {\"thesis\": string, \"symbol\": \"AAPL\", \"qty\": 1, \"limitPrice\": number}. Keep symbol, qty, and limitPrice as top-level keys. Use a limitPrice no higher than the supplied quantCandidate.sizing.maxNotional for the one-share order.";
  }

  if (request.schemaName === "risk_agent_verdict") {
    return "Schema: return exactly {\"verdict\": \"approved\" | \"rejected\", \"rationale\": string}. Keep verdict and rationale as top-level keys.";
  }

  if (request.schemaName === "execution_agent_decision") {
    return "Schema: return exactly {\"decision\": \"place\" | \"skip\", \"rationale\": string}. Keep decision and rationale as top-level keys.";
  }

  if (request.schemaName === "qualitative_brief") {
    return "Schema: return exactly {\"links\":[{\"href\": string, \"title\": string, \"source\"?: string}], \"quotes\":[{\"quote\": string, \"source\": string, \"href\"?: string}], \"signals\":[{\"label\": string, \"value\": string, \"source\"?: string}]}. Quotes must be copied from supplied excerpts only.";
  }

  return "Return only a single JSON object with the exact top-level fields required by the named schema.";
}

function requiredBrokerCredentialVault(vault: SecretsBackedBrokerCredentialVault | null): SecretsBackedBrokerCredentialVault {
  if (!vault) {
    throw new Error("broker credential vault is required for default live trade cycle seams");
  }

  return vault;
}

function requiredPool(pool: Pool | null): Pool {
  if (!pool) {
    throw new Error("Postgres pool is required for the default live decision log store");
  }

  return pool;
}

async function createActiveLiveStrategy(
  strategyStore: LiveTradeCycleStrategyStore,
  parameters: QuantPlaybookParameters
): Promise<StrategyRecord> {
  const strategy = await strategyStore.createStrategy({
    id: liveCycleStrategyId,
    name: "Live-A one-share momentum",
    description:
      "Pre-approved live-A strategy: choose the top deterministic candidate, propose exactly 1 share, and use a limit price no higher than candidate sizing.maxNotional.",
    parameters
  });

  await strategyStore.approveStrategy(strategy.id);
  return strategyStore.activateStrategy(strategy.id);
}

function buildLiveCycleParameters(universe: UniverseAsset[], bars: PriceVolumeBar[]): QuantPlaybookParameters {
  const latestPrices = universe
    .map((asset) => latestCloseForSymbol(asset.symbol, bars))
    .filter((price): price is number => price !== null && price > 0);

  if (latestPrices.length === 0) {
    throw new Error("live trade cycle market data did not include a latest price for the universe");
  }

  const oneShareNotional = Math.min(...latestPrices) * 1.01;

  return {
    ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
    minPrice: 1,
    minAverageDollarVolume: 100_000,
    signalLookbackBars: 5,
    minMomentumFraction: -1,
    maxVolatilityFraction: 1,
    volatilityPenalty: 0.1,
    maxPositionNotional: oneShareNotional,
    maxPositionEquityFraction: 0.05,
    maxSectorEquityFraction: 1,
    maxLiquidityParticipationFraction: 0.01,
    maxOpenPositions: 50,
    dailyDrawdownStopFraction: 0.99
  };
}

function latestCloseForSymbol(symbol: string, bars: PriceVolumeBar[]): number | null {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const sortedBars = bars
    .filter((bar) => bar.symbol.trim().toUpperCase() === normalizedSymbol)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  return sortedBars.at(-1)?.close ?? null;
}

function brokerSnapshotToPortfolio(
  account: BrokerAccount,
  positions: BrokerPosition[],
  universe: UniverseAsset[]
): PortfolioSnapshot {
  const sectorsBySymbol = Object.fromEntries(universe.map((asset) => [asset.symbol.trim().toUpperCase(), asset.sector]));

  return {
    equity: numberFromBrokerString(account.portfolioValue, "portfolioValue"),
    cash: numberFromBrokerString(account.cash, "cash"),
    dailyPnl: numberFromBrokerString(account.dailyPnl, "dailyPnl"),
    positions: positions.map((position) => ({
      symbol: position.symbol,
      qty: numberFromBrokerString(position.qty, `${position.symbol} qty`),
      marketValue: numberFromBrokerString(position.marketValue, `${position.symbol} marketValue`),
      sector: sectorsBySymbol[position.symbol.trim().toUpperCase()] ?? "unknown"
    }))
  };
}

function numberFromBrokerString(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`broker ${name} must be numeric`);
  }

  return parsed;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
