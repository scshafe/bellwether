import { readDatabaseUrlConfig, readServerEndpointsConfig } from "./placement.js";
import { createServer } from "./server.js";

const endpoints = readServerEndpointsConfig();
const { databaseUrl } = readDatabaseUrlConfig();

const server = createServer({ databaseUrl });

server.listen(endpoints.port, endpoints.host, () => {
  console.log(`agent-trading-platform server listening on ${endpoints.publicBaseUrl}`);
});
