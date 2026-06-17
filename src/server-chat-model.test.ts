import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createOptionalStrategyChatModel } from "./server-chat-model.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bellwether-chat-model-"));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("server Strategy/Analyst chat model composition", () => {
  it("degrades to no chat model when the optional OAuth credential is absent", async () => {
    await withTempDir(async (dir) => {
      const warnings: unknown[][] = [];
      const model = await createOptionalStrategyChatModel({
        filePath: join(dir, "missing-openai-oauth.json"),
        logger: { warn: (...args: unknown[]) => warnings.push(args) }
      });

      assert.equal(model, undefined);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0]), /continuing without optional chat LLM/u);
    });
  });

  it("degrades to no chat model when the optional OAuth credential is invalid", async () => {
    await withTempDir(async (dir) => {
      const credentialFile = join(dir, "openai-oauth.json");
      const warnings: unknown[][] = [];

      await writeFile(credentialFile, "not-json", "utf8");

      const model = await createOptionalStrategyChatModel({
        filePath: credentialFile,
        logger: { warn: (...args: unknown[]) => warnings.push(args) }
      });

      assert.equal(model, undefined);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0]), /continuing without optional chat LLM/u);
    });
  });

  it("constructs the OAuth-backed chat model when the optional credential is valid", async () => {
    await withTempDir(async (dir) => {
      const credentialFile = join(dir, "openai-oauth.json");
      const warnings: unknown[][] = [];

      await writeFile(
        credentialFile,
        JSON.stringify({
          type: "oauth",
          access: "test-access-token",
          expires: Date.now() + 60_000,
          accountId: "account-1"
        }),
        "utf8"
      );

      const model = await createOptionalStrategyChatModel({
        filePath: credentialFile,
        logger: { warn: (...args: unknown[]) => warnings.push(args) }
      });

      assert.equal(typeof model?.generateJson, "function");
      assert.deepEqual(warnings, []);
    });
  });
});
