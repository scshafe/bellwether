import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TestOidcIssuer } from "./oidc-test-issuer.js";
import { createPortalIdentityResolver, readPortalIdentityConfig, type PortalIdentityConfig } from "./portal-identity.js";
import { InMemoryPortalUsersStore, type PortalUsersStore } from "./portal-users.js";

const issuer = new TestOidcIssuer();

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORTAL_OIDC_ISSUER: issuer.issuer,
    PORTAL_OIDC_AUDIENCE: issuer.audience,
    ...overrides
  };
}

function testResolver(
  users: PortalUsersStore = new InMemoryPortalUsersStore(),
  config: PortalIdentityConfig = readPortalIdentityConfig(baseEnv())
) {
  return createPortalIdentityResolver(config, users, { fetchImpl: issuer.fetch });
}

/** A portal that already has an admin, so the next arrival is not the
 *  bootstrap case. */
async function establishedPortal(): Promise<PortalUsersStore> {
  const users = new InMemoryPortalUsersStore();
  await users.recordSignIn({ subject: "pocket-id-founder", email: "founder@example.com", displayName: "Founder" });

  return users;
}

describe("portal identity configuration", () => {
  it("reads the issuer, audience and token header — and nothing about people", () => {
    const config = readPortalIdentityConfig(baseEnv());

    assert.equal(config.issuer, issuer.issuer);
    assert.deepEqual(config.audiences, [issuer.audience]);
    assert.equal(config.tokenHeader, "authorization");
    assert.equal("rolesByGroup" in config, false, "who may do what is the database's business, not the environment's");
    assert.equal("rolesByIdentity" in config, false);
  });

  it("refuses to boot without an issuer or an audience", () => {
    assert.throws(() => readPortalIdentityConfig(baseEnv({ PORTAL_OIDC_ISSUER: "" })), /PORTAL_OIDC_ISSUER is required/u);
    assert.throws(() => readPortalIdentityConfig(baseEnv({ PORTAL_OIDC_AUDIENCE: "" })), /PORTAL_OIDC_AUDIENCE is required/u);
    assert.throws(
      () => readPortalIdentityConfig(baseEnv({ PORTAL_OIDC_ISSUER: "http://id.example.test" })),
      /must be an https URL/u
    );
  });
});

describe("the deleted password and trusted-header configuration", () => {
  it("refuses to boot while any retired credential env var is still set", () => {
    for (const retired of [
      "PORTAL_ADMIN_PASSWORD",
      "PORTAL_ADMIN_USERNAME",
      "PORTAL_MANAGER_PASSWORD",
      "PORTAL_VIEWER_PASSWORD",
      "PORTAL_TRUSTED_PROXY_AUTH",
      "PORTAL_TRUSTED_PROXY_IDENTITY",
      "PORTAL_TRUSTED_PROXY_HEADER",
      "PORTAL_ROLE_ADMINS",
      "PORTAL_ROLE_VIEWERS",
      "PORTAL_ROLE_ADMINS_GROUP",
      "PORTAL_ROLE_MANAGERS_GROUP",
      "PORTAL_ROLE_VIEWERS_GROUP"
    ]) {
      assert.throws(
        () => readPortalIdentityConfig(baseEnv({ [retired]: "change-me" })),
        new RegExp(`${retired}.* no longer exist`, "u"),
        `${retired} must be an error, not silently ignored`
      );
    }
  });

  it("exports no identity provider factory and no trusted-proxy config reader", async () => {
    const portalIdentity = (await import("./portal-identity.js")) as Record<string, unknown>;

    assert.equal(portalIdentity.createIdentityProvider, undefined);
    assert.equal(portalIdentity.readTrustedProxyAuthConfig, undefined);
  });
});

describe("portal identity resolution", () => {
  it("resolves the account the verified subject is linked to", async () => {
    const users = new InMemoryPortalUsersStore();
    const resolve = testResolver(users);
    const resolution = await resolve({
      authorization: `Bearer ${issuer.idToken({ sub: "pocket-id-cole", email: "cole@example.com", name: "Cole" })}`
    });

    // First through the door on an empty portal: the bootstrap admin.
    assert.equal(resolution.status, "authenticated");
    assert.equal(resolution.status === "authenticated" && resolution.user.role, "admin");
    assert.equal(resolution.status === "authenticated" && resolution.user.username, "cole@example.com");
    assert.equal(resolution.status === "authenticated" && resolution.user.displayName, "Cole");

    const [account] = await users.listUsers();
    assert.equal(account?.subject, "pocket-id-cole", "the account is keyed on the OIDC subject");
    assert.equal(
      resolution.status === "authenticated" && resolution.user.id,
      account?.id,
      "the portal user id is the account row, not the IdP subject"
    );
  });

  it("gives an arrival on an established portal no access, and enrols them", async () => {
    const users = await establishedPortal();
    const resolve = testResolver(users);
    const resolution = await resolve({
      authorization: `Bearer ${issuer.idToken({ sub: "pocket-id-stranger", email: "stranger@example.com" })}`
    });

    assert.deepEqual(resolution, {
      status: "unprovisioned",
      identity: "stranger@example.com",
      accountStatus: "pending"
    });
    assert.equal((await users.listUsers()).length, 2, "knocking enrols, so an admin can see and grant");
  });

  it("follows a role granted in the portal, with no redeploy", async () => {
    const users = await establishedPortal();
    const resolve = testResolver(users);
    const token = `Bearer ${issuer.idToken({ sub: "pocket-id-brother", email: "brother@example.com" })}`;

    assert.equal((await resolve({ authorization: token })).status, "unprovisioned");

    const pending = (await users.listUsers()).find((user) => user.subject === "pocket-id-brother");
    const admin = (await users.listUsers()).find((user) => user.role === "admin");
    await users.updateUser(pending?.id ?? "", { role: "manager" }, admin?.id ?? "");

    const after = await resolve({ authorization: token });

    assert.equal(after.status === "authenticated" && after.user.role, "manager");
  });

  it("stops following a revoked account on the very next request", async () => {
    const users = new InMemoryPortalUsersStore();
    const resolve = testResolver(users);
    const token = `Bearer ${issuer.idToken({ sub: "pocket-id-cole", email: "cole@example.com" })}`;
    await resolve({ authorization: token });

    const second = await users.recordSignIn({ subject: "second", email: "second@example.com", displayName: null });
    const admin = (await users.listUsers()).find((user) => user.subject === "pocket-id-cole");
    await users.updateUser(second.id, { role: "admin" }, admin?.id ?? "");
    await users.updateUser(admin?.id ?? "", { status: "disabled" }, second.id);

    const after = await resolve({ authorization: token });

    assert.equal(after.status, "unprovisioned");
    assert.equal(after.status === "unprovisioned" && after.accountStatus, "disabled");
  });

  it("keeps one account across an email change, because the link is the subject", async () => {
    const users = new InMemoryPortalUsersStore();
    const resolve = testResolver(users);

    await resolve({ authorization: `Bearer ${issuer.idToken({ sub: "pocket-id-cole", email: "old@example.com" })}` });
    const renamed = await resolve({
      authorization: `Bearer ${issuer.idToken({ sub: "pocket-id-cole", email: "new@example.com" })}`
    });

    assert.equal(renamed.status === "authenticated" && renamed.user.username, "new@example.com");
    assert.equal((await users.listUsers()).length, 1, "a rename must not fork the account");
  });

  it("is anonymous with no token at all", async () => {
    const resolve = testResolver();

    assert.deepEqual(await resolve({}), { status: "anonymous", reason: "missing_token" });
    assert.deepEqual(await resolve({ authorization: "" }), { status: "anonymous", reason: "missing_token" });
    assert.deepEqual(await resolve({ authorization: "Basic Y29sZTpjaGFuZ2UtbWU=" }), {
      status: "anonymous",
      reason: "missing_token"
    });
  });

  it("rejects a token this issuer did not sign, and enrols nobody", async () => {
    const users = await establishedPortal();
    const resolve = testResolver(users);
    const attacker = new TestOidcIssuer({ issuer: issuer.issuer, audience: issuer.audience });
    const resolution = await resolve({
      authorization: `Bearer ${attacker.idToken({ sub: "pocket-id-intruder", email: "intruder@example.com" })}`
    });

    assert.equal(resolution.status, "anonymous");
    assert.equal(resolution.status === "anonymous" && resolution.reason, "invalid_token");
    assert.equal((await users.listUsers()).length, 1, "an unverified token must not create an account");
  });

  it("ignores forwarded identity headers — only a signature carries identity", async () => {
    const resolve = testResolver(await establishedPortal());

    for (const headers of [
      { "x-forwarded-email": "founder@example.com" },
      { "x-forwarded-user": "founder@example.com" },
      { "x-auth-request-email": "founder@example.com" }
    ]) {
      assert.deepEqual(await resolve(headers), { status: "anonymous", reason: "missing_token" });
    }
  });

  it("reads the token from a configured header when the proxy forwards it elsewhere", async () => {
    const config = readPortalIdentityConfig(baseEnv({ PORTAL_OIDC_TOKEN_HEADER: "X-Forwarded-Access-Token" }));
    const resolve = testResolver(new InMemoryPortalUsersStore(), config);

    assert.equal(config.tokenHeader, "x-forwarded-access-token");

    const token = issuer.idToken({ sub: "pocket-id-cole", email: "cole@example.com" });
    const resolution = await resolve({ "x-forwarded-access-token": token });

    assert.equal(resolution.status === "authenticated" && resolution.user.role, "admin");
    assert.deepEqual(await resolve({ authorization: `Bearer ${token}` }), {
      status: "anonymous",
      reason: "missing_token"
    });
  });

  it("reports unavailability, not rejection, when the issuer's keys cannot be fetched", async () => {
    const resolve = createPortalIdentityResolver(readPortalIdentityConfig(baseEnv()), new InMemoryPortalUsersStore(), {
      fetchImpl: async () => new Response("down", { status: 503 })
    });
    const resolution = await resolve({
      authorization: `Bearer ${issuer.idToken({ sub: "pocket-id-cole", email: "cole@example.com" })}`
    });

    assert.equal(resolution.status, "unavailable");
  });

  it("names an account by email, then display name, then subject", async () => {
    const users = await establishedPortal();
    const resolve = testResolver(users);

    await resolve({ authorization: `Bearer ${issuer.idToken({ sub: "no-email", name: "Named" })}` });
    await resolve({ authorization: `Bearer ${issuer.idToken({ sub: "bare-subject" })}` });

    const named = (await users.listUsers()).find((user) => user.subject === "no-email");
    const bare = (await users.listUsers()).find((user) => user.subject === "bare-subject");

    assert.equal(named?.displayName, "Named");
    assert.equal(bare?.email, null);
    assert.equal(bare?.displayName, null, "an account with no claims to copy is still an account");
  });
});
