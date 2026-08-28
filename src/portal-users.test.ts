import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemoryPortalUsersStore,
  isActivePortalUser,
  LastAdminError,
  PortalUserNotFoundError,
  type PortalUsersStore
} from "./portal-users.js";

const cole = { subject: "pocket-id-cole", email: "cole@example.com", displayName: "Cole" };
const brother = { subject: "pocket-id-brother", email: "brother@example.com", displayName: "Brother" };
const stranger = { subject: "pocket-id-stranger", email: "stranger@example.com", displayName: null };

async function storeWithAdmin(): Promise<{ store: PortalUsersStore; adminId: string }> {
  const store = new InMemoryPortalUsersStore();
  const admin = await store.recordSignIn(cole);

  return { store, adminId: admin.id };
}

describe("portal accounts", () => {
  it("links an account to the Pocket ID subject, not the email", async () => {
    const { store, adminId } = await storeWithAdmin();
    // Same person, new email — Pocket ID's sub is what survives a rename.
    const renamed = await store.recordSignIn({ ...cole, email: "cole@newdomain.example" });

    assert.equal(renamed.id, adminId, "a changed email must not create a second account");
    assert.equal(renamed.email, "cole@newdomain.example", "the copy is refreshed for display");
    assert.equal((await store.listUsers()).length, 1);
  });

  it("makes the first account on an empty portal an admin, and only the first", async () => {
    const store = new InMemoryPortalUsersStore();
    const first = await store.recordSignIn(cole);
    const second = await store.recordSignIn(brother);

    assert.equal(first.role, "admin");
    assert.equal(first.status, "active");
    assert.equal(second.role, null);
    assert.equal(second.status, "pending");
  });

  it("enrols an unknown identity as pending, so an admin can see who knocked", async () => {
    const { store } = await storeWithAdmin();
    const knocked = await store.recordSignIn(stranger);

    assert.equal(isActivePortalUser(knocked), false, "knocking is not access");
    assert.equal(knocked.status, "pending");
    assert.deepEqual(
      (await store.listUsers()).map((user) => user.subject).sort(),
      [cole.subject, stranger.subject].sort(),
      "the person appears without anyone transcribing an opaque subject"
    );
  });

  it("grants a role, which activates the account", async () => {
    const { store, adminId } = await storeWithAdmin();
    const pending = await store.recordSignIn(brother);
    const granted = await store.updateUser(pending.id, { role: "manager" }, adminId);

    assert.equal(granted.role, "manager");
    assert.equal(granted.status, "active");
    assert.equal(granted.grantedBy, adminId);
    assert.equal(isActivePortalUser(granted), true);
  });

  it("revokes by clearing the role, which disables the account", async () => {
    const { store, adminId } = await storeWithAdmin();
    const pending = await store.recordSignIn(brother);
    await store.updateUser(pending.id, { role: "viewer" }, adminId);
    const revoked = await store.updateUser(pending.id, { role: null }, adminId);

    assert.equal(revoked.role, null);
    assert.equal(revoked.status, "disabled");
    assert.equal(isActivePortalUser(revoked), false);
  });

  it("keeps a disabled account out even though its role survives for the record", async () => {
    const { store, adminId } = await storeWithAdmin();
    const pending = await store.recordSignIn(brother);
    await store.updateUser(pending.id, { role: "manager" }, adminId);
    const disabled = await store.updateUser(pending.id, { status: "disabled" }, adminId);

    assert.equal(disabled.role, "manager");
    assert.equal(isActivePortalUser(disabled), false, "status alone must be able to shut a door");
  });

  it("refuses to activate an account that holds no role", async () => {
    const { store, adminId } = await storeWithAdmin();
    const pending = await store.recordSignIn(brother);

    await assert.rejects(store.updateUser(pending.id, { status: "active" }, adminId), /no role/u);
  });

  it("refuses to remove the last admin — the lockout has no recovery in the app", async () => {
    const { store, adminId } = await storeWithAdmin();

    await assert.rejects(store.updateUser(adminId, { role: null }, adminId), LastAdminError);
    await assert.rejects(store.updateUser(adminId, { role: "viewer" }, adminId), LastAdminError);
    await assert.rejects(store.updateUser(adminId, { status: "disabled" }, adminId), LastAdminError);
  });

  it("allows an admin to step down once another admin exists", async () => {
    const { store, adminId } = await storeWithAdmin();
    const second = await store.recordSignIn(brother);
    await store.updateUser(second.id, { role: "admin" }, adminId);

    const steppedDown = await store.updateUser(adminId, { role: "viewer" }, second.id);

    assert.equal(steppedDown.role, "viewer");
  });

  it("reports an unknown account as missing", async () => {
    const { store, adminId } = await storeWithAdmin();

    await assert.rejects(store.updateUser("no-such-id", { role: "viewer" }, adminId), PortalUserNotFoundError);
  });
});

describe("the account table holds no credential", () => {
  it("has no password field anywhere in a record, and no way to set one", async () => {
    const { store, adminId } = await storeWithAdmin();
    const user = (await store.listUsers())[0];

    assert.ok(user);

    for (const field of Object.keys(user)) {
      assert.equal(/pass|secret|credential|hash|token/iu.test(field), false, `portal user record exposes ${field}`);
    }

    // Constructed the way a credential system would use it.
    const patched = await store.updateUser(adminId, { role: "admin", password: "change-me" } as never, adminId);

    assert.equal("password" in patched, false, "a password must not survive a patch");
  });

  it("declares no credential column in the schema", async () => {
    const schema = await readSchema();
    // Comments stripped: the file SAYS "no credential column", and that
    // sentence must not be what satisfies the assertion.
    const columns = schema.replace(/--[^\n]*/gu, "");

    assert.equal(/password|secret|credential|hash|token/iu.test(columns), false);
    assert.match(columns, /subject text NOT NULL UNIQUE/u, "the link is the Pocket ID subject");
  });
});

async function readSchema(): Promise<string> {
  const { readFile } = await import("node:fs/promises");

  return readFile(new URL("../db/bootstrap/010_portal_users.sql", import.meta.url), "utf8");
}
