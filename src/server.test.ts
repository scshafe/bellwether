import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import type { IdentityResolver } from "./identity.js";
import type { LlmJsonRequest, ReasoningModel } from "./llm.js";
import { TestOidcIssuer } from "./oidc-test-issuer.js";
import { createPortalIdentityResolver, readPortalIdentityConfig } from "./portal-identity.js";
import { InMemoryPortalUsersStore, type PortalUserRecord, type PortalUsersStore } from "./portal-users.js";
import { InMemorySourcesStore, type SourceRecord } from "./qualitative.js";
import type { AgentRuntimeControl, AgentRuntimeStatus } from "./runtime-control.js";
import { createServer, parseRosterRoute, type ServerOptions } from "./server.js";
import { InMemoryStrategyStore, type StrategyRecord } from "./strategy.js";
import { InMemoryStrategyChatStore, type StrategyChatMessage } from "./strategy-chat.js";
import { InMemoryStrategyProposalsStore, type StrategyProposalRecord } from "./strategy-proposals.js";
import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type QuantPlaybookParameters } from "./quant-playbook.js";

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

class CountingBrokerAdapter extends StubBrokerAdapter {
  placeOrderCalls = 0;

  override async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrder> {
    this.placeOrderCalls += 1;
    return {
      id: `order-${this.placeOrderCalls}`,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      qty: String(order.qty),
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      status: "accepted"
    };
  }
}

class QueueReasoningModel implements ReasoningModel {
  readonly requests: LlmJsonRequest[] = [];

  constructor(private readonly responses: Array<unknown | Error>) {}

  async generateJson(request: LlmJsonRequest): Promise<unknown> {
    this.requests.push(request);
    const next = this.responses.shift();

    if (next instanceof Error) {
      throw next;
    }

    if (next === undefined) {
      throw new Error("unexpected model request");
    }

    return next;
  }
}

class InMemoryRuntimeControl implements AgentRuntimeControl {
  starts = 0;
  stops = 0;
  private status: AgentRuntimeStatus = {
    state: "stopped",
    activeJobId: null,
    lastCycle: null,
    updatedAt: "2026-06-17T14:00:00.000Z"
  };

  async getStatus(): Promise<AgentRuntimeStatus> {
    return this.status;
  }

  async start(): Promise<AgentRuntimeStatus> {
    if (this.status.state === "running" && this.status.activeJobId) {
      return this.status;
    }

    this.starts += 1;
    this.status = { ...this.status, state: "running", activeJobId: `job-${this.starts}`, updatedAt: "2026-06-17T14:01:00.000Z" };
    return this.status;
  }

  async stop(): Promise<AgentRuntimeStatus> {
    this.stops += 1;
    this.status = {
      ...this.status,
      state: "stopped",
      activeJobId: null,
      lastCycle: {
        jobId: `job-${this.starts}`,
        status: "cancelled",
        summary: "Stopped before worker claimed the queued live cycle.",
        decisionLogId: null,
        completedAt: "2026-06-17T14:02:00.000Z"
      },
      updatedAt: "2026-06-17T14:02:00.000Z"
    };
    return this.status;
  }
}

class RecordingStrategyStore extends InMemoryStrategyStore {
  readonly calls: string[] = [];

  override async createStrategy(input: Parameters<InMemoryStrategyStore["createStrategy"]>[0]): Promise<StrategyRecord> {
    this.calls.push("createStrategy");
    return super.createStrategy(input);
  }

  override async updateStrategy(id: string, patch: Parameters<InMemoryStrategyStore["updateStrategy"]>[1]): Promise<StrategyRecord> {
    this.calls.push("updateStrategy");
    return super.updateStrategy(id, patch);
  }

  override async startDiscussion(id: string): Promise<StrategyRecord> {
    this.calls.push("startDiscussion");
    return super.startDiscussion(id);
  }

  override async returnToDraft(id: string): Promise<StrategyRecord> {
    this.calls.push("returnToDraft");
    return super.returnToDraft(id);
  }

  override async approveStrategy(id: string): Promise<StrategyRecord> {
    this.calls.push("approveStrategy");
    return super.approveStrategy(id);
  }

  override async activateStrategy(id: string): Promise<StrategyRecord> {
    this.calls.push("activateStrategy");
    return super.activateStrategy(id);
  }

  override async pauseStrategy(id: string, reason?: string): Promise<StrategyRecord> {
    this.calls.push("pauseStrategy");
    return super.pauseStrategy(id, reason);
  }

  override async resumeStrategy(id: string): Promise<StrategyRecord> {
    this.calls.push("resumeStrategy");
    return super.resumeStrategy(id);
  }

  override async retireStrategy(id: string, reason?: string): Promise<StrategyRecord> {
    this.calls.push("retireStrategy");
    return super.retireStrategy(id, reason);
  }
}

class RecordingSourcesStore extends InMemorySourcesStore {
  readonly calls: string[] = [];

  override async createSource(input: Parameters<InMemorySourcesStore["createSource"]>[0]): Promise<SourceRecord> {
    this.calls.push("createSource");
    return super.createSource(input);
  }

  override async listSources(): Promise<SourceRecord[]> {
    this.calls.push("listSources");
    return super.listSources();
  }

  override async updateSource(id: string, patch: Parameters<InMemorySourcesStore["updateSource"]>[1]): Promise<SourceRecord> {
    this.calls.push("updateSource");
    return super.updateSource(id, patch);
  }

  override async deleteSource(id: string): Promise<boolean> {
    this.calls.push("deleteSource");
    return super.deleteSource(id);
  }
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

/** One fake Pocket ID for the whole suite. Every request below carries a real
 *  signed id token, and the role behind it comes from a real account table:
 *  the API tests exercise the same two steps the deployment does. */
const testIssuer = new TestOidcIssuer();

const portalUsers = {
  cole: { sub: "pocket-id-cole", email: "cole@example.com", name: "Cole", role: "admin" },
  brother: { sub: "pocket-id-brother", email: "brother@example.com", name: "Brother", role: "manager" },
  family: { sub: "pocket-id-family", email: "family@example.com", name: "Family", role: "viewer" }
} as const;

/** An account table with the three portal users already granted, so a test
 *  starts from an established portal rather than the bootstrap case. */
async function seededPortalUsers(): Promise<InMemoryPortalUsersStore> {
  const users = new InMemoryPortalUsersStore();
  const admin = await users.recordSignIn({
    subject: portalUsers.cole.sub,
    email: portalUsers.cole.email,
    displayName: portalUsers.cole.name
  });

  for (const person of [portalUsers.brother, portalUsers.family]) {
    const account = await users.recordSignIn({ subject: person.sub, email: person.email, displayName: person.name });
    await users.updateUser(account.id, { role: person.role }, admin.id);
  }

  return users;
}

function testIdentityResolver(users: PortalUsersStore): IdentityResolver {
  return createPortalIdentityResolver(
    readPortalIdentityConfig({
      PORTAL_OIDC_ISSUER: testIssuer.issuer,
      PORTAL_OIDC_AUDIENCE: testIssuer.audience
    }),
    users,
    { fetchImpl: testIssuer.fetch }
  );
}

/** A server whose accounts are already granted — the ordinary case. */
async function startPortalServer(options: ServerOptions = {}): Promise<{ baseUrl: string; server: Server }> {
  const portalUsersStore = await seededPortalUsers();

  return startTestServer({ resolveIdentity: testIdentityResolver(portalUsersStore), portalUsersStore, ...options });
}

/** The token oauth2-proxy would forward for one of those humans. */
function idTokenFor(user: keyof typeof portalUsers): string {
  const person = portalUsers[user];

  return testIssuer.idToken({ sub: person.sub, email: person.email, name: person.name });
}

function strategyParameters(overrides: Partial<QuantPlaybookParameters> = {}): QuantPlaybookParameters {
  return { ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS, ...overrides };
}

async function postJson(baseUrl: string, path: string, token: string, body: unknown = null): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === null ? undefined : JSON.stringify(body)
  });
}

async function patchJson(baseUrl: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function deleteJson(baseUrl: string, path: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
}

async function authenticatedRawRequest(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  token: string,
  body?: string
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return fetch(`${baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
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
    const started = await startPortalServer();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("allows an admin to authenticate and reach admin endpoints", async () => {
    const token = idTokenFor("cole");
    const response = await fetch(`${baseUrl}/admin/roles`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { user?: { role?: string } };

    assert.equal(response.status, 200);
    assert.equal(body.user?.role, "admin");
  });

  it("allows a manager to reach admin endpoints", async () => {
    const token = idTokenFor("brother");
    const response = await fetch(`${baseUrl}/admin/roles`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as { user?: { role?: string } };

    assert.equal(response.status, 200);
    assert.equal(body.user?.role, "manager");
  });

  it("blocks a view-only family user from admin endpoints", async () => {
    const token = idTokenFor("family");
    const response = await fetch(`${baseUrl}/admin/roles`, {
      headers: { authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  });

  it("allows a view-only family user to reach family overview", async () => {
    const token = idTokenFor("family");
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

describe("Pocket ID is the only way in", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    const started = await startPortalServer();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("refuses a forwarded identity header with no signed token behind it", async () => {
    // The retired mode believed X-Forwarded-Email on sight. Anything that
    // reaches this port directly can set that header, so identity now travels
    // only as a signature.
    const forwardedHeaders: Array<Record<string, string>> = [
      { "x-forwarded-email": "cole@example.com" },
      { "x-forwarded-user": "cole@example.com" },
      { "x-auth-request-email": "cole@example.com" },
      { "x-forwarded-groups": "bellwether-admins" },
      { "x-forwarded-email": "cole@example.com", "x-forwarded-user": "cole" }
    ];

    for (const headers of forwardedHeaders) {
      const response = await fetch(`${baseUrl}/admin/roles`, { headers });

      assert.equal(response.status, 401, `${JSON.stringify(headers)} must not authenticate anyone`);
      assert.deepEqual(await response.json(), { error: "missing_session" });
    }
  });

  it("refuses a token signed by anyone but the configured issuer", async () => {
    const attacker = new TestOidcIssuer({ issuer: testIssuer.issuer, audience: testIssuer.audience });
    const response = await fetch(`${baseUrl}/admin/roles`, {
      headers: { authorization: `Bearer ${attacker.idToken({ sub: portalUsers.cole.sub, email: portalUsers.cole.email })}` }
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_session" });
  });

  it("refuses an expired token from the real issuer", async () => {
    const expired = testIssuer.idToken({
      sub: portalUsers.cole.sub,
      email: portalUsers.cole.email,
      exp: Math.floor(Date.now() / 1000) - 3_600
    });
    const response = await fetch(`${baseUrl}/admin/roles`, { headers: { authorization: `Bearer ${expired}` } });

    assert.equal(response.status, 401);
  });

  it("gives a valid Pocket ID user with no granted account nothing, not admin", async () => {
    const stranger = testIssuer.idToken({ sub: "pocket-id-stranger", email: "stranger@example.com" });

    for (const path of ["/admin/roles", "/family/overview", "/portal/positions"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${stranger}` } });

      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "not_provisioned" });
    }
  });

  it("serves the signed-out SPA shell while refusing its data", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "portal-shell-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Bellwether</title>");
    const started = await startPortalServer({ staticAssetsDir: staticDir });

    try {
      const shell = await fetch(`${started.baseUrl}/`);
      const data = await fetch(`${started.baseUrl}/portal/positions`);

      assert.equal(shell.status, 200, "the app shell is public; the door is in front of it");
      assert.equal(data.status, 401);
    } finally {
      await closeTestServer(started.server);
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  it("fails closed when no identity source is configured at all", async () => {
    const started = await startTestServer({});

    try {
      for (const path of ["/admin/roles", "/family/overview", "/portal/positions", "/portal/strategies"]) {
        const response = await fetch(`${started.baseUrl}${path}`);

        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "identity_unavailable" });
      }
    } finally {
      await closeTestServer(started.server);
    }
  });
});

describe("portal accounts API", () => {
  let server: Server;
  let baseUrl = "";
  let users: InMemoryPortalUsersStore;

  before(async () => {
    users = await seededPortalUsers();
    const started = await startTestServer({
      resolveIdentity: testIdentityResolver(users),
      portalUsersStore: users
    });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  async function listUsers(token: string): Promise<{ status: number; users: PortalUserRecord[] }> {
    const response = await fetch(`${baseUrl}/portal/users`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { users?: PortalUserRecord[] };

    return { status: response.status, users: body.users ?? [] };
  }

  it("lists the accounts to an admin, with their Pocket ID link", async () => {
    const listed = await listUsers(idTokenFor("cole"));

    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.users.map((user) => user.subject).sort(),
      [portalUsers.cole.sub, portalUsers.brother.sub, portalUsers.family.sub].sort()
    );
    assert.ok(
      listed.users.every((user) => user.subject.startsWith("pocket-id-")),
      "every account is linked to a Pocket ID subject"
    );
  });

  it("keeps managers out — granting access is not a runtime control", async () => {
    for (const who of ["brother", "family"] as const) {
      const response = await fetch(`${baseUrl}/portal/users`, {
        headers: { authorization: `Bearer ${idTokenFor(who)}` }
      });

      assert.equal(response.status, 403, `${who} must not see the account list`);
      assert.deepEqual(await response.json(), { error: "forbidden" });
    }
  });

  it("enrols whoever knocks, then grants them access in one PATCH", async () => {
    const knocking = testIssuer.idToken({ sub: "pocket-id-newcomer", email: "newcomer@example.com", name: "Newcomer" });

    const refused = await fetch(`${baseUrl}/family/overview`, { headers: { authorization: `Bearer ${knocking}` } });
    assert.equal(refused.status, 403);

    // The knock is what put them on the list — nobody typed a subject.
    const listed = await listUsers(idTokenFor("cole"));
    const newcomer = listed.users.find((user) => user.subject === "pocket-id-newcomer");
    assert.equal(newcomer?.status, "pending");
    assert.equal(newcomer?.email, "newcomer@example.com");

    const granted = await patchJson(baseUrl, `/portal/users/${newcomer?.id}`, idTokenFor("cole"), { role: "viewer" });
    assert.equal(granted.status, 200);

    const admitted = await fetch(`${baseUrl}/family/overview`, { headers: { authorization: `Bearer ${knocking}` } });
    const body = (await admitted.json()) as { user?: { role?: string } };

    assert.equal(admitted.status, 200, "the grant takes effect on the next request, with no redeploy");
    assert.equal(body.user?.role, "viewer");
  });

  it("revokes access on the next request", async () => {
    const listed = await listUsers(idTokenFor("cole"));
    const family = listed.users.find((user) => user.subject === portalUsers.family.sub);

    const revoked = await patchJson(baseUrl, `/portal/users/${family?.id}`, idTokenFor("cole"), { role: null });
    assert.equal(revoked.status, 200);

    const after = await fetch(`${baseUrl}/family/overview`, {
      headers: { authorization: `Bearer ${idTokenFor("family")}` }
    });

    assert.equal(after.status, 403);
    assert.deepEqual(await after.json(), { error: "not_provisioned" });

    await patchJson(baseUrl, `/portal/users/${family?.id}`, idTokenFor("cole"), { role: "viewer" });
  });

  it("refuses to leave the portal with no admin", async () => {
    const listed = await listUsers(idTokenFor("cole"));
    const admin = listed.users.find((user) => user.subject === portalUsers.cole.sub);
    const response = await patchJson(baseUrl, `/portal/users/${admin?.id}`, idTokenFor("cole"), { role: "viewer" });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "last_admin" });
  });

  it("rejects unknown ids and malformed patches before touching the store", async () => {
    const admin = idTokenFor("cole");
    const missing = await patchJson(baseUrl, "/portal/users/11111111-1111-4111-8111-111111111111", admin, {
      role: "viewer"
    });

    assert.equal(missing.status, 404);

    const listed = await listUsers(admin);
    const target = listed.users.find((user) => user.subject === portalUsers.brother.sub);

    for (const patch of [{}, { role: "root" }, { status: "banned" }, { role: 7 }, "not an object"]) {
      const response = await patchJson(baseUrl, `/portal/users/${target?.id}`, admin, patch);

      assert.equal(response.status, 400, `${JSON.stringify(patch)} must be refused`);
      assert.deepEqual(await response.json(), { error: "invalid_portal_user_patch" });
    }
  });

  it("has no password anywhere in what it returns or accepts", async () => {
    const listed = await listUsers(idTokenFor("cole"));

    assert.equal(/pass|secret|credential|hash/iu.test(JSON.stringify(listed.users)), false);

    const target = listed.users.find((user) => user.subject === portalUsers.brother.sub);
    // Constructed the way the deleted credential system would have used it.
    const response = await patchJson(baseUrl, `/portal/users/${target?.id}`, idTokenFor("cole"), {
      password: "change-me"
    });

    assert.equal(response.status, 400, "there is no field here that could carry a credential");
  });

  it("answers 503 rather than guessing when no account table is wired", async () => {
    const started = await startTestServer({ resolveIdentity: testIdentityResolver(await seededPortalUsers()) });

    try {
      const response = await fetch(`${started.baseUrl}/portal/users`, {
        headers: { authorization: `Bearer ${idTokenFor("cole")}` }
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "portal_users_unavailable" });
    } finally {
      await closeTestServer(started.server);
    }
  });
});

describe("the first account on an empty portal", () => {
  it("makes the first verified arrival admin, and nobody after them", async () => {
    const users = new InMemoryPortalUsersStore();
    const started = await startTestServer({
      resolveIdentity: testIdentityResolver(users),
      portalUsersStore: users
    });

    try {
      const founder = await fetch(`${started.baseUrl}/admin/roles`, {
        headers: { authorization: `Bearer ${idTokenFor("cole")}` }
      });
      const founderBody = (await founder.json()) as { user?: { role?: string } };

      assert.equal(founder.status, 200);
      assert.equal(founderBody.user?.role, "admin", "an empty portal admits its first arrival as admin");

      const second = await fetch(`${started.baseUrl}/admin/roles`, {
        headers: { authorization: `Bearer ${idTokenFor("brother")}` }
      });

      assert.equal(second.status, 403, "the bootstrap happens exactly once");
      assert.deepEqual(await second.json(), { error: "not_provisioned" });
    } finally {
      await closeTestServer(started.server);
    }
  });
});

describe("reaching the app port instead of the door", () => {
  const door = "https://bellwether.example.ts.net";
  let server: Server;
  let baseUrl = "";
  let staticDir = "";

  before(async () => {
    staticDir = await mkdtemp(join(tmpdir(), "portal-door-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Bellwether</title>");
    const started = await startPortalServer({
      staticAssetsDir: staticDir,
      publicBaseUrl: door
    });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
    await rm(staticDir, { recursive: true, force: true });
  });

  it("sends a browser on to the door instead of a shell it could never sign in from", async () => {
    const response = await fetch(`${baseUrl}/`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${door}/`);
  });

  it("keeps the path and query, so a deep link survives the trip", async () => {
    const response = await fetch(`${baseUrl}/strategies?tab=control&id=7`, { redirect: "manual" });

    assert.equal(response.headers.get("location"), `${door}/strategies?tab=control&id=7`);
  });

  it("never redirects /healthz — the deploy probe and container healthcheck read it", async () => {
    const response = await fetch(`${baseUrl}/healthz`, { redirect: "manual" });

    assert.equal(response.status, 200);
  });

  it("still answers 401 on data routes rather than bouncing an XHR", async () => {
    for (const path of ["/portal/positions", "/family/overview", "/admin/roles"]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });

      assert.equal(response.status, 401, `${path} must answer, not redirect`);
      assert.deepEqual(await response.json(), { error: "missing_session" });
    }
  });

  it("leaves a token-carrying request alone, so the door cannot be made to loop", async () => {
    // Through the proxy every request carries the forwarded id token. If that
    // request were redirected back to the proxy, it would bounce forever.
    const response = await fetch(`${baseUrl}/`, {
      headers: { authorization: `Bearer ${idTokenFor("cole")}` },
      redirect: "manual"
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Bellwether/u);
  });

  it("serves the shell normally when the request already arrived at the door", async () => {
    // fetch refuses to set Host, and Host is the whole question here.
    const status = await new Promise<number>((resolve, reject) => {
      const address = server.address() as AddressInfo;
      const request = httpRequest(
        { host: "127.0.0.1", port: address.port, path: "/", headers: { host: "bellwether.example.ts.net" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      request.on("error", reject);
      request.end();
    });

    assert.equal(status, 200, "a request that already came through the door must not be bounced back to it");
  });

  it("does not redirect when no door address is configured", async () => {
    const started = await startPortalServer({ staticAssetsDir: staticDir });

    try {
      const response = await fetch(`${started.baseUrl}/`, { redirect: "manual" });

      assert.equal(response.status, 200);
    } finally {
      await closeTestServer(started.server);
    }
  });
});

describe("the deleted in-app credential system", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    const started = await startPortalServer();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  async function postCredentials(credentials: unknown): Promise<Response> {
    return fetch(`${baseUrl}/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials)
    });
  }

  it("404s POST /auth/session exactly like a route that never existed", async () => {
    const login = await postCredentials({ username: "admin", password: "change-me" });
    const neverExisted = await fetch(`${baseUrl}/auth/there-was-never-a-route-here`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "change-me" })
    });

    assert.equal(login.status, 404);
    assert.deepEqual(await login.json(), { error: "not_found" });
    assert.equal(neverExisted.status, login.status);
  });

  it("answers identically whether or not the named account ever existed — no oracle", async () => {
    // admin/change-me was the seeded default; cole is a real Pocket ID user;
    // the last two never existed. All four must be indistinguishable.
    const answers = await Promise.all(
      [
        { username: "admin", password: "change-me" },
        { username: "cole", password: "not-a-real-password" },
        { username: "nobody-at-all", password: "" },
        { not: "even credentials" }
      ].map(async (credentials) => {
        const response = await postCredentials(credentials);
        return { status: response.status, body: await response.text() };
      })
    );

    for (const answer of answers) {
      assert.deepEqual(answer, answers[0]);
    }
  });

  it("treats the login path exactly like a path that was never registered", async () => {
    // With the SPA served, an unknown GET falls through to the app shell — so
    // the property to hold is indistinguishability, on every method, in the
    // configuration the deployment actually runs.
    const staticDir = await mkdtemp(join(tmpdir(), "portal-shell-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Bellwether</title>");
    const started = await startPortalServer({ staticAssetsDir: staticDir });

    try {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
        const [login, neverExisted] = await Promise.all(
          ["/auth/session", "/auth/was-never-a-route"].map(async (path) => {
            const response = await fetch(`${started.baseUrl}${path}`, { method });
            return { status: response.status, body: await response.text() };
          })
        );

        assert.deepEqual(login, neverExisted, `${method} /auth/session is distinguishable from a dead path`);
      }
    } finally {
      await closeTestServer(started.server);
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  it("mints no session token — the retired token formats authenticate nothing", async () => {
    for (const token of ["in-memory-session:portal-admin", "in-memory-session:user-cole", "trusted-proxy"]) {
      const response = await fetch(`${baseUrl}/admin/roles`, { headers: { authorization: `Bearer ${token}` } });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "invalid_session" });
    }
  });

  it("ignores the retired ServerOptions wiring — the old lanes are gone, not re-pluggable", async () => {
    const seededAdmin = { id: "portal-admin", username: "admin", displayName: "Administrator", role: "admin" };
    // Exactly how the deleted code was wired, forced past the type system.
    const started = await startTestServer({
      identityProvider: {
        authenticate: async () => ({ token: "in-memory-session:portal-admin", user: seededAdmin }),
        identifySession: async () => seededAdmin
      },
      trustedProxyAuth: {
        headerName: "x-forwarded-email",
        expectedIdentities: [],
        allowAnyIdentity: true,
        user: seededAdmin
      }
    } as unknown as ServerOptions);

    try {
      const login = await fetch(`${started.baseUrl}/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "change-me" })
      });
      const bearer = await fetch(`${started.baseUrl}/admin/roles`, {
        headers: { authorization: "Bearer in-memory-session:portal-admin" }
      });
      const header = await fetch(`${started.baseUrl}/admin/roles`, {
        headers: { "x-forwarded-email": "anyone@anywhere.test" }
      });

      assert.equal(login.status, 404);
      assert.equal(bearer.status, 503, "no identity source is configured, so nothing is admitted");
      assert.equal(header.status, 503);
    } finally {
      await closeTestServer(started.server);
    }
  });
});

describe("viewer portal role audit", () => {
  let server: Server;
  let baseUrl = "";
  let viewerToken = "";
  let strategyStore: RecordingStrategyStore;
  let sourcesStore: RecordingSourcesStore;
  let runtimeControl: InMemoryRuntimeControl;
  let proposalsStore: InMemoryStrategyProposalsStore;
  let strategyId = "";
  let draftStrategyId = "";
  let approvedStrategyId = "";
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const proposalId = "proposal-viewer-audit";

  before(async () => {
    const decisionLogStore = new InMemoryAgentDecisionLogStore();
    strategyStore = new RecordingStrategyStore();
    sourcesStore = new RecordingSourcesStore([
      {
        id: sourceId,
        sourceKey: "viewer-audit-rss",
        name: "Viewer Audit RSS",
        sourceType: "rss",
        feedUrl: "https://feeds.example.test/viewer-audit.xml",
        enabled: true,
        qualityRating: 4,
        createdAt: "2026-06-17T10:00:00.000Z",
        updatedAt: "2026-06-17T10:00:00.000Z"
      }
    ]);
    runtimeControl = new InMemoryRuntimeControl();
    proposalsStore = new InMemoryStrategyProposalsStore();

    await decisionLogStore.recordDecision({
      id: "44444444-4444-4444-8444-444444444444",
      cycleId: "viewer-audit-cycle",
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
        thesis: "Viewer audit thesis",
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
      risk: { approved: true, verdict: "approved", rationale: "Viewer audit risk", deterministicViolations: [] },
      execution: { decision: "skipped", rationale: "Viewer audit execution" }
    });

    const strategy = await strategyStore.createStrategy({ name: "Viewer audit target", parameters: strategyParameters() });
    const draftStrategy = await strategyStore.createStrategy({ name: "Viewer-hidden draft", parameters: strategyParameters() });
    const approvedStrategy = await strategyStore.createStrategy({ name: "Viewer-visible approved", parameters: strategyParameters() });
    await strategyStore.approveStrategy(approvedStrategy.id);
    strategyId = strategy.id;
    draftStrategyId = draftStrategy.id;
    approvedStrategyId = approvedStrategy.id;

    await proposalsStore.recordProposal({
      id: proposalId,
      suggestedCandidate: {
        name: "Viewer audit proposal",
        mandate: "Operators must review this before it becomes a draft.",
        suggestedParameters: { maxOpenPositions: 4 }
      },
      quantRationale: "Viewer audit rationale",
      qualitativeEvidence: { links: [], quotes: [], signals: [] }
    });

    const started = await startPortalServer({
      broker: new StubBrokerAdapter(),
      decisionLogStore,
      runtimeControl,
      strategyStore,
      proposalsStore,
      strategyChatStore: new InMemoryStrategyChatStore(),
      strategyChatModel: new QueueReasoningModel([]),
      sourcesStore,
      env: {}
    });
    server = started.server;
    baseUrl = started.baseUrl;
    viewerToken = idTokenFor("family");
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("allows viewer reads on every family-readable portal GET", async () => {
    const readableRoutes = [
      "/portal/positions",
      "/portal/decisions",
      "/portal/strategies",
      "/portal/roster",
      "/portal/runtime",
      "/portal/proposals"
    ];

    for (const route of readableRoutes) {
      const response = await authenticatedRawRequest(baseUrl, route, "GET", viewerToken);
      assert.equal(response.status, 200, route);
      await response.json();
    }
  });

  it("hides draft strategies from viewer strategy reads", async () => {
    const response = await authenticatedRawRequest(baseUrl, "/portal/strategies", "GET", viewerToken);
    const body = (await response.json()) as { strategies?: StrategyRecord[] };

    assert.equal(response.status, 200);
    assert.ok(body.strategies?.some((strategy) => strategy.id === approvedStrategyId));
    assert.equal(body.strategies?.some((strategy) => strategy.id === draftStrategyId), false);
    assert.equal(body.strategies?.some((strategy) => strategy.status === "draft"), false);
  });

  it("returns 403 to viewers for every admin-boundary route before reading mutation bodies", async () => {
    const forbiddenBody = "not valid json";
    const adminGatedRoutes: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; label: string }> = [
      { method: "GET", path: "/admin/roles", label: "admin role inspection" },
      { method: "POST", path: "/portal/strategies", label: "strategy create" },
      { method: "PATCH", path: `/portal/strategies/${strategyId}`, label: "strategy update" },
      { method: "POST", path: `/portal/strategies/${strategyId}/discuss`, label: "strategy transition discuss" },
      { method: "POST", path: `/portal/strategies/${strategyId}/return-to-draft`, label: "strategy transition return-to-draft" },
      { method: "POST", path: `/portal/strategies/${strategyId}/approve`, label: "strategy transition approve" },
      { method: "POST", path: `/portal/strategies/${strategyId}/activate`, label: "strategy transition activate" },
      { method: "POST", path: `/portal/strategies/${strategyId}/pause`, label: "strategy transition pause" },
      { method: "POST", path: `/portal/strategies/${strategyId}/resume`, label: "strategy transition resume" },
      { method: "POST", path: `/portal/strategies/${strategyId}/retire`, label: "strategy transition retire" },
      { method: "POST", path: `/portal/strategies/${strategyId}/chat`, label: "strategy chat post" },
      { method: "POST", path: "/portal/roster", label: "roster create" },
      { method: "PATCH", path: `/portal/roster/${sourceId}`, label: "roster update" },
      { method: "DELETE", path: `/portal/roster/${sourceId}`, label: "roster delete" },
      { method: "POST", path: "/portal/runtime/start", label: "runtime start" },
      { method: "POST", path: "/portal/runtime/stop", label: "runtime stop" },
      { method: "POST", path: `/portal/proposals/${proposalId}/review`, label: "proposal review" }
    ];

    const strategyCallsBefore = strategyStore.calls.length;
    const sourceCallsBefore = sourcesStore.calls.length;

    for (const route of adminGatedRoutes) {
      const response = await authenticatedRawRequest(
        baseUrl,
        route.path,
        route.method,
        viewerToken,
        route.method === "GET" ? undefined : forbiddenBody
      );

      assert.equal(response.status, 403, route.label);
      assert.deepEqual(await response.json(), { error: "forbidden" }, route.label);
    }

    assert.equal(strategyStore.calls.length, strategyCallsBefore);
    assert.equal(sourcesStore.calls.length, sourceCallsBefore);
    assert.equal(runtimeControl.starts, 0);
    assert.equal(runtimeControl.stops, 0);
    assert.equal((await proposalsStore.listPending()).some((proposal) => proposal.id === proposalId), true);
  });
});

describe("portal read API", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    const decisionLogStore = new InMemoryAgentDecisionLogStore();
    const strategyStore = new InMemoryStrategyStore();
    const strategy = await strategyStore.createStrategy({
      id: "33333333-3333-3333-8333-333333333333",
      name: "Cycle-A paper momentum",
      parameters: strategyParameters()
    });
    await strategyStore.approveStrategy(strategy.id);
    await strategyStore.activateStrategy(strategy.id);

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

    const started = await startPortalServer({
      broker: new StubBrokerAdapter(),
      decisionLogStore,
      strategyStore
    });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("returns broker-backed account P&L and positions to viewer-or-higher roles", async () => {
    const token = idTokenFor("family");
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

  it("returns per-strategy paper P&L and equity summaries from existing snapshots", async () => {
    const token = idTokenFor("family");
    const response = await fetch(`${baseUrl}/portal/positions`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as {
      strategySummaries?: Array<{
        strategyId: string;
        strategyName?: string;
        strategyStatus?: string;
        symbol: string;
        equity: string;
        unrealizedPl: string;
        portfolioWeight: string;
        lastDecisionId: string;
        lastExecutionDecision: string;
      }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.strategySummaries?.length, 1);
    assert.equal(body.strategySummaries?.[0]?.strategyId, "33333333-3333-3333-8333-333333333333");
    assert.equal(body.strategySummaries?.[0]?.strategyName, "Cycle-A paper momentum");
    assert.equal(body.strategySummaries?.[0]?.strategyStatus, "active");
    assert.equal(body.strategySummaries?.[0]?.symbol, "AAPL");
    assert.equal(body.strategySummaries?.[0]?.equity, "195.00");
    assert.equal(body.strategySummaries?.[0]?.unrealizedPl, "5.00");
    assert.equal(body.strategySummaries?.[0]?.portfolioWeight, String(195 / 20025));
    assert.equal(body.strategySummaries?.[0]?.lastDecisionId, "22222222-2222-4222-8222-222222222222");
    assert.equal(body.strategySummaries?.[0]?.lastExecutionDecision, "placed");
  });

  it("returns bounded newest-first glass-box decisions to viewer-or-higher roles", async () => {
    const token = idTokenFor("family");
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
    const started = await startPortalServer();

    try {
      const token = idTokenFor("family");
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

describe("portal proposal inbox API", () => {
  it("lists pending proposals to viewer-or-higher roles", async () => {
    const proposalsStore = new InMemoryStrategyProposalsStore();
    await proposalsStore.recordProposal({
      id: "proposal-older",
      suggestedCandidate: {
        name: "Older proposal",
        mandate: "Hold liquid momentum names.",
        suggestedParameters: { maxOpenPositions: 4 }
      },
      quantRationale: "Older quant rationale",
      qualitativeEvidence: { links: [], quotes: [], signals: [] },
      createdAt: "2026-06-17T12:00:00.000Z"
    });
    await proposalsStore.recordProposal({
      id: "proposal-newer",
      suggestedCandidate: {
        name: "Newer proposal",
        mandate: "Tighten the mandate while momentum broadens.",
        suggestedParameters: { minMomentumFraction: 0.02 }
      },
      quantRationale: "Newer quant rationale",
      qualitativeEvidence: { links: [], quotes: [], signals: [] },
      createdAt: "2026-06-17T13:00:00.000Z"
    });
    const started = await startPortalServer({ proposalsStore });

    try {
      const viewerToken = idTokenFor("family");
      const response = await fetch(`${started.baseUrl}/portal/proposals?limit=1`, {
        headers: { authorization: `Bearer ${viewerToken}` }
      });
      const body = (await response.json()) as { proposals?: StrategyProposalRecord[] };

      assert.equal(response.status, 200);
      assert.equal(body.proposals?.length, 1);
      assert.equal(body.proposals?.[0]?.id, "proposal-newer");
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("blocks viewer review before mutating proposals", async () => {
    const proposalsStore = new InMemoryStrategyProposalsStore();
    await proposalsStore.recordProposal({
      id: "proposal-viewer-blocked",
      suggestedCandidate: {
        name: "Viewer blocked",
        mandate: "Operator review required.",
        suggestedParameters: { maxOpenPositions: 4 }
      },
      quantRationale: "Quant rationale",
      qualitativeEvidence: { links: [], quotes: [], signals: [] }
    });
    const started = await startPortalServer({ proposalsStore, strategyStore: new RecordingStrategyStore() });

    try {
      const viewerToken = idTokenFor("family");
      const response = await postJson(started.baseUrl, "/portal/proposals/proposal-viewer-blocked/review", viewerToken, {
        decision: "dismiss"
      });
      const pending = await proposalsStore.listPending();

      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "forbidden" });
      assert.equal(pending.some((proposal) => proposal.id === "proposal-viewer-blocked"), true);
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("accepts a proposal into a draft strategy with defaults merged before deltas", async () => {
    const proposalsStore = new InMemoryStrategyProposalsStore();
    const strategyStore = new RecordingStrategyStore();
    await proposalsStore.recordProposal({
      id: "proposal-accept",
      suggestedCandidate: {
        name: "Quality momentum",
        mandate: "Favor liquid large-cap names with persistent momentum and lower volatility.",
        suggestedParameters: { maxOpenPositions: 3, minMomentumFraction: 0.02 }
      },
      quantRationale: "Momentum breadth improved while volatility cooled.",
      qualitativeEvidence: { links: [], quotes: [], signals: [{ label: "Breadth", value: "improving" }] }
    });
    const started = await startPortalServer({ proposalsStore, strategyStore });

    try {
      const adminToken = idTokenFor("cole");
      const response = await postJson(started.baseUrl, "/portal/proposals/proposal-accept/review", adminToken, {
        decision: "accept"
      });
      const body = (await response.json()) as { strategy?: StrategyRecord; proposal?: StrategyProposalRecord };

      assert.equal(response.status, 200);
      assert.equal(body.strategy?.name, "Quality momentum");
      assert.equal(body.strategy?.description, "Favor liquid large-cap names with persistent momentum and lower volatility.");
      assert.equal(body.strategy?.status, "draft");
      assert.equal(body.strategy?.parameters.minPrice, DEFAULT_QUANT_PLAYBOOK_PARAMETERS.minPrice);
      assert.equal(body.strategy?.parameters.maxOpenPositions, 3);
      assert.equal(body.strategy?.parameters.minMomentumFraction, 0.02);
      assert.equal(body.proposal?.id, "proposal-accept");
      assert.equal(body.proposal?.status, "reviewed");
      assert.equal((await proposalsStore.listPending()).some((proposal) => proposal.id === "proposal-accept"), false);
      assert.equal(strategyStore.calls.at(-1), "createStrategy");
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("dismisses a proposal without creating a strategy", async () => {
    const proposalsStore = new InMemoryStrategyProposalsStore();
    const strategyStore = new RecordingStrategyStore();
    await proposalsStore.recordProposal({
      id: "proposal-dismiss",
      suggestedCandidate: {
        name: "Dismissed proposal",
        mandate: "Do not adopt this candidate.",
        suggestedParameters: { maxOpenPositions: 4 }
      },
      quantRationale: "Weak rationale",
      qualitativeEvidence: { links: [], quotes: [], signals: [] }
    });
    const started = await startPortalServer({ proposalsStore, strategyStore });

    try {
      const adminToken = idTokenFor("cole");
      const response = await postJson(started.baseUrl, "/portal/proposals/proposal-dismiss/review", adminToken, {
        decision: "dismiss"
      });
      const body = (await response.json()) as { proposal?: StrategyProposalRecord };

      assert.equal(response.status, 200);
      assert.equal(body.proposal?.id, "proposal-dismiss");
      assert.equal(body.proposal?.status, "dismissed");
      assert.deepEqual(await strategyStore.listStrategies(), []);
      assert.deepEqual(strategyStore.calls, []);
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("maps unknown proposal ids and bad review bodies", async () => {
    const proposalsStore = new InMemoryStrategyProposalsStore();
    const started = await startPortalServer({ proposalsStore, strategyStore: new RecordingStrategyStore() });

    try {
      const adminToken = idTokenFor("cole");
      const unknownResponse = await postJson(started.baseUrl, "/portal/proposals/unknown-proposal/review", adminToken, {
        decision: "accept"
      });
      const badResponse = await postJson(started.baseUrl, "/portal/proposals/unknown-proposal/review", adminToken, {
        decision: "archive"
      });

      assert.equal(unknownResponse.status, 404);
      assert.deepEqual(await unknownResponse.json(), { error: "proposal_not_found" });
      assert.equal(badResponse.status, 400);
      assert.deepEqual(await badResponse.json(), { error: "invalid_proposal_review_payload" });
    } finally {
      await closeTestServer(started.server);
    }
  });
});

describe("portal strategy registry API", () => {
  let server: Server;
  let baseUrl = "";
  let strategyStore: RecordingStrategyStore;
  let adminToken = "";
  let managerToken = "";
  let viewerToken = "";

  before(async () => {
    strategyStore = new RecordingStrategyStore();
    const started = await startPortalServer({ strategyStore });
    server = started.server;
    baseUrl = started.baseUrl;
    adminToken = idTokenFor("cole");
    managerToken = idTokenFor("brother");
    viewerToken = idTokenFor("family");
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("creates strategies through the admin boundary and ignores client lifecycle fields", async () => {
    const response = await postJson(baseUrl, "/portal/strategies", adminToken, {
      id: "client-supplied-id",
      name: "  Momentum income  ",
      description: "Operator-authored strategy",
      status: "active",
      parameters: strategyParameters()
    });
    const body = (await response.json()) as StrategyRecord;

    assert.equal(response.status, 201);
    assert.equal(body.name, "Momentum income");
    assert.equal(body.description, "Operator-authored strategy");
    assert.equal(body.status, "draft");
    assert.notEqual(body.id, "client-supplied-id");
    assert.equal(strategyStore.calls.at(-1), "createStrategy");
  });

  it("lists all strategies to admin and manager but hides drafts from viewers", async () => {
    const draft = await strategyStore.createStrategy({ name: "Viewer-hidden draft", parameters: strategyParameters() });
    const approved = await strategyStore.createStrategy({ name: "Viewer-visible approved", parameters: strategyParameters() });
    await strategyStore.approveStrategy(approved.id);

    const adminResponse = await fetch(`${baseUrl}/portal/strategies`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const managerResponse = await fetch(`${baseUrl}/portal/strategies`, {
      headers: { authorization: `Bearer ${managerToken}` }
    });
    const viewerResponse = await fetch(`${baseUrl}/portal/strategies`, {
      headers: { authorization: `Bearer ${viewerToken}` }
    });
    const adminBody = (await adminResponse.json()) as { strategies?: StrategyRecord[] };
    const managerBody = (await managerResponse.json()) as { strategies?: StrategyRecord[] };
    const viewerBody = (await viewerResponse.json()) as { strategies?: StrategyRecord[] };

    assert.equal(adminResponse.status, 200);
    assert.equal(managerResponse.status, 200);
    assert.equal(viewerResponse.status, 200);
    assert.ok(adminBody.strategies?.some((strategy) => strategy.id === draft.id && strategy.status === "draft"));
    assert.ok(managerBody.strategies?.some((strategy) => strategy.id === draft.id && strategy.status === "draft"));
    assert.ok(viewerBody.strategies?.some((strategy) => strategy.id === approved.id));
    assert.equal(viewerBody.strategies?.some((strategy) => strategy.id === draft.id), false);
    assert.equal(viewerBody.strategies?.some((strategy) => strategy.status === "draft"), false);
  });

  it("blocks viewer mutations and unauthenticated strategy reads before store access", async () => {
    const callsBefore = strategyStore.calls.length;
    const viewerResponse = await postJson(baseUrl, "/portal/strategies", viewerToken, {
      name: "Viewer mutation",
      parameters: strategyParameters()
    });
    const unauthenticatedResponse = await fetch(`${baseUrl}/portal/strategies`);

    assert.equal(viewerResponse.status, 403);
    assert.deepEqual(await viewerResponse.json(), { error: "forbidden" });
    assert.equal(unauthenticatedResponse.status, 401);
    assert.deepEqual(await unauthenticatedResponse.json(), { error: "missing_session" });
    assert.equal(strategyStore.calls.length, callsBefore);
  });

  it("updates draft strategy fields through PATCH /portal/strategies/:id", async () => {
    const strategy = await strategyStore.createStrategy({ name: "Patch target", description: "remove me", parameters: strategyParameters() });
    const response = await patchJson(baseUrl, `/portal/strategies/${strategy.id}`, managerToken, {
      name: "Patched target",
      description: null,
      parameters: strategyParameters({ maxOpenPositions: 4 })
    });
    const body = (await response.json()) as StrategyRecord;

    assert.equal(response.status, 200);
    assert.equal(body.name, "Patched target");
    assert.equal(body.description, undefined);
    assert.equal(body.parameters.maxOpenPositions, 4);
    assert.equal(strategyStore.calls.at(-1), "updateStrategy");
  });

  it("routes each lifecycle transition endpoint to the matching store method", async () => {
    const callsBefore = strategyStore.calls.length;
    const discussion = await strategyStore.createStrategy({ name: "Discussion target", parameters: strategyParameters() });
    const discussionResponse = await postJson(baseUrl, `/portal/strategies/${discussion.id}/discuss`, adminToken);
    const discussionBody = (await discussionResponse.json()) as StrategyRecord;

    const draftResponse = await postJson(baseUrl, `/portal/strategies/${discussion.id}/return-to-draft`, adminToken);
    const draftBody = (await draftResponse.json()) as StrategyRecord;

    const approved = await strategyStore.createStrategy({ name: "Approve target", parameters: strategyParameters() });
    const approveResponse = await postJson(baseUrl, `/portal/strategies/${approved.id}/approve`, adminToken);
    const approveBody = (await approveResponse.json()) as StrategyRecord;

    const active = await strategyStore.createStrategy({ name: "Activate target", parameters: strategyParameters() });
    await strategyStore.approveStrategy(active.id);
    const activateResponse = await postJson(baseUrl, `/portal/strategies/${active.id}/activate`, adminToken);
    const activateBody = (await activateResponse.json()) as StrategyRecord;

    const pauseResponse = await postJson(baseUrl, `/portal/strategies/${active.id}/pause`, adminToken, { reason: "Market close" });
    const pauseBody = (await pauseResponse.json()) as StrategyRecord;

    const resumeResponse = await postJson(baseUrl, `/portal/strategies/${active.id}/resume`, adminToken);
    const resumeBody = (await resumeResponse.json()) as StrategyRecord;

    const retireResponse = await postJson(baseUrl, `/portal/strategies/${active.id}/retire`, adminToken, { reason: "Superseded" });
    const retireBody = (await retireResponse.json()) as StrategyRecord;

    assert.equal(discussionResponse.status, 200);
    assert.equal(discussionBody.status, "under_discussion");
    assert.equal(draftResponse.status, 200);
    assert.equal(draftBody.status, "draft");
    assert.equal(approveResponse.status, 200);
    assert.equal(approveBody.status, "approved");
    assert.equal(activateResponse.status, 200);
    assert.equal(activateBody.status, "active");
    assert.equal(pauseResponse.status, 200);
    assert.equal(pauseBody.status, "paused");
    assert.equal(pauseBody.reason, "Market close");
    assert.equal(resumeResponse.status, 200);
    assert.equal(resumeBody.status, "active");
    assert.equal(retireResponse.status, 200);
    assert.equal(retireBody.status, "retired");
    assert.equal(retireBody.reason, "Superseded");
    assert.deepEqual(strategyStore.calls.slice(callsBefore), [
      "createStrategy",
      "startDiscussion",
      "returnToDraft",
      "createStrategy",
      "approveStrategy",
      "createStrategy",
      "approveStrategy",
      "activateStrategy",
      "pauseStrategy",
      "resumeStrategy",
      "retireStrategy"
    ]);
  });

  it("maps unknown ids, invalid transitions, bad bodies, and missing dependencies", async () => {
    const unknownResponse = await postJson(
      baseUrl,
      "/portal/strategies/99999999-9999-4999-8999-999999999999/approve",
      adminToken
    );
    const active = await strategyStore.createStrategy({ name: "Conflict target", parameters: strategyParameters() });
    await strategyStore.approveStrategy(active.id);
    await strategyStore.activateStrategy(active.id);
    const conflictResponse = await postJson(baseUrl, `/portal/strategies/${active.id}/approve`, adminToken);
    const badCreateResponse = await postJson(baseUrl, "/portal/strategies", adminToken, { name: "Bad params", parameters: {} });
    const badUpdateResponse = await patchJson(baseUrl, `/portal/strategies/${active.id}`, adminToken, { status: "active" });
    const badReasonResponse = await postJson(baseUrl, `/portal/strategies/${active.id}/pause`, adminToken, { reason: 42 });
    const missingStarted = await startPortalServer();

    try {
      const token = idTokenFor("cole");
      const missingResponse = await fetch(`${missingStarted.baseUrl}/portal/strategies`, {
        headers: { authorization: `Bearer ${token}` }
      });

      assert.equal(unknownResponse.status, 404);
      assert.deepEqual(await unknownResponse.json(), { error: "strategy_not_found" });
      assert.equal(conflictResponse.status, 409);
      assert.deepEqual(await conflictResponse.json(), { error: "strategy_lifecycle_conflict" });
      assert.equal(badCreateResponse.status, 400);
      assert.deepEqual(await badCreateResponse.json(), { error: "invalid_strategy_payload" });
      assert.equal(badUpdateResponse.status, 400);
      assert.deepEqual(await badUpdateResponse.json(), { error: "invalid_strategy_payload" });
      assert.equal(badReasonResponse.status, 400);
      assert.deepEqual(await badReasonResponse.json(), { error: "invalid_strategy_payload" });
      assert.equal(missingResponse.status, 503);
      assert.deepEqual(await missingResponse.json(), { error: "strategy_store_unavailable" });
    } finally {
      await closeTestServer(missingStarted.server);
    }
  });
});

describe("portal roster API", () => {
  let server: Server;
  let baseUrl = "";
  let sourcesStore: RecordingSourcesStore;
  let adminToken = "";
  let managerToken = "";
  let viewerToken = "";

  before(async () => {
    sourcesStore = new RecordingSourcesStore([
      {
        id: "11111111-1111-4111-8111-111111111111",
        sourceKey: "disabled-rss",
        name: "Disabled RSS",
        sourceType: "rss",
        feedUrl: "https://feeds.example.test/disabled.xml",
        enabled: false,
        qualityRating: 2,
        createdAt: "2026-06-17T10:00:00.000Z",
        updatedAt: "2026-06-17T10:00:00.000Z"
      }
    ]);
    const started = await startPortalServer({ sourcesStore, env: {} });
    server = started.server;
    baseUrl = started.baseUrl;
    adminToken = idTokenFor("cole");
    managerToken = idTokenFor("brother");
    viewerToken = idTokenFor("family");
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("parses exact roster item routes", () => {
    assert.deepEqual(parseRosterRoute("/portal/roster/abc-123"), { id: "abc-123" });
    assert.deepEqual(parseRosterRoute("/portal/roster/%20abc%20123%20"), { id: "abc 123" });
    assert.equal(parseRosterRoute("/portal/roster"), null);
    assert.equal(parseRosterRoute("/portal/roster/abc/delete"), null);
    assert.equal(parseRosterRoute("/portal/strategies/abc"), null);
  });

  it("lists all sources to viewer-or-higher roles", async () => {
    const response = await fetch(`${baseUrl}/portal/roster`, {
      headers: { authorization: `Bearer ${viewerToken}` }
    });
    const body = (await response.json()) as { sources?: SourceRecord[] };

    assert.equal(response.status, 200);
    assert.deepEqual(body.sources?.map((source) => [source.sourceKey, source.enabled]), [["disabled-rss", false]]);
  });

  it("creates, updates, and deletes sources through the admin boundary", async () => {
    const createResponse = await postJson(baseUrl, "/portal/roster", adminToken, {
      sourceKey: "curated-rss",
      name: "Curated RSS",
      sourceType: "rss",
      feedUrl: "https://feeds.example.test/rss.xml",
      enabled: true,
      qualityRating: 5
    });
    const created = (await createResponse.json()) as SourceRecord;
    const updateResponse = await patchJson(baseUrl, `/portal/roster/${created.id}`, managerToken, {
      name: "Updated Curated RSS",
      feed_url: "https://feeds.example.test/updated.xml",
      enabled: false,
      quality_rating: 4
    });
    const updated = (await updateResponse.json()) as SourceRecord;
    const deleteResponse = await deleteJson(baseUrl, `/portal/roster/${created.id}`, adminToken);
    const deleteBody = (await deleteResponse.json()) as { deleted?: boolean };
    const listResponse = await fetch(`${baseUrl}/portal/roster`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const listBody = (await listResponse.json()) as { sources?: SourceRecord[] };

    assert.equal(createResponse.status, 201);
    assert.equal(created.sourceKey, "curated-rss");
    assert.equal(created.sourceType, "rss");
    assert.equal(created.feedUrl, "https://feeds.example.test/rss.xml");
    assert.equal(created.enabled, true);
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.name, "Updated Curated RSS");
    assert.equal(updated.feedUrl, "https://feeds.example.test/updated.xml");
    assert.equal(updated.enabled, false);
    assert.equal(updated.qualityRating, 4);
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(deleteBody, { deleted: true });
    assert.equal(listBody.sources?.some((source) => source.id === created.id), false);
  });

  it("blocks unauthenticated reads and viewer mutations before store access", async () => {
    const callsBefore = sourcesStore.calls.length;
    const unauthenticatedRead = await fetch(`${baseUrl}/portal/roster`);
    const viewerCreate = await postJson(baseUrl, "/portal/roster", viewerToken, {
      sourceKey: "viewer-create",
      name: "Viewer Create",
      feedUrl: "https://feeds.example.test/viewer.xml",
      qualityRating: 3
    });
    const viewerPatch = await patchJson(baseUrl, "/portal/roster/11111111-1111-4111-8111-111111111111", viewerToken, {
      enabled: true
    });
    const viewerDelete = await deleteJson(baseUrl, "/portal/roster/11111111-1111-4111-8111-111111111111", viewerToken);

    assert.equal(unauthenticatedRead.status, 401);
    assert.deepEqual(await unauthenticatedRead.json(), { error: "missing_session" });
    assert.equal(viewerCreate.status, 403);
    assert.deepEqual(await viewerCreate.json(), { error: "forbidden" });
    assert.equal(viewerPatch.status, 403);
    assert.deepEqual(await viewerPatch.json(), { error: "forbidden" });
    assert.equal(viewerDelete.status, 403);
    assert.deepEqual(await viewerDelete.json(), { error: "forbidden" });
    assert.equal(sourcesStore.calls.length, callsBefore);
  });

  it("gates X-handle roster creation behind the feature flag", async () => {
    const disabledResponse = await postJson(baseUrl, "/portal/roster", adminToken, {
      source_key: "x-handle-disabled",
      name: "Disabled X Handle",
      source_type: "x-handle",
      feed_url: "https://x.com/disabled",
      quality_rating: 3
    });
    const enabledStore = new RecordingSourcesStore();
    const enabledStarted = await startPortalServer({
      sourcesStore: enabledStore,
      env: { BELLWETHER_FEATURE_X_HANDLES: "true" }
    });

    try {
      const enabledToken = idTokenFor("cole");
      const enabledResponse = await postJson(enabledStarted.baseUrl, "/portal/roster", enabledToken, {
        source_key: "x-handle-enabled",
        name: "Enabled X Handle",
        source_type: "x-handle",
        feed_url: "https://x.com/enabled",
        quality_rating: 4
      });
      const enabledBody = (await enabledResponse.json()) as SourceRecord;

      assert.equal(disabledResponse.status, 400);
      assert.deepEqual(await disabledResponse.json(), { error: "x_handles_disabled" });
      assert.equal(enabledResponse.status, 201);
      assert.equal(enabledBody.sourceType, "x-handle");
      assert.equal(enabledBody.feedUrl, "https://x.com/enabled");
      assert.deepEqual(enabledStore.calls, ["createSource"]);
    } finally {
      await closeTestServer(enabledStarted.server);
    }
  });

  it("maps invalid payloads, unknown ids, duplicate keys, and missing dependencies", async () => {
    const badRatingResponse = await postJson(baseUrl, "/portal/roster", adminToken, {
      source_key: "bad-rating",
      name: "Bad Rating",
      feed_url: "https://feeds.example.test/bad-rating.xml",
      quality_rating: 6
    });
    const badTypeResponse = await postJson(baseUrl, "/portal/roster", adminToken, {
      source_key: "bad-type",
      name: "Bad Type",
      source_type: "video",
      quality_rating: 3
    });
    const badFeedResponse = await postJson(baseUrl, "/portal/roster", adminToken, {
      source_key: "bad-feed",
      name: "Bad Feed",
      source_type: "atom",
      quality_rating: 3
    });
    const duplicateResponse = await postJson(baseUrl, "/portal/roster", adminToken, {
      source_key: "disabled-rss",
      name: "Duplicate",
      source_type: "rss",
      feed_url: "https://feeds.example.test/duplicate.xml",
      quality_rating: 3
    });
    const unknownPatchResponse = await patchJson(baseUrl, "/portal/roster/99999999-9999-4999-8999-999999999999", adminToken, {
      enabled: false
    });
    const unknownDeleteResponse = await deleteJson(baseUrl, "/portal/roster/99999999-9999-4999-8999-999999999999", adminToken);
    const missingStarted = await startPortalServer();

    try {
      const token = idTokenFor("cole");
      const missingResponse = await fetch(`${missingStarted.baseUrl}/portal/roster`, {
        headers: { authorization: `Bearer ${token}` }
      });

      assert.equal(badRatingResponse.status, 400);
      assert.deepEqual(await badRatingResponse.json(), { error: "invalid_source_payload" });
      assert.equal(badTypeResponse.status, 400);
      assert.deepEqual(await badTypeResponse.json(), { error: "invalid_source_payload" });
      assert.equal(badFeedResponse.status, 400);
      assert.deepEqual(await badFeedResponse.json(), { error: "invalid_source_payload" });
      assert.equal(duplicateResponse.status, 409);
      assert.deepEqual(await duplicateResponse.json(), { error: "source_conflict" });
      assert.equal(unknownPatchResponse.status, 404);
      assert.deepEqual(await unknownPatchResponse.json(), { error: "source_not_found" });
      assert.equal(unknownDeleteResponse.status, 404);
      assert.deepEqual(await unknownDeleteResponse.json(), { error: "source_not_found" });
      assert.equal(missingResponse.status, 503);
      assert.deepEqual(await missingResponse.json(), { error: "sources_store_unavailable" });
    } finally {
      await closeTestServer(missingStarted.server);
    }
  });
});

describe("portal strategy chat API", () => {
  it("persists an advisory formalization reply without mutating the strategy or placing orders", async () => {
    const strategyStore = new RecordingStrategyStore();
    const chatStore = new InMemoryStrategyChatStore();
    const broker = new CountingBrokerAdapter();
    const model = new QueueReasoningModel([
      {
        mode: "formalize",
        content: "Advisory proposal: tighten the strategy to hold fewer open positions while the operator reviews the mandate.",
        proposedParameterDelta: { maxOpenPositions: 3 }
      }
    ]);
    const strategy = await strategyStore.createStrategy({ name: "Chat target", description: "Momentum mandate", parameters: strategyParameters() });
    const originalStrategy = await strategyStore.getStrategy(strategy.id);
    const started = await startPortalServer({
      strategyStore,
      strategyChatStore: chatStore,
      strategyChatModel: model,
      broker
    });

    try {
      const adminToken = idTokenFor("cole");
      const viewerToken = idTokenFor("family");
      const response = await postJson(started.baseUrl, `/portal/strategies/${strategy.id}/chat`, adminToken, {
        content: "Formalize this mandate into a tighter max-open-positions proposal.",
        mode: "formalize"
      });
      const body = (await response.json()) as { message?: StrategyChatMessage };
      const currentStrategy = await strategyStore.getStrategy(strategy.id);
      const historyResponse = await fetch(`${started.baseUrl}/portal/strategies/${strategy.id}/chat`, {
        headers: { authorization: `Bearer ${viewerToken}` }
      });
      const historyBody = (await historyResponse.json()) as { thread?: StrategyChatMessage[] };
      const request = model.requests[0];
      const prompt = JSON.parse(request?.userPrompt ?? "{}") as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.message?.role, "analyst");
      assert.equal(body.message?.metadata?.mode, "formalize");
      assert.deepEqual(body.message?.metadata?.proposedParameterDelta, { maxOpenPositions: 3 });
      assert.deepEqual(currentStrategy, originalStrategy);
      assert.equal(broker.placeOrderCalls, 0);
      assert.equal(historyResponse.status, 200);
      assert.deepEqual(historyBody.thread?.map((message) => message.role), ["user", "analyst"]);
      assert.equal(request?.schemaName, "strategy_chat_turn");
      assert.match(request?.systemPrompt ?? "", /Do not mention broker endpoint class or account mode/u);
      assert.equal((prompt.strategy as { id?: string } | undefined)?.id, strategy.id);
      assert.equal((prompt.quantPlaybookParameters as QuantPlaybookParameters | undefined)?.maxOpenPositions, strategy.parameters.maxOpenPositions);
      assert.equal(prompt.operatorMessage, "Formalize this mandate into a tighter max-open-positions proposal.");
      assert.deepEqual(prompt.priorThread, []);
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("returns brainstorm candidate ideas through the same advisory chat turn", async () => {
    const strategyStore = new RecordingStrategyStore();
    const chatStore = new InMemoryStrategyChatStore();
    const model = new QueueReasoningModel([
      {
        mode: "brainstorm",
        content: "Two candidates are worth discussing; start with a quality momentum variant.",
        candidateIdeas: [
          {
            name: "Quality momentum",
            mandate: "Favor liquid large-cap names with persistent momentum and lower volatility.",
            suggestedParameters: { minMomentumFraction: 0.02, maxVolatilityFraction: 0.06 }
          }
        ]
      }
    ]);
    const strategy = await strategyStore.createStrategy({ name: "Brainstorm target", parameters: strategyParameters() });
    const started = await startPortalServer({
      strategyStore,
      strategyChatStore: chatStore,
      strategyChatModel: model
    });

    try {
      const managerToken = idTokenFor("brother");
      const response = await postJson(started.baseUrl, `/portal/strategies/${strategy.id}/chat`, managerToken, {
        content: "Brainstorm candidate strategies for volatile markets.",
        mode: "brainstorm"
      });
      const body = (await response.json()) as { message?: StrategyChatMessage };

      assert.equal(response.status, 200);
      assert.equal(body.message?.metadata?.mode, "brainstorm");
      assert.equal(body.message?.metadata?.candidateIdeas?.[0]?.name, "Quality momentum");
      assert.deepEqual(body.message?.metadata?.candidateIdeas?.[0]?.suggestedParameters, {
        minMomentumFraction: 0.02,
        maxVolatilityFraction: 0.06
      });
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("gates chat reads and writes and returns 404 for unknown strategies before persisting", async () => {
    const strategyStore = new RecordingStrategyStore();
    const chatStore = new InMemoryStrategyChatStore();
    const model = new QueueReasoningModel([]);
    const strategy = await strategyStore.createStrategy({ name: "Gated chat target", parameters: strategyParameters() });
    const started = await startPortalServer({
      strategyStore,
      strategyChatStore: chatStore,
      strategyChatModel: model
    });

    try {
      const viewerToken = idTokenFor("family");
      const adminToken = idTokenFor("cole");
      const viewerPost = await postJson(started.baseUrl, `/portal/strategies/${strategy.id}/chat`, viewerToken, { content: "try write" });
      const unauthenticatedGet = await fetch(`${started.baseUrl}/portal/strategies/${strategy.id}/chat`);
      const unknownResponse = await postJson(
        started.baseUrl,
        "/portal/strategies/99999999-9999-4999-8999-999999999999/chat",
        adminToken,
        { content: "unknown" }
      );

      assert.equal(viewerPost.status, 403);
      assert.deepEqual(await viewerPost.json(), { error: "forbidden" });
      assert.equal(unauthenticatedGet.status, 401);
      assert.deepEqual(await unauthenticatedGet.json(), { error: "missing_session" });
      assert.equal(unknownResponse.status, 404);
      assert.deepEqual(await unknownResponse.json(), { error: "strategy_not_found" });
      assert.deepEqual(await chatStore.listMessages("99999999-9999-4999-8999-999999999999"), []);
      assert.equal(model.requests.length, 0);
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("persists the user message and a clear fallback when the model fails", async () => {
    const strategyStore = new RecordingStrategyStore();
    const chatStore = new InMemoryStrategyChatStore();
    const model = new QueueReasoningModel([new Error("timeout")]);
    const strategy = await strategyStore.createStrategy({ name: "Fallback target", parameters: strategyParameters() });
    const started = await startPortalServer({
      strategyStore,
      strategyChatStore: chatStore,
      strategyChatModel: model
    });

    try {
      const adminToken = idTokenFor("cole");
      const response = await postJson(started.baseUrl, `/portal/strategies/${strategy.id}/chat`, adminToken, {
        content: "Please formalize despite the outage."
      });
      const body = (await response.json()) as { message?: StrategyChatMessage };
      const thread = await chatStore.listMessages(strategy.id);

      assert.equal(response.status, 200);
      assert.equal(body.message?.metadata?.fallback, true);
      assert.match(body.message?.content ?? "", /could not complete/u);
      assert.deepEqual(thread.map((message) => message.role), ["user", "analyst"]);
      assert.equal(thread[0]?.content, "Please formalize despite the outage.");
    } finally {
      await closeTestServer(started.server);
    }
  });

  it("returns 503 without persisting when the optional strategy chat model is unavailable", async () => {
    const strategyStore = new RecordingStrategyStore();
    const chatStore = new InMemoryStrategyChatStore();
    const strategy = await strategyStore.createStrategy({ name: "No model target", parameters: strategyParameters() });
    const started = await startPortalServer({
      strategyStore,
      strategyChatStore: chatStore
    });

    try {
      const adminToken = idTokenFor("cole");
      const response = await postJson(started.baseUrl, `/portal/strategies/${strategy.id}/chat`, adminToken, {
        content: "Try the chat turn without a model."
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "strategy_chat_model_unavailable" });
      assert.deepEqual(await chatStore.listMessages(strategy.id), []);
    } finally {
      await closeTestServer(started.server);
    }
  });
});

describe("portal runtime control API", () => {
  let server: Server;
  let baseUrl = "";
  let runtimeControl: InMemoryRuntimeControl;

  before(async () => {
    runtimeControl = new InMemoryRuntimeControl();
    const started = await startPortalServer({ runtimeControl });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
  });

  it("returns runtime status to viewer-or-higher roles", async () => {
    const token = idTokenFor("family");
    const response = await fetch(`${baseUrl}/portal/runtime`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as AgentRuntimeStatus;

    assert.equal(response.status, 200);
    assert.equal(body.state, "stopped");
  });

  it("allows admins to start the continuous runtime idempotently", async () => {
    const token = idTokenFor("cole");
    const response = await fetch(`${baseUrl}/portal/runtime/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as AgentRuntimeStatus;
    const repeatResponse = await fetch(`${baseUrl}/portal/runtime/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const repeatBody = (await repeatResponse.json()) as AgentRuntimeStatus;

    assert.equal(response.status, 202);
    assert.equal(repeatResponse.status, 202);
    assert.equal(body.state, "running");
    assert.equal(body.activeJobId, "job-1");
    assert.equal(repeatBody.state, "running");
    assert.equal(repeatBody.activeJobId, "job-1");
    assert.equal(runtimeControl.starts, 1);
  });

  it("allows managers to stop the runtime through the same admin boundary", async () => {
    const token = idTokenFor("brother");
    const response = await fetch(`${baseUrl}/portal/runtime/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const body = (await response.json()) as AgentRuntimeStatus;

    assert.equal(response.status, 200);
    assert.equal(body.state, "stopped");
    assert.equal(body.lastCycle?.status, "cancelled");
    assert.equal(runtimeControl.stops, 1);
  });

  it("allows managers to start and admins to stop through adminBoundaryRoles", async () => {
    const managerToken = idTokenFor("brother");
    const startResponse = await fetch(`${baseUrl}/portal/runtime/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}` }
    });
    const startBody = (await startResponse.json()) as AgentRuntimeStatus;
    const adminToken = idTokenFor("cole");
    const stopResponse = await fetch(`${baseUrl}/portal/runtime/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const stopBody = (await stopResponse.json()) as AgentRuntimeStatus;

    assert.equal(startResponse.status, 202);
    assert.equal(startBody.state, "running");
    assert.equal(startBody.activeJobId, "job-2");
    assert.equal(stopResponse.status, 200);
    assert.equal(stopBody.state, "stopped");
    assert.equal(runtimeControl.starts, 2);
    assert.equal(runtimeControl.stops, 2);
  });

  it("blocks viewers from start and stop controls", async () => {
    const token = idTokenFor("family");
    const startResponse = await fetch(`${baseUrl}/portal/runtime/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const stopResponse = await fetch(`${baseUrl}/portal/runtime/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    assert.equal(startResponse.status, 403);
    assert.equal(stopResponse.status, 403);
    assert.equal(runtimeControl.starts, 2);
    assert.equal(runtimeControl.stops, 2);
  });
});

describe("portal static assets", () => {
  let server: Server;
  let baseUrl = "";
  let staticAssetsDir = "";

  before(async () => {
    staticAssetsDir = await mkdtemp(join(tmpdir(), "atp-portal-"));
    await mkdir(join(staticAssetsDir, "assets"));
    await writeFile(join(staticAssetsDir, "index.html"), "<div id=\"root\"></div>");
    await writeFile(join(staticAssetsDir, "assets", "app.js"), "console.log('portal');");

    const started = await startTestServer({ staticAssetsDir });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await closeTestServer(server);
    await rm(staticAssetsDir, { recursive: true, force: true });
  });

  it("serves the SPA index from the node server", async () => {
    const response = await fetch(`${baseUrl}/`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await response.text(), "<div id=\"root\"></div>");
  });

  it("serves hashed client assets without requiring portal auth", async () => {
    const response = await fetch(`${baseUrl}/assets/app.js`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await response.text(), "console.log('portal');");
  });
});
