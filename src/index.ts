import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const server = createServer();

server.listen(port, host, () => {
  console.log(`agent-trading-platform server listening on http://${host}:${port}`);
});
