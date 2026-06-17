import { readFile } from "node:fs/promises";

import { requireConfigValue } from "./config.js";

export interface SecretsStore {
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
}

export class InMemorySecretsStore implements SecretsStore {
  readonly #secrets = new Map<string, string>();

  constructor(initialSecrets: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initialSecrets)) {
      this.#secrets.set(name, value);
    }
  }

  async getSecret(name: string): Promise<string | null> {
    return this.#secrets.get(name) ?? null;
  }

  async setSecret(name: string, value: string): Promise<void> {
    this.#secrets.set(name, value);
  }
}

export type BrokerCredential = {
  keyId: string;
  secretKey: string;
};

export type XApiCredential = {
  bearerToken: string;
};

export const X_API_CREDENTIAL_FILE = "/srv/bellwether/x-api.env";

export interface BrokerCredentialVault {
  getBrokerCredential(brokerAccountId: string): Promise<BrokerCredential | null>;
}

export class SecretsBackedBrokerCredentialVault implements BrokerCredentialVault {
  constructor(
    private readonly secretsStore: SecretsStore,
    private readonly prefix = "broker-credentials"
  ) {}

  async getBrokerCredential(brokerAccountId: string): Promise<BrokerCredential | null> {
    const keyId = await this.secretsStore.getSecret(`${this.prefix}/${brokerAccountId}/key-id`);
    const secretKey = await this.secretsStore.getSecret(`${this.prefix}/${brokerAccountId}/secret-key`);

    if (!keyId || !secretKey) {
      return null;
    }

    return { keyId, secretKey };
  }
}

export interface XApiCredentialVault {
  getXApiCredential(accountId?: string): Promise<XApiCredential | null>;
}

export class SecretsBackedXApiCredentialVault implements XApiCredentialVault {
  constructor(
    private readonly secretsStore: SecretsStore,
    private readonly prefix = "x-api-credentials",
    private readonly defaultAccountId = "default"
  ) {}

  async getXApiCredential(accountId = this.defaultAccountId): Promise<XApiCredential | null> {
    const bearerToken = await this.secretsStore.getSecret(`${this.prefix}/${accountId}/bearer-token`);

    if (!bearerToken) {
      return null;
    }

    return { bearerToken };
  }
}

export type XApiSecretsStoreOptions = {
  filePath?: string;
  accountId?: string;
  secretsStore?: SecretsStore;
};

export async function createXApiSecretsStore(options: XApiSecretsStoreOptions = {}): Promise<SecretsStore> {
  const filePath = options.filePath ?? process.env.X_API_CREDENTIAL_FILE ?? X_API_CREDENTIAL_FILE;
  const accountId = options.accountId ?? "default";
  const secretsStore = options.secretsStore ?? new InMemorySecretsStore();
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return secretsStore;
    }

    throw error;
  }

  const config = parseEnvFile(raw);
  const bearerToken = requireConfigValue(config, "X_BEARER_TOKEN");

  await secretsStore.setSecret(`x-api-credentials/${accountId}/bearer-token`, bearerToken);
  return secretsStore;
}

function parseEnvFile(contents: string): NodeJS.ProcessEnv {
  const config: NodeJS.ProcessEnv = {};

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");

    config[key] = value;
  }

  return config;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
