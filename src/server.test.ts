import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { InMemoryIdentityProvider, type InMemoryIdentityRecord } from "./identity.js";
import { createServer, type ServerOptions } from "./server.js";

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
