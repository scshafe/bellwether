import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { createXApiSecretsStore, InMemorySecretsStore, SecretsBackedBrokerCredentialVault, SecretsBackedXApiCredentialVault } from "./secrets.js";

describe("InMemorySecretsStore", () => {
  it("stores and reads secrets by name", async () => {
    const store = new InMemorySecretsStore();

    await store.setSecret("identity/session-signing-key", "placeholder-secret");

    assert.equal(await store.getSecret("identity/session-signing-key"), "placeholder-secret");
    assert.equal(await store.getSecret("missing"), null);
  });
});

describe("SecretsBackedBrokerCredentialVault", () => {
  it("returns broker credentials from the secrets seam", async () => {
    const store = new InMemorySecretsStore({
      "broker-credentials/family-paper/key-id": "placeholder-key-id",
      "broker-credentials/family-paper/secret-key": "placeholder-secret-key"
    });
    const vault = new SecretsBackedBrokerCredentialVault(store);

    assert.deepEqual(await vault.getBrokerCredential("family-paper"), {
      keyId: "placeholder-key-id",
      secretKey: "placeholder-secret-key"
    });
  });

  it("does not fabricate broker credentials when a secret is missing", async () => {
    const store = new InMemorySecretsStore({
      "broker-credentials/family-paper/key-id": "placeholder-key-id"
    });
    const vault = new SecretsBackedBrokerCredentialVault(store);

    assert.equal(await vault.getBrokerCredential("family-paper"), null);
  });
});

describe("SecretsBackedXApiCredentialVault", () => {
  it("returns null when the X API bearer token is absent", async () => {
    const vault = new SecretsBackedXApiCredentialVault(new InMemorySecretsStore());

    assert.equal(await vault.getXApiCredential(), null);
  });

  it("returns the mounted X API bearer token", async () => {
    const store = new InMemorySecretsStore({
      "x-api-credentials/default/bearer-token": "placeholder-x-bearer-token"
    });
    const vault = new SecretsBackedXApiCredentialVault(store);

    assert.deepEqual(await vault.getXApiCredential(), { bearerToken: "placeholder-x-bearer-token" });
  });

  it("loads a mounted X API bearer token file and treats an absent file as no credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bellwether-x-api-"));
    const filePath = join(directory, "x-api.env");
    await writeFile(filePath, "X_BEARER_TOKEN=placeholder-file-token\n");

    const present = await createXApiSecretsStore({ filePath });
    const missing = await createXApiSecretsStore({ filePath: join(directory, "missing.env") });

    assert.deepEqual(await new SecretsBackedXApiCredentialVault(present).getXApiCredential(), { bearerToken: "placeholder-file-token" });
    assert.equal(await new SecretsBackedXApiCredentialVault(missing).getXApiCredential(), null);
  });
});
