import { ALPACA_PAPER_BROKER_ACCOUNT_ID } from "./broker.js";
import { type BrokerCredentialVault } from "./secrets.js";

const alpacaPaperBaseUrl = "https://paper-api.alpaca.markets";
const defaultMarketClockTtlMs = 45_000;

export type MarketClockSnapshot = {
  timestamp: string;
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
};

export type GetMarketClockOptions = {
  forceRefresh?: boolean;
};

export interface MarketClock {
  getClock(options?: GetMarketClockOptions): Promise<MarketClockSnapshot>;
}

export type AlpacaMarketClockOptions = {
  fetchFn?: typeof fetch;
  brokerAccountId?: string;
  ttlMs?: number;
  nowMs?: () => number;
};

export class AlpacaMarketClock implements MarketClock {
  private readonly fetchFn: typeof fetch;
  private readonly brokerAccountId: string;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private cachedClock: { snapshot: MarketClockSnapshot; expiresAtMs: number } | null = null;

  constructor(
    private readonly credentialVault: BrokerCredentialVault,
    options: AlpacaMarketClockOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.brokerAccountId = options.brokerAccountId ?? ALPACA_PAPER_BROKER_ACCOUNT_ID;
    this.ttlMs = options.ttlMs ?? defaultMarketClockTtlMs;
    this.nowMs = options.nowMs ?? Date.now;

    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("market clock ttlMs must be a positive number");
    }
  }

  async getClock(options: GetMarketClockOptions = {}): Promise<MarketClockSnapshot> {
    const now = this.nowMs();

    if (!options.forceRefresh && this.cachedClock && now < this.cachedClock.expiresAtMs) {
      return this.cachedClock.snapshot;
    }

    const snapshot = await this.fetchClock();
    this.cachedClock = { snapshot, expiresAtMs: now + this.ttlMs };
    return snapshot;
  }

  private async fetchClock(): Promise<MarketClockSnapshot> {
    const credentials = await this.credentialVault.getBrokerCredential(this.brokerAccountId);

    if (!credentials) {
      throw new Error(`broker credentials are missing for ${this.brokerAccountId}`);
    }

    const response = await this.fetchFn(`${alpacaPaperBaseUrl}/v2/clock`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "APCA-API-KEY-ID": credentials.keyId,
        "APCA-API-SECRET-KEY": credentials.secretKey
      }
    });

    if (!response.ok) {
      throw new Error(`Alpaca paper clock request failed: ${response.status} ${await response.text()}`);
    }

    return parseAlpacaClock(await response.json());
  }
}

export function createAlpacaMarketClock(
  credentialVault: BrokerCredentialVault,
  options: AlpacaMarketClockOptions = {}
): MarketClock {
  return new AlpacaMarketClock(credentialVault, options);
}

function parseAlpacaClock(body: unknown): MarketClockSnapshot {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Alpaca clock response must be an object");
  }

  const record = body as Record<string, unknown>;

  return {
    timestamp: stringField(record, "timestamp"),
    isOpen: booleanField(record, "is_open"),
    nextOpen: stringField(record, "next_open"),
    nextClose: stringField(record, "next_close")
  };
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

function booleanField(record: Record<string, unknown>, name: string): boolean {
  const value = record[name];

  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }

  return value;
}
