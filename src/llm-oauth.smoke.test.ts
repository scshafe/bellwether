import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  createOpenAiOAuthSecretsStore,
  createReasoningModel,
  LLM_OAUTH_CREDENTIAL_FILE,
  OPENAI_OAUTH_PROVIDER_ID,
  SecretsBackedLlmCredentialVault
} from "./llm.js";

async function credentialFileExists(): Promise<boolean> {
  try {
    await access(LLM_OAUTH_CREDENTIAL_FILE);
    return true;
  } catch {
    return false;
  }
}

describe("live OpenAI OAuth reasoning smoke", async () => {
  const hasCredentialFile = await credentialFileExists();

  it(
    "returns structured reasoning through the OpenAI OAuth provider when mounted",
    { skip: hasCredentialFile ? false : `${LLM_OAUTH_CREDENTIAL_FILE} is not mounted` },
    async () => {
      const store = await createOpenAiOAuthSecretsStore();
      const model = createReasoningModel(new SecretsBackedLlmCredentialVault(store), {
        providerId: OPENAI_OAUTH_PROVIDER_ID
      });
      const response = await model.generateJson({
        schemaName: "agent_reasoning_oauth_smoke",
        systemPrompt: "Return JSON only with keys thesis, verdict, and executionDecision.",
        userPrompt:
          "For a mode-blind broker adapter, summarize a tiny within-rails AAPL buy thesis, risk verdict, and execution decision."
      });

      assert.equal(typeof response, "object");
      assert.notEqual(response, null);
      assert.equal(typeof (response as Record<string, unknown>).thesis, "string");
      assert.equal(typeof (response as Record<string, unknown>).verdict, "string");
      assert.equal(typeof (response as Record<string, unknown>).executionDecision, "string");
    }
  );
});
