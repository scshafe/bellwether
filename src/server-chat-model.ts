import {
  createOpenAiOAuthSecretsStore,
  createReasoningModel,
  OPENAI_OAUTH_PROVIDER_ID,
  SecretsBackedLlmCredentialVault,
  type ReasoningModel
} from "./llm.js";
import type { SecretsStore } from "./secrets.js";
import { withStrategyChatSchemaHints } from "./strategy-chat.js";

export type OptionalStrategyChatModelOptions = {
  filePath?: string;
  secretsStore?: SecretsStore;
  logger?: Pick<Console, "warn">;
};

export async function createOptionalStrategyChatModel(
  options: OptionalStrategyChatModelOptions = {}
): Promise<ReasoningModel | undefined> {
  const logger = options.logger ?? console;

  try {
    const llmCredentialVault = new SecretsBackedLlmCredentialVault(
      await createOpenAiOAuthSecretsStore({ filePath: options.filePath, secretsStore: options.secretsStore })
    );

    return withStrategyChatSchemaHints(createReasoningModel(llmCredentialVault, { providerId: OPENAI_OAUTH_PROVIDER_ID }));
  } catch (error) {
    logger.warn(
      "Strategy/Analyst chat model unavailable; continuing without optional chat LLM.",
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}
