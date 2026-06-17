import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIdentityProvider } from "./portal-identity.js";

describe("portal identity provisioning", () => {
  it("keeps the single-admin default when optional users are absent", async () => {
    const identityProvider = createIdentityProvider({});
    const adminSession = await identityProvider.authenticate({ username: "admin", password: "change-me" });
    const managerSession = await identityProvider.authenticate({ username: "manager", password: "change-me" });
    const viewerSession = await identityProvider.authenticate({ username: "viewer", password: "change-me" });

    assert.equal(adminSession?.user.role, "admin");
    assert.equal(managerSession, null);
    assert.equal(viewerSession, null);
  });

  it("seeds configured manager and view-only family users", async () => {
    const identityProvider = createIdentityProvider({
      PORTAL_MANAGER_USERNAME: "brother",
      PORTAL_MANAGER_PASSWORD: "manager-password",
      PORTAL_MANAGER_DISPLAY_NAME: "Brother",
      PORTAL_VIEWER_USERNAME: "family",
      PORTAL_VIEWER_PASSWORD: "viewer-password",
      PORTAL_VIEWER_DISPLAY_NAME: "Family"
    });
    const managerSession = await identityProvider.authenticate({ username: "brother", password: "manager-password" });
    const viewerSession = await identityProvider.authenticate({ username: "family", password: "viewer-password" });

    assert.equal(managerSession?.user.role, "manager");
    assert.equal(managerSession?.user.displayName, "Brother");
    assert.equal(viewerSession?.user.role, "viewer");
    assert.equal(viewerSession?.user.displayName, "Family");
  });

  it("refuses a seeded set with no admin-or-manager operator", () => {
    assert.throws(
      () => createIdentityProvider({ PORTAL_ADMIN_ROLE: "viewer" }),
      /must seed at least one admin-or-manager/u
    );
  });
});
