import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ALPACA_PAPER_BROKER_ACCOUNT_ID,
  AlpacaPaperAdapter,
  BrokerOrderRejectedError,
  createAlpacaPaperSecretsStore
} from "./broker.js";
import { InMemorySecretsStore, SecretsBackedBrokerCredentialVault } from "./secrets.js";

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
          portfolio_value: "100000"
        });
      }
    });

    assert.deepEqual(await adapter.getAccount(), {
      id: "account-1",
      status: "ACTIVE",
      currency: "USD",
      cash: "100000",
      buyingPower: "200000",
      portfolioValue: "100000"
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
            avg_entry_price: "190.00"
          }
        ])
    });

    assert.deepEqual(await adapter.getPositions(), [
      {
        symbol: "AAPL",
        qty: "1",
        marketValue: "195.00",
        avgEntryPrice: "190.00"
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
