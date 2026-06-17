import { ALPACA_PAPER_BROKER_ACCOUNT_ID } from "./broker.js";
import { type BrokerCredentialVault } from "./secrets.js";
import { type PriceVolumeBar } from "./quant-playbook.js";

export const ALPACA_MARKET_DATA_BASE_URL = "https://data.alpaca.markets";

export type AlpacaMarketDataFeed = "iex" | "sip";

export type GetDailyBarsOptions = {
  start: string;
  end?: string;
  limit?: number;
};

export interface MarketDataClient {
  getDailyBars(symbols: string[], options: GetDailyBarsOptions): Promise<PriceVolumeBar[]>;
}

export type AlpacaIexMarketDataClientOptions = {
  fetchFn?: typeof fetch;
  feed?: AlpacaMarketDataFeed;
  brokerAccountId?: string;
};

export class AlpacaIexMarketDataClient implements MarketDataClient {
  private readonly fetchFn: typeof fetch;
  private readonly feed: AlpacaMarketDataFeed;
  private readonly brokerAccountId: string;

  constructor(
    private readonly credentialVault: BrokerCredentialVault,
    options: AlpacaIexMarketDataClientOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.feed = options.feed ?? "iex";
    this.brokerAccountId = options.brokerAccountId ?? ALPACA_PAPER_BROKER_ACCOUNT_ID;
  }

  async getDailyBars(symbols: string[], options: GetDailyBarsOptions): Promise<PriceVolumeBar[]> {
    const normalizedSymbols = symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);

    if (normalizedSymbols.length === 0) {
      return [];
    }

    const credentials = await this.credentialVault.getBrokerCredential(this.brokerAccountId);

    if (!credentials) {
      throw new Error(`broker credentials are missing for ${this.brokerAccountId}`);
    }

    const search = new URLSearchParams({
      symbols: normalizedSymbols.join(","),
      timeframe: "1Day",
      start: options.start,
      feed: this.feed,
      adjustment: "raw"
    });

    if (options.end) {
      search.set("end", options.end);
    }

    if (options.limit !== undefined) {
      search.set("limit", options.limit.toString());
    }

    const response = await this.fetchFn(`${ALPACA_MARKET_DATA_BASE_URL}/v2/stocks/bars?${search.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "APCA-API-KEY-ID": credentials.keyId,
        "APCA-API-SECRET-KEY": credentials.secretKey
      }
    });

    if (!response.ok) {
      throw new Error(`Alpaca market data request failed: ${response.status} ${await response.text()}`);
    }

    return parseAlpacaBars(await response.json());
  }
}

function parseAlpacaBars(body: unknown): PriceVolumeBar[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Alpaca bars response must be an object");
  }

  const barsBySymbol = (body as Record<string, unknown>).bars;

  if (!barsBySymbol || typeof barsBySymbol !== "object" || Array.isArray(barsBySymbol)) {
    throw new Error("Alpaca bars response must include bars by symbol");
  }

  const bars: PriceVolumeBar[] = [];

  for (const [symbol, rawBars] of Object.entries(barsBySymbol as Record<string, unknown>)) {
    if (!Array.isArray(rawBars)) {
      throw new Error(`Alpaca bars for ${symbol} must be an array`);
    }

    for (const rawBar of rawBars) {
      bars.push(toPriceVolumeBar(symbol, rawBar));
    }
  }

  return bars.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.timestamp.localeCompare(right.timestamp));
}

function toPriceVolumeBar(symbol: string, rawBar: unknown): PriceVolumeBar {
  if (!rawBar || typeof rawBar !== "object" || Array.isArray(rawBar)) {
    throw new Error(`Alpaca bar for ${symbol} must be an object`);
  }

  const record = rawBar as Record<string, unknown>;

  return {
    symbol: symbol.trim().toUpperCase(),
    timestamp: stringField(record, "t"),
    open: numberField(record, "o"),
    high: numberField(record, "h"),
    low: numberField(record, "l"),
    close: numberField(record, "c"),
    volume: numberField(record, "v")
  };
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

function numberField(record: Record<string, unknown>, name: string): number {
  const value = record[name];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  return value;
}
