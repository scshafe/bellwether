import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { InMemoryAgentDecisionLogStore } from "./agent-team.js";
import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerFill,
  BrokerFillStreamOptions,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPosition
} from "./broker.js";
import { InMemoryIdentityProvider, type InMemoryIdentityRecord } from "./identity.js";
import { createServer, type ServerOptions } from "./server.js";

class StubBrokerAdapter implements BrokerAdapter {
  async getAccount(): Promise<BrokerAccount> {
    return {
      id: "account-1",
      status: "ACTIVE",
      currency: "USD",
      cash: "5000.00",
      buyingPower: "10000.00",
      portfolioValue: "20000.00",
      equity: "20025.00",
      lastEquity: "20000.00",
      dailyPnl: "25"
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [
      {
        symbol: "AAPL",
        qty: "1",
        marketValue: "195.00",
        avgEntryPrice: "190.00",
        unrealizedPl: "5.00",
        unrealizedPlpc: "0.0263"
      }
    ];
  }

  async placeOrder(_order: BrokerOrderRequest): Promise<BrokerOrder> {
    throw new Error("portal read tests must not place orders");
  }

  async cancelOrder(_orderId: string): Promise<void> {
    throw new Error("portal read tests must not cancel orders");
  }

  async *streamFills(_options?: BrokerFillStreamOptions): AsyncIterable<BrokerFill> {}
}

async function startTestServer(options: ServerOptions = {}): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(options);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function testIdentityProvider(): InMemoryIdentityProvider {
  const users: InMemoryIdentityRecord[] = [
    {
      id: "user-cole",
      username: "cole",
      displayName: "Cole",
      role: "admin",
      password: "not-a-real-password"
    },
    {
      id: "user-brother",
      username: "brother",
      displayName: "Brother",
      role: "manager",
      password: "not-a-real-password"
    },
    {
      id: "user-family",
      username: "family",
      displayName: "Family",
      role: "viewer",
      password: "not-a-real-password"
    }
  ];

  return new InMemoryIdentityProvider(users);
}

async function authenticate(baseUrl: string, username: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "not-a-real-password" })
  });
  const body = (await response.json()) as { token?: string };

  assert.equal(response.status, 200);
  assert.equal(typeof body.token, "string");

  return body.token ?? "";
}

describe("health endpoint", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    const started = await startTestServer();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("returns ok for GET /healthz", async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

describe("identity API boundary", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    const started = await startTestServer({ identityProvider: testIdentityProvider() });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("allows an admin to authenticate and reach admin endpoints", async () => {
    const token = await authenticate(baseUrl, "cole");
    const response = await fetch(`${baseUrl}/admin/roles`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { user?: { role?: string } };

    assert.equal(response.status, 200);
    assert.equal(body.user?.role, "admin");
  });

  it("allows a manager to reach admin endpoints", async () => {
    const token = await authenticate(baseUrl, "brother");
    const response = await fetch(`${baseUrl}/admin/roles`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { user?: { role?: string } };

    assert.equal(response.status, 200);
    assert.equal(body.user?.role, "manager");
  });

  it("blocks a view-only family user from admin endpoints", async () => {
    const token = await authenticate(baseUrl, "family");
    const response = await fetch(`${baseUrl}/admin/roles`, {
      headers: { authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  });

  it("allows a view-only family user to reach family overview", async () => {
    const token = await authenticate(baseUrl, "family");
    const response = await fetch(`${baseUrl}/family/overview`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { user?: { role?: string } };

    assert.equal(response.status, 200);
    assert.equal(body.user?.role, "viewer");
  });

  it("requires a session at protected boundaries", async () => {
    const response = await fetch(`${baseUrl}/family/overview`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "missing_session" });
  });
});

describe("portal read API", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    const decisionLogStore = new InMemoryAgentDecisionLogStore();

    await decisionLogStore.recordDecision({
      id: "11111111-1111-4111-8111-111111111111",
      cycleId: "cycle-older",
      strategyId: "33333333-3333-3333-8333-333333333333",
      createdAt: "2026-06-17T12:00:00.000Z",
      quantSignal: {
        asOf: "2026-06-17T12:00:00.000Z",
        symbol: "MSFT",
        score: 0.4,
        signals: { momentumFraction: 0.4, volatilityFraction: 0.1, averageDollarVolume: 1_000_000, score: 0.4 },
        sizing: { maxQty: 1, maxNotional: 100 }
      },
      brokerSnapshot: { account: await new StubBrokerAdapter().getAccount(), positions: [] },
      strategyAnalyst: {
        thesis: "Older thesis",
        proposedOrder: {
          symbol: "MSFT",
          qty: 1,
          side: "buy",
          type: "limit",
          timeInForce: "day",
          limitPrice: 100,
          estimatedNotional: 100,
          strategyId: "33333333-3333-3333-8333-333333333333"
        }
      },
      risk: { approved: true, verdict: "approved", rationale: "Older risk", deterministicViolations: [] },
      execution: { decision: "skipped", rationale: "Older execution" }
    });
    await decisionLogStore.recordDecision({
      id: "22222222-2222-4222-8222-222222222222",
      cycleId: "cycle-newer",
      strategyId: "33333333-3333-3333-8333-333333333333",
      createdAt: "2026-06-17T13:00:00.000Z",
      quantSignal: {
        asOf: "2026-06-17T13:00:00.000Z",
        symbol: "AAPL",
        score: 0.9,
        signals: { momentumFraction: 0.9, volatilityFraction: 0.1, averageDollarVolume: 1_000_000, score: 0.9 },
        sizing: { maxQty: 1, maxNotional: 195 }
      },
      brokerSnapshot: { account: await new StubBrokerAdapter().getAccount(), positions: await new StubBrokerAdapter().getPositions() },
      strategyAnalyst: {
        thesis: "Newer thesis",
        proposedOrder: {
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "limit",
          timeInForce: "day",
          limitPrice: 195,
          estimatedNotional: 195,
          strategyId: "33333333-3333-3333-8333-333333333333"
        }
      },
      risk: { approved: true, verdict: "approved", rationale: "Newer risk", deterministicViolations: [] },
      execution: {
        decision: "placed",
        rationale: "Newer execution",
        order: {
          id: "order-1",
          symbol: "AAPL",
          qty: "1",
          side: "buy",
          type: "limit",
          timeInForce: "day",
          status: "accepted"
        }
      }
    });

    const started = await startTestServer({
      identityProvider: testIdentityProvider(),
      broker: new StubBrokerAdapter(),
      decisionLogStore
    });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("returns broker-backed account P&L and positions to viewer-or-higher roles", async () => {
    const token = await authenticate(baseUrl, "family");
    const response = await fetch(`${baseUrl}/portal/positions`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { account?: BrokerAccount; positions?: BrokerPosition[] };

    assert.equal(response.status, 200);
    assert.equal(body.account?.dailyPnl, "25");
    assert.equal(body.account?.equity, "20025.00");
    assert.equal(body.positions?.[0]?.symbol, "AAPL");
    assert.equal(body.positions?.[0]?.unrealizedPl, "5.00");
    assert.equal(body.positions?.[0]?.unrealizedPlpc, "0.0263");
  });

  it("returns bounded newest-first glass-box decisions to viewer-or-higher roles", async () => {
    const token = await authenticate(baseUrl, "family");
    const response = await fetch(`${baseUrl}/portal/decisions?limit=1`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { decisions?: Array<{ id: string; quantSignal: { symbol: string } }>; limit?: number };

    assert.equal(response.status, 200);
    assert.equal(body.limit, 1);
    assert.equal(body.decisions?.length, 1);
    assert.equal(body.decisions?.[0]?.id, "22222222-2222-4222-8222-222222222222");
    assert.equal(body.decisions?.[0]?.quantSignal.symbol, "AAPL");
  });

  it("requires a valid session before portal dependencies are used", async () => {
    const response = await fetch(`${baseUrl}/portal/positions`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "missing_session" });
  });

  it("reports missing runtime dependencies instead of returning fake portal data", async () => {
    const started = await startTestServer({ identityProvider: testIdentityProvider() });

    try {
      const token = await authenticate(started.baseUrl, "family");
      const positionsResponse = await fetch(`${started.baseUrl}/portal/positions`, {
        headers: { authorization: `Bearer ${token}` }
      });
      const decisionsResponse = await fetch(`${started.baseUrl}/portal/decisions`, {
        headers: { authorization: `Bearer ${token}` }
      });

      assert.equal(positionsResponse.status, 503);
      assert.deepEqual(await positionsResponse.json(), { error: "broker_unavailable" });
      assert.equal(decisionsResponse.status, 503);
      assert.deepEqual(await decisionsResponse.json(), { error: "decision_log_unavailable" });
    } finally {
      await closeTestServer(started.server);
    }
  });
});
