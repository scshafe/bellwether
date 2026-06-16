import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type ServerOptions = {
  databaseUrl?: string;
};

export function handleRequest(request: IncomingMessage, response: ServerResponse, options: ServerOptions = {}): void {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(options.databaseUrl ? { ok: true, databaseConfigured: true } : { ok: true }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

export function createServer(options: ServerOptions = {}): Server {
  return createHttpServer((request, response) => handleRequest(request, response, options));
}
