import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adminBoundaryRoles, canAccessRole, familyBoundaryRoles } from "./identity.js";

describe("role boundaries", () => {
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

  it("admits every role at the family boundary", () => {
    assert.equal(
      canAccessRole({ id: "user-family", username: "family", displayName: "Family", role: "viewer" }, familyBoundaryRoles),
      true
    );
  });
});

describe("the deleted in-app credential system", () => {
  it("exports no identity provider, no password check, and no session mint", async () => {
    // Constructed the way the removed code was used. These names are gone, not
    // disabled: there is nothing left in this module that could check a
    // password or issue a session token.
    const identity = (await import("./identity.js")) as Record<string, unknown>;

    for (const removed of [
      "InMemoryIdentityProvider",
      "IdentityProvider",
      "AuthCredentials",
      "AuthSession",
      "TrustedProxyAuthConfig",
      "InMemoryIdentityRecord"
    ]) {
      assert.equal(identity[removed], undefined, `identity.js still exports ${removed}`);
    }
  });
});
