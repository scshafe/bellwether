import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createLlmSecretsStore,
  createOpenAiOAuthSecretsStore,
  createReasoningModel,
  defaultLlmProviderRegistry,
  LlmProviderRegistry,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_PROVIDER_ID,
  OpenAiOAuthFileCredentialVault,
  OpenAiReasoningModel,
  SecretsBackedLlmCredentialVault,
  type LlmCredentialVault,
  type ReasoningModel
} from "./llm.js";
import { InMemorySecretsStore } from "./secrets.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function sseResponse(contents: string, status = 200): Response {
  return new Response(contents, {
    status,
    headers: { "content-type": "text/event-stream" }
  });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bellwether-llm-"));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("LLM reasoning seam", () => {
  it("preserves the OpenAI API-key chat-completions request and parse behavior", async () => {
    await withTempDir(async (dir) => {
      const credentialFile = join(dir, "llm.env");
      await writeFile(credentialFile, "OPENAI_API_KEY=test-key\nOPENAI_MODEL=credential-model\n", "utf8");
      const store = await createLlmSecretsStore({ filePath: credentialFile });
      const calls: FetchCall[] = [];
      const model = new OpenAiReasoningModel(new SecretsBackedLlmCredentialVault(store), {
        fetchFn: async (url, init) => {
          calls.push({ url: url.toString(), init: init ?? {} });
          return jsonResponse({ choices: [{ message: { content: "{\"ok\":true}" } }] });
        },
        model: "constructor-model"
      });

      assert.deepEqual(
        await model.generateJson({ systemPrompt: "system", userPrompt: "user", schemaName: "sample_schema" }),
        { ok: true }
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://api.openai.com/v1/chat/completions");
      assert.deepEqual(calls[0]?.init.headers, {
        authorization: "Bearer test-key",
        "content-type": "application/json"
      });
      assert.deepEqual(JSON.parse(calls[0]?.init.body as string), {
        model: "credential-model",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "user" }
        ],
        response_format: { type: "json_object" },
        temperature: 0
      });
    });
  });

  it("selects a ReasoningModel through the provider registry", async () => {
    const registry = new LlmProviderRegistry();
    const model: ReasoningModel = { generateJson: async () => ({ provider: "custom" }) };
    registry.register("custom-provider", () => model);

    assert.deepEqual(
      await registry
        .createModel({ getLlmCredential: async () => null }, { providerId: "custom-provider" })
        .generateJson({ systemPrompt: "s", userPrompt: "u", schemaName: "x" }),
      { provider: "custom" }
    );
  });

  it("posts OpenAI OAuth Responses requests and parses output_text SSE deltas", async () => {
    const store = new InMemorySecretsStore({
      "llm-credentials/openai-oauth/kind": "oauth",
      "llm-credentials/openai-oauth/access": "access-token",
      "llm-credentials/openai-oauth/expires": String(Date.now() + 600_000),
      "llm-credentials/openai-oauth/account-id": "account-1",
      "llm-credentials/openai-oauth/model": "oauth-model"
    });
    const calls: FetchCall[] = [];
    const model = defaultLlmProviderRegistry.createModel(new SecretsBackedLlmCredentialVault(store), {
      providerId: OPENAI_OAUTH_PROVIDER_ID,
      fetchFn: async (url, init) => {
        calls.push({ url: url.toString(), init: init ?? {} });
        return sseResponse(
          [
            "event: response.output_text.delta",
            'data: {"delta":"{\\\"ok\\\":"}',
            "",
            "event: response.output_text.delta",
            'data: {"delta":"true}"}',
            "",
            "event: response.completed",
            "data: {}",
            ""
          ].join("\n")
        );
      }
    });

    assert.deepEqual(
      await model.generateJson({ systemPrompt: "System prompt", userPrompt: "User prompt", schemaName: "oauth_schema" }),
      { ok: true }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer access-token");
    assert.equal(headers["chatgpt-account-id"], "account-1");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.accept, "text/event-stream");
    assert.equal(headers.originator, "opencode");
    assert.equal(typeof headers.session_id, "string");
    assert.ok(headers.session_id.length > 0);

    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    assert.equal(body.model, "oauth-model");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.reasoning, { effort: "medium" });
    assert.match(body.instructions as string, /Return ONLY JSON matching the schema named oauth_schema/u);
    assert.deepEqual(body.input, [
      { role: "user", content: [{ type: "input_text", text: "User prompt" }] }
    ]);
    assert.equal("messages" in body, false);
    assert.equal("response_format" in body, false);
    assert.equal("temperature" in body, false);
  });

  it("refreshes expired OAuth runtime credentials and writes back token rotation", async () => {
    await withTempDir(async (dir) => {
      const credentialFile = join(dir, "openai-oauth.json");
      await writeFile(
        credentialFile,
        JSON.stringify({
          type: "oauth",
          refresh: "old-refresh",
          access: "old-access",
          expires: 1000,
          accountId: "account-1",
          model: "file-model"
        }),
        "utf8"
      );
      const calls: FetchCall[] = [];
      const model = createReasoningModel(new OpenAiOAuthFileCredentialVault(credentialFile), {
        providerId: OPENAI_OAUTH_PROVIDER_ID,
        now: () => 10_000,
        fetchFn: async (url, init) => {
          calls.push({ url: url.toString(), init: init ?? {} });

          if (url.toString() === "https://auth.openai.com/oauth/token") {
            return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 120 });
          }

          return sseResponse('event: response.output_text.delta\ndata: {"delta":"{\\"ok\\":true}"}\n\n');
        }
      });

      assert.deepEqual(
        await model.generateJson({ systemPrompt: "system", userPrompt: "user", schemaName: "rotation_schema" }),
        { ok: true }
      );
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.url, "https://auth.openai.com/oauth/token");
      assert.equal(calls[0]?.init.body, `grant_type=refresh_token&refresh_token=old-refresh&client_id=${OPENAI_OAUTH_CLIENT_ID}`);
      assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, "Bearer new-access");

      const persisted = JSON.parse(await readFile(credentialFile, "utf8")) as Record<string, unknown>;
      assert.equal(persisted.access, "new-access");
      assert.equal(persisted.refresh, "new-refresh");
      assert.equal(persisted.expires, 130_000);
      assert.equal(persisted.accountId, "account-1");
    });
  });

  it("keeps sandbox OAuth credentials access-token-only and never refreshes", async () => {
    await withTempDir(async (dir) => {
      const credentialFile = join(dir, "openai-oauth.json");
      await writeFile(
        credentialFile,
        JSON.stringify({
          type: "oauth",
          refresh: "shared-refresh-never-use",
          access: "sandbox-access",
          expires: 1000,
          accountId: "account-1"
        }),
        "utf8"
      );
      const store = await createOpenAiOAuthSecretsStore({ filePath: credentialFile });
      const vault: LlmCredentialVault = new SecretsBackedLlmCredentialVault(store);
      const calls: FetchCall[] = [];
      const model = createReasoningModel(vault, {
        providerId: OPENAI_OAUTH_PROVIDER_ID,
        now: () => 10_000,
        fetchFn: async (url, init) => {
          calls.push({ url: url.toString(), init: init ?? {} });
          return sseResponse('event: response.output_text.delta\ndata: {"delta":"{\\"ok\\":true}"}\n\n');
        }
      });

      assert.deepEqual(await model.generateJson({ systemPrompt: "s", userPrompt: "u", schemaName: "sandbox_schema" }), {
        ok: true
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer sandbox-access");
    });
  });
});
