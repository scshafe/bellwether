import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ALPACA_PAPER_BROKER_ACCOUNT_ID,
  AlpacaLiveAdapter,
  AlpacaPaperAdapter,
  BrokerOrderRejectedError,
  createAlpacaPaperSecretsStore
} from "./broker.js";
import { type OrderGuardRails } from "./order-rails.js";
import { InMemorySecretsStore, SecretsBackedBrokerCredentialVault } from "./secrets.js";
import { type StrategyStatus, type StrategyTradingGate } from "./strategy.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function testVault(): SecretsBackedBrokerCredentialVault {
  return new SecretsBackedBrokerCredentialVault(
    new InMemorySecretsStore({
      "broker-credentials/alpaca-paper/key-id": "test-key-id",
      "broker-credentials/alpaca-paper/secret-key": "test-secret-key"
    })
  );
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("AlpacaPaperAdapter", () => {
  it("parses account details from the paper API", async () => {
    const calls: FetchCall[] = [];
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        return responseJson({
          id: "account-1",
          status: "ACTIVE",
          currency: "USD",
          cash: "100000",
          buying_power: "200000",
          portfolio_value: "100000",
          equity: "100010.25",
          last_equity: "100000.00"
        });
      }
    });

    assert.deepEqual(await adapter.getAccount(), {
      id: "account-1",
      status: "ACTIVE",
      currency: "USD",
      cash: "100000",
      buyingPower: "200000",
      portfolioValue: "100000",
      equity: "100010.25",
      lastEquity: "100000.00",
      dailyPnl: "10.25"
    });
    assert.equal(calls[0]?.url, "https://paper-api.alpaca.markets/v2/account");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["APCA-API-KEY-ID"], "test-key-id");
  });

  it("parses positions from the paper API", async () => {
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      fetchFn: async () =>
        responseJson([
          {
            symbol: "AAPL",
            qty: "1",
            market_value: "195.00",
            avg_entry_price: "190.00",
            unrealized_pl: "5.00",
            unrealized_plpc: "0.0263"
          }
        ])
    });

    assert.deepEqual(await adapter.getPositions(), [
      {
        symbol: "AAPL",
        qty: "1",
        marketValue: "195.00",
        avgEntryPrice: "190.00",
        unrealizedPl: "5.00",
        unrealizedPlpc: "0.0263"
      }
    ]);
  });

  it("shapes paper order payloads without exposing endpoint configuration to callers", async () => {
    const calls: FetchCall[] = [];
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        return responseJson({
          id: "order-1",
          client_order_id: "client-1",
          symbol: "AAPL",
          qty: "1",
          side: "buy",
          type: "limit",
          time_in_force: "day",
          status: "accepted"
        });
      }
    });

    const order = await adapter.placeOrder({
      symbol: "aapl",
      qty: 1,
      side: "buy",
      type: "limit",
      limitPrice: 100,
      timeInForce: "day",
      clientOrderId: "client-1"
    });

    assert.equal(calls[0]?.url, "https://paper-api.alpaca.markets/v2/orders");
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), {
      symbol: "AAPL",
      qty: "1",
      side: "buy",
      type: "limit",
      time_in_force: "day",
      limit_price: "100",
      client_order_id: "client-1"
    });
    assert.deepEqual(order, {
      id: "order-1",
      clientOrderId: "client-1",
      symbol: "AAPL",
      qty: "1",
      side: "buy",
      type: "limit",
      timeInForce: "day",
      status: "accepted"
    });
  });

  it("cancels orders through the paper API", async () => {
    const calls: FetchCall[] = [];
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        return new Response(null, { status: 204 });
      }
    });

    await adapter.cancelOrder("order-1");

    assert.equal(calls[0]?.url, "https://paper-api.alpaca.markets/v2/orders/order-1");
    assert.equal(calls[0]?.init.method, "DELETE");
  });

  it("streams fills from REST activities without duplicating seen fills", async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      fetchFn: async () => {
        fetchCalls += 1;
        return responseJson([
          {
            id: "fill-1",
            order_id: "order-1",
            symbol: "AAPL",
            qty: "1",
            price: "1.00",
            side: "buy",
            transaction_time: "2026-06-17T00:00:00Z"
          }
        ]);
      }
    });
    const fills = adapter.streamFills({ signal: controller.signal, pollIntervalMs: 1 })[Symbol.asyncIterator]();

    assert.deepEqual(await fills.next(), {
      done: false,
      value: {
        id: "fill-1",
        orderId: "order-1",
        symbol: "AAPL",
        qty: "1",
        price: "1.00",
        side: "buy",
        transactionTime: "2026-06-17T00:00:00Z"
      }
    });
    controller.abort();
    await fills.return?.();
    assert.equal(fetchCalls, 1);
  });

  it("rejects structurally unsafe orders before calling Alpaca", async () => {
    let fetchCalls = 0;
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      maxEstimatedNotional: 500,
      fetchFn: async () => {
        fetchCalls += 1;
        return responseJson({});
      }
    });

    await assert.rejects(
      () =>
        adapter.placeOrder({
          symbol: " ",
          qty: 1,
          side: "buy",
          type: "limit",
          limitPrice: 1,
          timeInForce: "day"
        }),
      BrokerOrderRejectedError
    );
    await assert.rejects(
      () =>
        adapter.placeOrder({
          symbol: "AAPL",
          qty: 0,
          side: "buy",
          type: "limit",
          limitPrice: 1,
          timeInForce: "day"
        }),
      BrokerOrderRejectedError
    );
    await assert.rejects(
      () =>
        adapter.placeOrder({
          symbol: "AAPL",
          qty: 10,
          side: "buy",
          type: "limit",
          limitPrice: 100,
          timeInForce: "day"
        }),
      BrokerOrderRejectedError
    );
    await assert.rejects(
      () =>
        adapter.placeOrder({
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "market",
          timeInForce: "day"
        }),
      BrokerOrderRejectedError
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects orders outside quant guard rails before calling Alpaca", async () => {
    let fetchCalls = 0;
    const rails: OrderGuardRails = {
      asOf: "2026-06-17T14:30:00Z",
      equity: 20_000,
      maxOpenPositions: 5,
      openSymbols: ["AAPL"],
      dailyDrawdown: { maxLossFraction: 0.03, currentLossFraction: 0, triggered: false },
      symbols: {
        AAPL: {
          symbol: "AAPL",
          sector: "technology",
          lastPrice: 100,
          averageDollarVolume: 2_000_000,
          maxBuyQty: 2,
          maxBuyNotional: 200,
          maxSellQty: 1,
          maxSellNotional: 100,
          remainingSectorBuyNotional: 200
        }
      }
    };
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      orderGuardRails: rails,
      fetchFn: async () => {
        fetchCalls += 1;
        return responseJson({});
      }
    });

    await assert.rejects(
      () =>
        adapter.placeOrder({
          symbol: "AAPL",
          qty: 3,
          side: "buy",
          type: "limit",
          limitPrice: 100,
          timeInForce: "day"
        }),
      /order violates quant guard rails/u
    );
    await assert.rejects(
      () =>
        adapter.placeOrder({
          symbol: "GOOG",
          qty: 1,
          side: "buy",
          type: "limit",
          limitPrice: 100,
          timeInForce: "day"
        }),
      /outside the playbook universe/u
    );
    assert.equal(fetchCalls, 0);
  });

  it("requires an active strategy before placing attributed orders", async () => {
    const statuses: Record<string, StrategyStatus> = {
      "draft-strategy": "draft",
      "active-strategy": "active"
    };
    const strategyGate: StrategyTradingGate = {
      getStrategyStatus: async (strategyId) => statuses[strategyId] ?? null
    };
    const calls: FetchCall[] = [];
    const adapter = new AlpacaPaperAdapter(testVault(), "alpaca-paper", {
      strategyGate,
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        return responseJson({
          id: "order-1",
          symbol: "AAPL",
          qty: "1",
          side: "buy",
          type: "limit",
          time_in_force: "day",
          status: "accepted"
        });
      }
    });

    await assert.rejects(
      () =>
        adapter.placeOrder({
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "limit",
          limitPrice: 100,
          timeInForce: "day"
        }),
      /strategyId is required/u
    );
    await assert.rejects(
      () =>
        adapter.placeOrder({
          strategyId: "draft-strategy",
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "limit",
          limitPrice: 100,
          timeInForce: "day"
        }),
      /only active strategies can trade/u
    );
    await assert.rejects(
      () =>
        adapter.placeOrder({
          strategyId: "missing-strategy",
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "limit",
          limitPrice: 100,
          timeInForce: "day"
        }),
      /was not found/u
    );

    await adapter.placeOrder({
      strategyId: "active-strategy",
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "limit",
      limitPrice: 100,
      timeInForce: "day"
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), {
      symbol: "AAPL",
      qty: "1",
      side: "buy",
      type: "limit",
      time_in_force: "day",
      limit_price: "100"
    });
  });

  it("loads mounted Alpaca credentials into the broker credential vault prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alpaca-paper-"));
    const filePath = join(directory, "alpaca-paper.env");
    await writeFile(filePath, "ALPACA_PAPER_KEY_ID=file-key\nALPACA_PAPER_SECRET_KEY='file-secret'\n", "utf8");

    const store = await createAlpacaPaperSecretsStore({ filePath });
    const vault = new SecretsBackedBrokerCredentialVault(store);

    assert.deepEqual(await vault.getBrokerCredential(ALPACA_PAPER_BROKER_ACCOUNT_ID), {
      keyId: "file-key",
      secretKey: "file-secret"
    });
  });
});

describe("AlpacaLiveAdapter", () => {
  it("throws on construction unless the flip guard is affirmed", () => {
    assert.throws(
      () => new AlpacaLiveAdapter(testVault(), "alpaca-live"),
      /live adapter disabled/u
    );
  });

  it("is a refusing design-only stub for every broker method", async () => {
    const adapter = new AlpacaLiveAdapter(testVault(), "alpaca-live", { flipGuard: { affirmed: true } });

    await assert.rejects(() => adapter.getAccount(), /not implemented — real-money path is DESIGN-only/u);
    await assert.rejects(() => adapter.getPositions(), /not implemented — real-money path is DESIGN-only/u);
    await assert.rejects(
      () => adapter.placeOrder({ symbol: "AAPL", qty: 1, side: "buy", type: "limit", timeInForce: "day", limitPrice: 100 }),
      /not implemented — real-money path is DESIGN-only/u
    );
    await assert.rejects(() => adapter.cancelOrder("order-1"), /not implemented — real-money path is DESIGN-only/u);
    await assert.rejects(() => adapter.streamFills()[Symbol.asyncIterator]().next(), /not implemented — real-money path is DESIGN-only/u);
  });
});
