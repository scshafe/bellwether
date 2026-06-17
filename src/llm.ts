import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { requireConfigValue } from "./config.js";
import { InMemorySecretsStore, type SecretsStore } from "./secrets.js";

export const DEFAULT_LLM_PROVIDER_ID = "openai";
export const OPENAI_OAUTH_PROVIDER_ID = "openai-oauth";
export const LLM_CREDENTIAL_FILE = "/srv/bellwether/llm.env";
export const LLM_OAUTH_CREDENTIAL_FILE = "/srv/bellwether/openai-oauth.json";
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_OAUTH_DEFAULT_MODEL = "gpt-5.5";

export type ApiKeyLlmCredential = {
  kind: "apikey";
  apiKey: string;
  model?: string;
};

export type OAuthLlmCredential = {
  kind: "oauth";
  access: string;
  expires: number;
  accountId: string;
  model?: string;
  refresh?: string;
};

export type LlmCredential = ApiKeyLlmCredential | OAuthLlmCredential;

export interface LlmCredentialVault {
  getLlmCredential(providerId: string): Promise<LlmCredential | null>;
  updateLlmCredential?(providerId: string, credential: LlmCredential): Promise<void>;
}

export type LlmJsonRequest = {
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
};

export interface ReasoningModel {
  generateJson(request: LlmJsonRequest): Promise<unknown>;
}

export type Authentication = {
  headers: Record<string, string>;
  model?: string;
};

export interface Authenticator {
  authenticate(): Promise<Authentication>;
}

export type TransportContext = {
  model: string;
  fetchFn: typeof fetch;
  authorizationHeaders: Record<string, string>;
};

export interface ReasoningTransport {
  generateJson(request: LlmJsonRequest, context: TransportContext): Promise<unknown>;
}

export type GenericReasoningModelOptions = {
  fetchFn?: typeof fetch;
  model: string;
};

export class GenericReasoningModel implements ReasoningModel {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly authenticator: Authenticator,
    private readonly transport: ReasoningTransport,
    private readonly options: GenericReasoningModelOptions
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async generateJson(request: LlmJsonRequest): Promise<unknown> {
    const authentication = await this.authenticator.authenticate();

    return this.transport.generateJson(request, {
      model: authentication.model ?? this.options.model,
      fetchFn: this.fetchFn,
      authorizationHeaders: authentication.headers
    });
  }
}

export class SecretsBackedLlmCredentialVault implements LlmCredentialVault {
  constructor(
    private readonly secretsStore: SecretsStore,
    private readonly prefix = "llm-credentials"
  ) {}

  async getLlmCredential(providerId: string): Promise<LlmCredential | null> {
    const kind = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/kind`);

    if (kind === "oauth") {
      return this.getOAuthCredential(providerId);
    }

    return this.getApiKeyCredential(providerId);
  }

  private async getApiKeyCredential(providerId: string): Promise<ApiKeyLlmCredential | null> {
    const apiKey = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/api-key`);
    const model = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/model`);

    if (!apiKey) {
      return null;
    }

    return model ? { kind: "apikey", apiKey, model } : { kind: "apikey", apiKey };
  }

  private async getOAuthCredential(providerId: string): Promise<OAuthLlmCredential | null> {
    const access = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/access`);
    const expires = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/expires`);
    const accountId = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/account-id`);
    const model = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/model`);
    const refresh = await this.secretsStore.getSecret(`${this.prefix}/${providerId}/refresh`);

    if (!access || !expires || !accountId) {
      return null;
    }

    const parsedExpires = Number(expires);

    if (!Number.isFinite(parsedExpires)) {
      throw new Error(`LLM OAuth credential expires must be a millisecond epoch for ${providerId}`);
    }

    return {
      kind: "oauth",
      access,
      expires: parsedExpires,
      accountId,
      ...(model ? { model } : {}),
      ...(refresh ? { refresh } : {})
    };
  }
}

export class OpenAiOAuthFileCredentialVault implements LlmCredentialVault {
  constructor(
    private readonly filePath = process.env.LLM_OAUTH_CREDENTIAL_FILE ?? LLM_OAUTH_CREDENTIAL_FILE,
    private readonly providerId = OPENAI_OAUTH_PROVIDER_ID
  ) {}

  async getLlmCredential(providerId: string): Promise<LlmCredential | null> {
    if (providerId !== this.providerId) {
      return null;
    }

    return parseOpenAiOAuthCredentialFile(await readFile(this.filePath, "utf8"));
  }

  async updateLlmCredential(providerId: string, credential: LlmCredential): Promise<void> {
    if (providerId !== this.providerId || credential.kind !== "oauth") {
      throw new Error(`OpenAI OAuth file vault cannot store credentials for ${providerId}`);
    }

    if (!credential.refresh) {
      throw new Error("OpenAI OAuth runtime credential refresh token is required for write-back");
    }

    await writeFile(
      this.filePath,
      `${JSON.stringify(
        {
          type: "oauth",
          refresh: credential.refresh,
          access: credential.access,
          expires: credential.expires,
          accountId: credential.accountId,
          ...(credential.model ? { model: credential.model } : {})
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

export class ApiKeyAuthenticator implements Authenticator {
  constructor(
    private readonly credentialVault: LlmCredentialVault,
    private readonly providerId = DEFAULT_LLM_PROVIDER_ID
  ) {}

  async authenticate(): Promise<Authentication> {
    const credential = await this.credentialVault.getLlmCredential(this.providerId);

    if (!credential || credential.kind !== "apikey") {
      throw new Error(`LLM API key credentials are missing for ${this.providerId}`);
    }

    return {
      headers: { authorization: `Bearer ${credential.apiKey}` },
      ...(credential.model ? { model: credential.model } : {})
    };
  }
}

export type OpenAiOAuthAuthenticatorOptions = {
  fetchFn?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
};

export class OpenAiOAuthAuthenticator implements Authenticator {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;

  constructor(
    private readonly credentialVault: LlmCredentialVault,
    private readonly providerId = OPENAI_OAUTH_PROVIDER_ID,
    options: OpenAiOAuthAuthenticatorOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  async authenticate(): Promise<Authentication> {
    const credential = await this.credentialVault.getLlmCredential(this.providerId);

    if (!credential || credential.kind !== "oauth") {
      throw new Error(`LLM OAuth credentials are missing for ${this.providerId}`);
    }

    const activeCredential = await this.refreshIfRuntimeWritable(credential);

    return {
      headers: {
        authorization: `Bearer ${activeCredential.access}`,
        "chatgpt-account-id": activeCredential.accountId
      },
      ...(activeCredential.model ? { model: activeCredential.model } : {})
    };
  }

  private async refreshIfRuntimeWritable(credential: OAuthLlmCredential): Promise<OAuthLlmCredential> {
    const shouldRefresh = credential.expires < this.now() + this.refreshSkewMs;

    if (!shouldRefresh || !credential.refresh || !this.credentialVault.updateLlmCredential) {
      return credential;
    }

    const response = await this.fetchFn("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: OPENAI_OAUTH_CLIENT_ID
      }).toString()
    });

    if (!response.ok) {
      throw new Error(`OpenAI OAuth refresh failed: ${response.status} ${await response.text()}`);
    }

    const refreshed = openAiOAuthRefreshResponse(await response.json());
    const updated: OAuthLlmCredential = {
      ...credential,
      access: refreshed.accessToken,
      refresh: refreshed.refreshToken,
      expires: this.now() + refreshed.expiresInSeconds * 1000
    };

    await this.credentialVault.updateLlmCredential(this.providerId, updated);
    return updated;
  }
}

export class ChatCompletionsTransport implements ReasoningTransport {
  async generateJson(request: LlmJsonRequest, context: TransportContext): Promise<unknown> {
    const response = await context.fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        ...context.authorizationHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: context.model,
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

    const body = openAiChatCompletionResponseBody(await response.json());
    return JSON.parse(body);
  }
}

export type CodexResponsesTransportOptions = {
  sessionId?: () => string;
};

export class CodexResponsesTransport implements ReasoningTransport {
  private readonly sessionId: () => string;

  constructor(options: CodexResponsesTransportOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID;
  }

  async generateJson(request: LlmJsonRequest, context: TransportContext): Promise<unknown> {
    const response = await context.fetchFn("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        ...context.authorizationHeaders,
        "content-type": "application/json",
        accept: "text/event-stream",
        originator: "opencode",
        session_id: this.sessionId()
      },
      body: JSON.stringify({
        model: context.model,
        instructions: `${request.systemPrompt}\n\nReturn ONLY JSON matching the schema named ${request.schemaName}.`,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: request.userPrompt }]
          }
        ],
        store: false,
        stream: true,
        reasoning: { effort: "medium" }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI OAuth reasoning request failed: ${response.status} ${await response.text()}`);
    }

    return JSON.parse(outputTextFromSse(await response.text()));
  }
}

export type OpenAiReasoningModelOptions = {
  fetchFn?: typeof fetch;
  providerId?: string;
  model?: string;
};

export class OpenAiReasoningModel extends GenericReasoningModel {
  constructor(credentialVault: LlmCredentialVault, options: OpenAiReasoningModelOptions = {}) {
    super(
      new ApiKeyAuthenticator(credentialVault, options.providerId ?? DEFAULT_LLM_PROVIDER_ID),
      new ChatCompletionsTransport(),
      { fetchFn: options.fetchFn, model: options.model ?? "gpt-4o-mini" }
    );
  }
}

export type LlmProviderConfig = {
  providerId?: string;
  model?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

export type LlmProviderFactory = (credentialVault: LlmCredentialVault, config?: LlmProviderConfig) => ReasoningModel;

export class LlmProviderRegistry {
  private readonly factories = new Map<string, LlmProviderFactory>();

  register(providerId: string, factory: LlmProviderFactory): this {
    this.factories.set(providerId, factory);
    return this;
  }

  createModel(credentialVault: LlmCredentialVault, config: LlmProviderConfig = {}): ReasoningModel {
    const providerId = config.providerId ?? DEFAULT_LLM_PROVIDER_ID;
    const factory = this.factories.get(providerId);

    if (!factory) {
      throw new Error(`LLM provider is not registered: ${providerId}`);
    }

    return factory(credentialVault, { ...config, providerId });
  }
}

export const defaultLlmProviderRegistry = new LlmProviderRegistry()
  .register(DEFAULT_LLM_PROVIDER_ID, (vault, config = {}) => new OpenAiReasoningModel(vault, config))
  .register(
    OPENAI_OAUTH_PROVIDER_ID,
    (vault, config = {}) =>
      new GenericReasoningModel(
        new OpenAiOAuthAuthenticator(vault, OPENAI_OAUTH_PROVIDER_ID, {
          fetchFn: config.fetchFn,
          now: config.now
        }),
        new CodexResponsesTransport(),
        {
          fetchFn: config.fetchFn,
          model: config.model ?? OPENAI_OAUTH_DEFAULT_MODEL
        }
      )
  );

export function createReasoningModel(credentialVault: LlmCredentialVault, config: LlmProviderConfig = {}): ReasoningModel {
  return defaultLlmProviderRegistry.createModel(credentialVault, config);
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

  await secretsStore.setSecret(`llm-credentials/${providerId}/kind`, "apikey");
  await secretsStore.setSecret(`llm-credentials/${providerId}/api-key`, apiKey);

  if (model) {
    await secretsStore.setSecret(`llm-credentials/${providerId}/model`, model);
  }

  return secretsStore;
}

export type OpenAiOAuthSecretsStoreOptions = {
  filePath?: string;
  providerId?: string;
  secretsStore?: SecretsStore;
};

export async function createOpenAiOAuthSecretsStore(options: OpenAiOAuthSecretsStoreOptions = {}): Promise<SecretsStore> {
  const filePath = options.filePath ?? process.env.LLM_OAUTH_CREDENTIAL_FILE ?? LLM_OAUTH_CREDENTIAL_FILE;
  const providerId = options.providerId ?? OPENAI_OAUTH_PROVIDER_ID;
  const secretsStore = options.secretsStore ?? new InMemorySecretsStore();
  const credential = parseOpenAiOAuthCredentialFile(await readFile(filePath, "utf8"));

  await secretsStore.setSecret(`llm-credentials/${providerId}/kind`, "oauth");
  await secretsStore.setSecret(`llm-credentials/${providerId}/access`, credential.access);
  await secretsStore.setSecret(`llm-credentials/${providerId}/expires`, String(credential.expires));
  await secretsStore.setSecret(`llm-credentials/${providerId}/account-id`, credential.accountId);

  if (credential.model) {
    await secretsStore.setSecret(`llm-credentials/${providerId}/model`, credential.model);
  }

  return secretsStore;
}

function openAiChatCompletionResponseBody(body: unknown): string {
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

function outputTextFromSse(contents: string): string {
  let outputText = "";

  for (const block of contents.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
    const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim());

    for (const data of dataLines) {
      if (!data || data === "[DONE]") {
        continue;
      }

      const parsed = parseJsonObject(data);
      const parsedType = typeof parsed?.type === "string" ? parsed.type : undefined;
      const parsedEvent = typeof parsed?.event === "string" ? parsed.event : undefined;
      const eventName = event ?? parsedType ?? parsedEvent;

      // VERIFY against opencode: observed event names are expected to be response.output_text.delta and response.completed.
      if (eventName === "response.output_text.delta" || parsedType === "response.output_text.delta") {
        outputText += outputTextDelta(parsed);
      }
    }
  }

  if (!outputText.trim()) {
    throw new Error("OpenAI OAuth SSE response did not include output_text deltas");
  }

  return outputText;
}

function outputTextDelta(parsed: Record<string, unknown> | null): string {
  if (!parsed) {
    return "";
  }

  for (const key of ["delta", "output_text", "text"]) {
    const value = parsed[key];

    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

function parseJsonObject(contents: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(contents) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function openAiOAuthRefreshResponse(body: unknown): { accessToken: string; refreshToken: string; expiresInSeconds: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("OpenAI OAuth refresh response must be an object");
  }

  const record = body as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresInSeconds = record.expires_in ?? 3600;

  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("OpenAI OAuth refresh response must include access_token");
  }

  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    throw new Error("OpenAI OAuth refresh response must include refresh_token");
  }

  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
    throw new Error("OpenAI OAuth refresh response expires_in must be a number");
  }

  return { accessToken, refreshToken, expiresInSeconds };
}

function parseOpenAiOAuthCredentialFile(contents: string): OAuthLlmCredential {
  const parsed = JSON.parse(contents) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenAI OAuth credential file must contain an object");
  }

  const record = parsed as Record<string, unknown>;
  const type = record.type;
  const access = record.access;
  const refresh = record.refresh;
  const expires = record.expires;
  const accountId = record.accountId;
  const model = record.model;

  if (type !== "oauth") {
    throw new Error("OpenAI OAuth credential file must have type=oauth");
  }

  if (typeof access !== "string" || !access.trim()) {
    throw new Error("OpenAI OAuth credential file must include access");
  }

  if (typeof expires !== "number" || !Number.isFinite(expires)) {
    throw new Error("OpenAI OAuth credential file must include expires as a millisecond epoch");
  }

  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("OpenAI OAuth credential file must include accountId");
  }

  return {
    kind: "oauth",
    access,
    expires,
    accountId,
    ...(typeof refresh === "string" && refresh.trim() ? { refresh } : {}),
    ...(typeof model === "string" && model.trim() ? { model } : {})
  };
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
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
