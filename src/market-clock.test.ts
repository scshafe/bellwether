import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAlpacaMarketClock, type MarketClockSnapshot } from "./market-clock.js";
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

function alpacaClock(open: boolean, timestamp: string) {
  return {
    timestamp,
    is_open: open,
    next_open: "2026-06-18T13:30:00Z",
    next_close: "2026-06-17T20:00:00Z"
  };
}

describe("AlpacaMarketClock", () => {
  it("returns an open market-hours signal from Alpaca's paper clock", async () => {
    const calls: FetchCall[] = [];
    const clock = createAlpacaMarketClock(testVault(), {
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        return responseJson(alpacaClock(true, "2026-06-17T15:00:00Z"));
      }
    });

    assert.deepEqual(await clock.getClock(), {
      timestamp: "2026-06-17T15:00:00Z",
      isOpen: true,
      nextOpen: "2026-06-18T13:30:00Z",
      nextClose: "2026-06-17T20:00:00Z"
    });
    assert.equal(calls[0]?.url, "https://paper-api.alpaca.markets/v2/clock");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["APCA-API-KEY-ID"], "test-key-id");
  });

  it("returns a closed market-hours signal without deriving local market time", async () => {
    const clock = createAlpacaMarketClock(testVault(), {
      fetchFn: async () => responseJson(alpacaClock(false, "2026-06-17T22:00:00Z"))
    });

    assert.deepEqual(await clock.getClock(), {
      timestamp: "2026-06-17T22:00:00Z",
      isOpen: false,
      nextOpen: "2026-06-18T13:30:00Z",
      nextClose: "2026-06-17T20:00:00Z"
    });
  });

  it("caches within TTL and refreshes at the TTL boundary", async () => {
    let now = 1_000;
    const responses: MarketClockSnapshot[] = [
      {
        timestamp: "2026-06-17T15:00:00Z",
        isOpen: true,
        nextOpen: "2026-06-18T13:30:00Z",
        nextClose: "2026-06-17T20:00:00Z"
      },
      {
        timestamp: "2026-06-17T15:01:00Z",
        isOpen: false,
        nextOpen: "2026-06-18T13:30:00Z",
        nextClose: "2026-06-17T20:00:00Z"
      }
    ];
    const calls: FetchCall[] = [];
    const clock = createAlpacaMarketClock(testVault(), {
      ttlMs: 60,
      nowMs: () => now,
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        const response = responses[Math.min(calls.length - 1, responses.length - 1)];
        return responseJson({
          timestamp: response.timestamp,
          is_open: response.isOpen,
          next_open: response.nextOpen,
          next_close: response.nextClose
        });
      }
    });

    const first = await clock.getClock();
    now = 1_059;
    assert.equal(await clock.getClock(), first);
    assert.equal(calls.length, 1);

    now = 1_060;
    assert.deepEqual(await clock.getClock(), responses[1]);
    assert.equal(calls.length, 2);
  });

  it("force-refreshes even when the cached clock is still fresh", async () => {
    let calls = 0;
    const clock = createAlpacaMarketClock(testVault(), {
      ttlMs: 60_000,
      fetchFn: async () => {
        calls += 1;
        return responseJson(alpacaClock(calls === 1, `2026-06-17T15:0${calls}:00Z`));
      }
    });

    assert.equal((await clock.getClock()).isOpen, true);
    assert.equal((await clock.getClock({ forceRefresh: true })).isOpen, false);
    assert.equal(calls, 2);
  });
});
