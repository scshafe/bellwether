import {
  ALPACA_PAPER_BROKER_ACCOUNT_ID,
  createAlpacaPaperSecretsStore
} from "./broker.js";
import { createBrokerAdapter, ensureBrokerFlipLogSchema, paperFlipState } from "./broker-flip.js";
import { ensureAgentDecisionLogSchema, PostgresAgentDecisionLogStore } from "./agent-team.js";
import { createPool } from "./db.js";
import { readDatabaseUrlConfig, readServerEndpointsConfig } from "./placement.js";
import { createPortalIdentityResolver, readPortalIdentityConfig } from "./portal-identity.js";
import { ensurePortalUsersSchema, PostgresPortalUsersStore } from "./portal-users.js";
import { ensureQualitativeItemsSchema, ensureSourcesSchema, PostgresSourcesStore } from "./qualitative.js";
import { ensureAgentRuntimeControlSchema, PostgresAgentRuntimeControl } from "./runtime-control.js";
import { SecretsBackedBrokerCredentialVault } from "./secrets.js";
import { createServer } from "./server.js";
import { ensureStrategiesSchema, PostgresStrategyStore } from "./strategy.js";
import { createOptionalStrategyChatModel } from "./server-chat-model.js";
import { ensureStrategyChatSchema, PostgresStrategyChatStore } from "./strategy-chat.js";
import { ensureStrategyProposalsSchema, PostgresStrategyProposalsStore } from "./strategy-proposals.js";

const endpoints = readServerEndpointsConfig();
// Read before anything else opens a socket: a portal with no verifiable
// identity source has no way to admit a human, so it must not boot at all.
const identityConfig = readPortalIdentityConfig(process.env);
const { databaseUrl } = readDatabaseUrlConfig();
const pool = createPool(databaseUrl);

await ensureAgentDecisionLogSchema(pool);
await ensureAgentRuntimeControlSchema(pool);
await ensureStrategiesSchema(pool);
await ensureStrategyChatSchema(pool);
await ensureStrategyProposalsSchema(pool);
await ensureBrokerFlipLogSchema(pool);
await ensureSourcesSchema(pool);
await ensureQualitativeItemsSchema(pool);
await ensurePortalUsersSchema(pool);

const portalUsersStore = new PostgresPortalUsersStore(pool);
const brokerCredentialVault = new SecretsBackedBrokerCredentialVault(await createAlpacaPaperSecretsStore());
const server = createServer({
  databaseUrl,
  resolveIdentity: createPortalIdentityResolver(identityConfig, portalUsersStore),
  portalUsersStore,
  broker: await createBrokerAdapter(brokerCredentialVault, ALPACA_PAPER_BROKER_ACCOUNT_ID, paperFlipState()),
  decisionLogStore: new PostgresAgentDecisionLogStore(pool),
  runtimeControl: new PostgresAgentRuntimeControl(pool),
  strategyStore: new PostgresStrategyStore(pool),
  proposalsStore: new PostgresStrategyProposalsStore(pool),
  strategyChatStore: new PostgresStrategyChatStore(pool),
  strategyChatModel: await createOptionalStrategyChatModel(),
  sourcesStore: new PostgresSourcesStore(pool),
  staticAssetsDir: process.env.PORTAL_STATIC_DIR ?? new URL("../client/dist", import.meta.url).pathname,
  publicBaseUrl: endpoints.publicBaseUrl
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
