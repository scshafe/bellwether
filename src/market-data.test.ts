import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALPACA_MARKET_DATA_BASE_URL, AlpacaIexMarketDataClient } from "./market-data.js";
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

describe("AlpacaIexMarketDataClient", () => {
  it("fetches daily bars from Alpaca's IEX feed behind the market-data seam", async () => {
    const calls: FetchCall[] = [];
    const client = new AlpacaIexMarketDataClient(testVault(), {
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        return new Response(
          JSON.stringify({
            bars: {
              AAPL: [{ t: "2026-06-16T04:00:00Z", o: 100, h: 111, l: 99, c: 110, v: 20_000 }],
              MSFT: [{ t: "2026-06-16T04:00:00Z", o: 200, h: 202, l: 198, c: 201, v: 10_000 }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    assert.deepEqual(await client.getDailyBars(["aapl", "MSFT"], { start: "2026-06-01", end: "2026-06-17", limit: 10 }), [
      {
        symbol: "AAPL",
        timestamp: "2026-06-16T04:00:00Z",
        open: 100,
        high: 111,
        low: 99,
        close: 110,
        volume: 20_000
      },
      {
        symbol: "MSFT",
        timestamp: "2026-06-16T04:00:00Z",
        open: 200,
        high: 202,
        low: 198,
        close: 201,
        volume: 10_000
      }
    ]);

    const url = new URL(calls[0]?.url ?? "");
    assert.equal(`${url.origin}${url.pathname}`, `${ALPACA_MARKET_DATA_BASE_URL}/v2/stocks/bars`);
    assert.equal(url.searchParams.get("feed"), "iex");
    assert.equal(url.searchParams.get("timeframe"), "1Day");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["APCA-API-KEY-ID"], "test-key-id");
  });
});
