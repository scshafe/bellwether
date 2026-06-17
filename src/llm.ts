import { readFile } from "node:fs/promises";

import { requireConfigValue } from "./config.js";
import { InMemorySecretsStore, type SecretsStore } from "./secrets.js";

export const DEFAULT_LLM_PROVIDER_ID = "openai";
export const LLM_CREDENTIAL_FILE = "/srv/bellwether/llm.env";

export type LlmCredential = {
  apiKey: string;
  model?: string;
};

export interface LlmCredentialVault {
  getLlmCredential(providerId: string): Promise<LlmCredential | null>;
}

export type LlmJsonRequest = {
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
};

export interface ReasoningModel {
  generateJson(request: LlmJsonRequest): Promise<unknown>;
}

export class SecretsBackedLlmCredentialVault implements LlmCredentialVault {
  constructor(
    private readonly secretsStore: SecretsStore,
    private readonly prefix = "llm-credentials"
  ) {}

  async getLlmCredential(providerId: string): Promise<LlmCredential | null> {
    const apiKey = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/api-key`);
    const model = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/model`);

    if (!apiKey) {
      return null;
    }

    return model ? { apiKey, model } : { apiKey };
  }
}

export type OpenAiReasoningModelOptions = {
  fetchFn?: typeof fetch;
  providerId?: string;
  model?: string;
};

export class OpenAiReasoningModel implements ReasoningModel {
  private readonly fetchFn: typeof fetch;
  private readonly providerId: string;
  private readonly model: string;

  constructor(
    private readonly credentialVault: LlmCredentialVault,
    options: OpenAiReasoningModelOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.providerId = options.providerId ?? DEFAULT_LLM_PROVIDER_ID;
    this.model = options.model ?? "gpt-4o-mini";
  }

  async generateJson(request: LlmJsonRequest): Promise<unknown> {
    const credential = await this.credentialVault.getLlmCredential(this.providerId);

    if (!credential) {
      throw new Error(`LLM credentials are missing for ${this.providerId}`);
    }

    const response = await this.fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: credential.model ?? this.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI reasoning request failed: ${response.status} ${await response.text()}`);
    }

    const body = openAiResponseBody(await response.json());
    return JSON.parse(body);
  }
}

export type LlmSecretsStoreOptions = {
  filePath?: string;
  providerId?: string;
  secretsStore?: SecretsStore;
};

export async function createLlmSecretsStore(options: LlmSecretsStoreOptions = {}): Promise<SecretsStore> {
  const filePath = options.filePath ?? process.env.LLM_CREDENTIAL_FILE ?? LLM_CREDENTIAL_FILE;
  const providerId = options.providerId ?? DEFAULT_LLM_PROVIDER_ID;
  const secretsStore = options.secretsStore ?? new InMemorySecretsStore();
  const config = parseEnvFile(await readFile(filePath, "utf8"));
  const apiKey = requireConfigValue(config, "OPENAI_API_KEY");
  const model = config.OPENAI_MODEL;

  await secretsStore.setSecret(`llm-credentials/${providerId}/api-key`, apiKey);

  if (model) {
    await secretsStore.setSecret(`llm-credentials/${providerId}/model`, model);
  }

  return secretsStore;
}

function openAiResponseBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("OpenAI response must be an object");
  }

  const choices = (body as Record<string, unknown>).choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenAI response must include choices");
  }

  const first = choices[0];

  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("OpenAI choice must be an object");
  }

  const message = (first as Record<string, unknown>).message;

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("OpenAI choice must include a message");
  }

  const content = (message as Record<string, unknown>).content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI message content must be a non-empty string");
  }

  return content;
}

function parseEnvFile(contents: string): NodeJS.ProcessEnv {
  const config: NodeJS.ProcessEnv = {};

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    config[name] = unquoteEnvValue(rawValue);
  }

  return config;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
