import {
  ALPACA_PAPER_BROKER_ACCOUNT_ID,
  AlpacaPaperAdapter,
  createAlpacaPaperSecretsStore
} from "./broker.js";
import { ensureAgentDecisionLogSchema, PostgresAgentDecisionLogStore } from "./agent-team.js";
import { createPool } from "./db.js";
import { InMemoryIdentityProvider, type InMemoryIdentityRecord, type Role } from "./identity.js";
import { readDatabaseUrlConfig, readServerEndpointsConfig } from "./placement.js";
import { ensureAgentRuntimeControlSchema, PostgresAgentRuntimeControl } from "./runtime-control.js";
import { SecretsBackedBrokerCredentialVault } from "./secrets.js";
import { createServer } from "./server.js";

const endpoints = readServerEndpointsConfig();
const { databaseUrl } = readDatabaseUrlConfig();
const pool = createPool(databaseUrl);

await ensureAgentDecisionLogSchema(pool);
await ensureAgentRuntimeControlSchema(pool);

const brokerCredentialVault = new SecretsBackedBrokerCredentialVault(await createAlpacaPaperSecretsStore());
const server = createServer({
  databaseUrl,
  identityProvider: createIdentityProvider(process.env),
  broker: new AlpacaPaperAdapter(brokerCredentialVault, ALPACA_PAPER_BROKER_ACCOUNT_ID),
  decisionLogStore: new PostgresAgentDecisionLogStore(pool),
  runtimeControl: new PostgresAgentRuntimeControl(pool),
  staticAssetsDir: process.env.PORTAL_STATIC_DIR ?? new URL("../client/dist", import.meta.url).pathname
});

process.on("SIGINT", () => {
  server.close(() => {
    void pool.end();
  });
});

process.on("SIGTERM", () => {
  server.close(() => {
    void pool.end();
  });
});

server.listen(endpoints.port, endpoints.host, () => {
  console.log(`agent-trading-platform server listening on ${endpoints.publicBaseUrl}`);
});

function createIdentityProvider(config: NodeJS.ProcessEnv): InMemoryIdentityProvider {
  const adminUser: InMemoryIdentityRecord = {
    id: config.PORTAL_ADMIN_ID ?? "portal-admin",
    username: config.PORTAL_ADMIN_USERNAME ?? "admin",
    displayName: config.PORTAL_ADMIN_DISPLAY_NAME ?? "Administrator",
    role: parseRole(config.PORTAL_ADMIN_ROLE ?? "admin"),
    password: config.PORTAL_ADMIN_PASSWORD ?? "change-me"
  };

  return new InMemoryIdentityProvider([adminUser]);
}

function parseRole(value: string): Role {
  if (value === "admin" || value === "manager" || value === "viewer") {
    return value;
  }

  throw new Error(`unknown PORTAL_ADMIN_ROLE ${value}`);
}
