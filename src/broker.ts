import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { requireConfigValue } from "./config.js";
import { getOrderGuardRailViolations, type OrderGuardRails } from "./order-rails.js";
import { InMemorySecretsStore, type BrokerCredentialVault, type SecretsStore } from "./secrets.js";
import { getStrategyTradingGateViolation, type StrategyTradingGate } from "./strategy.js";

export const ALPACA_PAPER_BROKER_ACCOUNT_ID = "alpaca-paper";
export const ALPACA_PAPER_CREDENTIAL_FILE = "/srv/bellwether/alpaca-paper.env";

const alpacaPaperBaseUrl = "https://paper-api.alpaca.markets";
const defaultMaxEstimatedNotional = 10_000;

export type BrokerAccount = {
  id: string;
  status: string;
  currency: string;
  cash: string;
  buyingPower: string;
  portfolioValue: string;
  equity: string;
  lastEquity: string;
  dailyPnl: string;
};

export type BrokerPosition = {
  symbol: string;
  qty: string;
  marketValue: string;
  avgEntryPrice: string;
  unrealizedPl: string;
  unrealizedPlpc?: string;
};

export type BrokerOrderSide = "buy" | "sell";
export type BrokerOrderType = "market" | "limit";
export type BrokerTimeInForce = "day" | "gtc";

export type BrokerOrderRequest = {
  symbol: string;
  qty: number;
  side: BrokerOrderSide;
  type: BrokerOrderType;
  timeInForce: BrokerTimeInForce;
  strategyId?: string;
  limitPrice?: number;
  estimatedNotional?: number;
  clientOrderId?: string;
};

export type BrokerOrder = {
  id: string;
  clientOrderId?: string;
  symbol: string;
  qty: string;
  side: BrokerOrderSide;
  type: BrokerOrderType;
  timeInForce: BrokerTimeInForce;
  status: string;
};

export type BrokerFill = {
  id: string;
  orderId: string;
  symbol: string;
  qty: string;
  price: string;
  side: BrokerOrderSide;
  transactionTime: string;
};

export type BrokerFillStreamOptions = {
  signal?: AbortSignal;
  pollIntervalMs?: number;
};

export interface BrokerAdapter {
  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<BrokerPosition[]>;
  placeOrder(order: BrokerOrderRequest): Promise<BrokerOrder>;
  cancelOrder(orderId: string): Promise<void>;
  streamFills(options?: BrokerFillStreamOptions): AsyncIterable<BrokerFill>;
}

export type AlpacaPaperAdapterOptions = {
  fetchFn?: typeof fetch;
  maxEstimatedNotional?: number;
  orderGuardRails?: OrderGuardRails | (() => OrderGuardRails | Promise<OrderGuardRails>);
  strategyGate?: StrategyTradingGate;
};

export class BrokerOrderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerOrderRejectedError";
  }
}

export class AlpacaPaperAdapter implements BrokerAdapter {
  private readonly fetchFn: typeof fetch;
  private readonly maxEstimatedNotional: number;
  private readonly orderGuardRails?: OrderGuardRails | (() => OrderGuardRails | Promise<OrderGuardRails>);
  private readonly strategyGate?: StrategyTradingGate;

  constructor(
    private readonly credentialVault: BrokerCredentialVault,
    private readonly brokerAccountId: string,
    options: AlpacaPaperAdapterOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxEstimatedNotional = options.maxEstimatedNotional ?? defaultMaxEstimatedNotional;
    this.orderGuardRails = options.orderGuardRails;
    this.strategyGate = options.strategyGate;
  }

  async getAccount(): Promise<BrokerAccount> {
    const body = await this.request("/v2/account", { method: "GET" });
    const account = objectBody(body, "Alpaca account response");

    const equity = stringField(account, "equity");
    const lastEquity = stringField(account, "last_equity");

    return {
      id: stringField(account, "id"),
      status: stringField(account, "status"),
      currency: stringField(account, "currency"),
      cash: stringField(account, "cash"),
      buyingPower: stringField(account, "buying_power"),
      portfolioValue: stringField(account, "portfolio_value"),
      equity,
      lastEquity,
      dailyPnl: decimalDifferenceString(equity, lastEquity, "dailyPnl")
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const body = await this.request("/v2/positions", { method: "GET" });

    if (!Array.isArray(body)) {
      throw new Error("Alpaca positions response must be an array");
    }

    return body.map((position) => {
      const record = objectBody(position, "Alpaca position response");

      const parsed: BrokerPosition = {
        symbol: stringField(record, "symbol"),
        qty: stringField(record, "qty"),
        marketValue: stringField(record, "market_value"),
        avgEntryPrice: stringField(record, "avg_entry_price"),
        unrealizedPl: stringField(record, "unrealized_pl")
      };
      const unrealizedPlpc = optionalStringField(record, "unrealized_plpc");

      if (unrealizedPlpc !== undefined) {
        parsed.unrealizedPlpc = unrealizedPlpc;
      }

      return parsed;
    });
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrder> {
    validateOrder(order, this.maxEstimatedNotional);
    await this.validateStrategyGate(order);
    await this.validateOrderGuardRails(order);

    const body = await this.request("/v2/orders", {
      method: "POST",
      body: JSON.stringify(toAlpacaOrderPayload(order))
    });

    return toBrokerOrder(objectBody(body, "Alpaca order response"));
  }

  async cancelOrder(orderId: string): Promise<void> {
    const trimmedOrderId = orderId.trim();

    if (!trimmedOrderId) {
      throw new Error("orderId is required");
    }

    await this.request(`/v2/orders/${encodeURIComponent(trimmedOrderId)}`, { method: "DELETE" });
  }

  async *streamFills(options: BrokerFillStreamOptions = {}): AsyncIterable<BrokerFill> {
    const seenFillIds = new Set<string>();
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;

    while (!options.signal?.aborted) {
      const body = await this.request("/v2/account/activities/FILL?direction=asc", { method: "GET" });

      if (!Array.isArray(body)) {
        throw new Error("Alpaca fill activities response must be an array");
      }

      for (const activity of body) {
        const fill = toBrokerFill(objectBody(activity, "Alpaca fill activity response"));

        if (seenFillIds.has(fill.id)) {
          continue;
        }
        seenFillIds.add(fill.id);
        yield fill;
      }

      await sleep(pollIntervalMs, undefined, { signal: options.signal }).catch((error: unknown) => {
        if (!isAbortError(error)) {
          throw error;
        }
      });
    }
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const credentials = await this.credentialVault.getBrokerCredential(this.brokerAccountId);

    if (!credentials) {
      throw new Error(`broker credentials are missing for ${this.brokerAccountId}`);
    }

    const response = await this.fetchFn(`${alpacaPaperBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "APCA-API-KEY-ID": credentials.keyId,
        "APCA-API-SECRET-KEY": credentials.secretKey,
        ...init.headers
      }
    });

    if (!response.ok) {
      throw new Error(`Alpaca paper API request failed: ${response.status} ${await response.text()}`);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  private async validateOrderGuardRails(order: BrokerOrderRequest): Promise<void> {
    if (!this.orderGuardRails) {
      return;
    }

    const rails = typeof this.orderGuardRails === "function" ? await this.orderGuardRails() : this.orderGuardRails;
    const violations = getOrderGuardRailViolations(order, rails);

    if (violations.length > 0) {
      throw new BrokerOrderRejectedError(`order violates quant guard rails: ${violations.join("; ")}`);
    }
  }

  private async validateStrategyGate(order: BrokerOrderRequest): Promise<void> {
    if (!this.strategyGate) {
      return;
    }

    const violation = await getStrategyTradingGateViolation(this.strategyGate, order.strategyId ?? "");

    if (violation) {
      throw new BrokerOrderRejectedError(violation);
    }
  }
}

export type AlpacaPaperSecretsStoreOptions = {
  filePath?: string;
  brokerAccountId?: string;
  secretsStore?: SecretsStore;
};

export async function createAlpacaPaperSecretsStore(
  options: AlpacaPaperSecretsStoreOptions = {}
): Promise<SecretsStore> {
  const filePath = options.filePath ?? process.env.ALPACA_PAPER_CREDENTIAL_FILE ?? ALPACA_PAPER_CREDENTIAL_FILE;
  const brokerAccountId = options.brokerAccountId ?? ALPACA_PAPER_BROKER_ACCOUNT_ID;
  const secretsStore = options.secretsStore ?? new InMemorySecretsStore();
  const config = parseEnvFile(await readFile(filePath, "utf8"));
  const keyId = requireConfigValue(config, "ALPACA_PAPER_KEY_ID");
  const secretKey = requireConfigValue(config, "ALPACA_PAPER_SECRET_KEY");

  await secretsStore.setSecret(`broker-credentials/${brokerAccountId}/key-id`, keyId);
  await secretsStore.setSecret(`broker-credentials/${brokerAccountId}/secret-key`, secretKey);

  return secretsStore;
}

function validateOrder(order: BrokerOrderRequest, maxEstimatedNotional: number): void {
  if (!order.symbol.trim()) {
    throw new BrokerOrderRejectedError("order symbol is required");
  }

  if (!Number.isFinite(order.qty) || order.qty <= 0) {
    throw new BrokerOrderRejectedError("order quantity must be positive");
  }

  const estimatedNotional = estimateOrderNotional(order);

  if (estimatedNotional === null) {
    throw new BrokerOrderRejectedError("order estimated notional is required for broker guard rails");
  }

  if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
    throw new BrokerOrderRejectedError("order estimated notional must be positive");
  }

  if (estimatedNotional > maxEstimatedNotional) {
    throw new BrokerOrderRejectedError(`order estimated notional exceeds ${maxEstimatedNotional}`);
  }
}

function estimateOrderNotional(order: BrokerOrderRequest): number | null {
  if (order.estimatedNotional !== undefined) {
    return order.estimatedNotional;
  }

  if (order.limitPrice !== undefined) {
    return order.qty * order.limitPrice;
  }

  return null;
}

function toAlpacaOrderPayload(order: BrokerOrderRequest): Record<string, string> {
  const payload: Record<string, string> = {
    symbol: order.symbol.trim().toUpperCase(),
    qty: order.qty.toString(),
    side: order.side,
    type: order.type,
    time_in_force: order.timeInForce
  };

  if (order.limitPrice !== undefined) {
    payload.limit_price = order.limitPrice.toString();
  }

  if (order.clientOrderId) {
    payload.client_order_id = order.clientOrderId;
  }

  return payload;
}

function toBrokerOrder(record: Record<string, unknown>): BrokerOrder {
  const order: BrokerOrder = {
    id: stringField(record, "id"),
    symbol: stringField(record, "symbol"),
    qty: stringField(record, "qty"),
    side: brokerSide(record, "side"),
    type: brokerOrderType(record, "type"),
    timeInForce: brokerTimeInForce(record, "time_in_force"),
    status: stringField(record, "status")
  };
  const clientOrderId = optionalStringField(record, "client_order_id");

  if (clientOrderId) {
    order.clientOrderId = clientOrderId;
  }

  return order;
}

function toBrokerFill(record: Record<string, unknown>): BrokerFill {
  return {
    id: stringField(record, "id"),
    orderId: stringField(record, "order_id"),
    symbol: stringField(record, "symbol"),
    qty: stringField(record, "qty"),
    price: stringField(record, "price"),
    side: brokerSide(record, "side"),
    transactionTime: stringField(record, "transaction_time")
  };
}

function parseEnvFile(contents: string): NodeJS.ProcessEnv {
  const config: NodeJS.ProcessEnv = {};

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    config[name] = unquoteEnvValue(rawValue);
  }

  return config;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function objectBody(body: unknown, description: string): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${description} must be an object`);
  }

  return body as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

function optionalStringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

function decimalDifferenceString(left: string, right: string, name: string): string {
  const leftNumber = Number(left);
  const rightNumber = Number(right);

  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    throw new Error(`${name} inputs must be numeric strings`);
  }

  return String(leftNumber - rightNumber);
}

function brokerSide(record: Record<string, unknown>, name: string): BrokerOrderSide {
  const value = stringField(record, name);

  if (value !== "buy" && value !== "sell") {
    throw new Error(`${name} must be buy or sell`);
  }

  return value;
}

function brokerOrderType(record: Record<string, unknown>, name: string): BrokerOrderType {
  const value = stringField(record, name);

  if (value !== "market" && value !== "limit") {
    throw new Error(`${name} must be market or limit`);
  }

  return value;
}

function brokerTimeInForce(record: Record<string, unknown>, name: string): BrokerTimeInForce {
  const value = stringField(record, name);

  if (value !== "day" && value !== "gtc") {
    throw new Error(`${name} must be day or gtc`);
  }

  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
