import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  createLlmSecretsStore,
  LLM_CREDENTIAL_FILE,
  OpenAiReasoningModel,
  SecretsBackedLlmCredentialVault
} from "./llm.js";

async function credentialFileExists(): Promise<boolean> {
  try {
    await access(LLM_CREDENTIAL_FILE);
    return true;
  } catch {
    return false;
  }
}

describe("live agent reasoning smoke", async () => {
  const hasCredentialFile = await credentialFileExists();

  it(
    "returns structured reasoning when an LLM credential is mounted",
    { skip: hasCredentialFile ? false : `${LLM_CREDENTIAL_FILE} is not mounted` },
    async () => {
      const store = await createLlmSecretsStore();
      const model = new OpenAiReasoningModel(new SecretsBackedLlmCredentialVault(store));
      const response = await model.generateJson({
        schemaName: "agent_reasoning_smoke",
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
