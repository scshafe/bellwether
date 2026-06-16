import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adminBoundaryRoles, canAccessRole, InMemoryIdentityProvider } from "./identity.js";

describe("InMemoryIdentityProvider", () => {
  it("authenticates an admin and resolves the issued session", async () => {
    const provider = new InMemoryIdentityProvider([
      {
        id: "user-cole",
        username: "cole",
        displayName: "Cole",
        role: "admin",
        password: "not-a-real-password"
      }
    ]);

    const session = await provider.authenticate({ username: "cole", password: "not-a-real-password" });

    assert.equal(session?.user.role, "admin");
    assert.equal(session?.user.displayName, "Cole");
    assert.deepEqual(await provider.identifySession(session?.token ?? ""), session?.user);
  });

  it("rejects invalid credentials", async () => {
    const provider = new InMemoryIdentityProvider([
      {
        id: "user-cole",
        username: "cole",
        displayName: "Cole",
        role: "admin",
        password: "not-a-real-password"
      }
    ]);

    assert.equal(await provider.authenticate({ username: "cole", password: "wrong-password" }), null);
  });

  it("treats admin and manager as admin-boundary roles", () => {
    assert.equal(
      canAccessRole({ id: "user-cole", username: "cole", displayName: "Cole", role: "admin" }, adminBoundaryRoles),
      true
    );
    assert.equal(
      canAccessRole({ id: "user-brother", username: "brother", displayName: "Brother", role: "manager" }, adminBoundaryRoles),
      true
    );
    assert.equal(
      canAccessRole({ id: "user-family", username: "family", displayName: "Family", role: "viewer" }, adminBoundaryRoles),
      false
    );
  });
});
