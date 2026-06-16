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
