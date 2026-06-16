import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  adminBoundaryRoles,
  canAccessRole,
  familyBoundaryRoles,
  type AuthCredentials,
  type AuthenticatedUser,
  type IdentityProvider,
  type Role
} from "./identity.js";

export type ServerOptions = {
  databaseUrl?: string;
  identityProvider?: IdentityProvider;
};

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions = {}
): Promise<void> {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, options.databaseUrl ? { ok: true, databaseConfigured: true } : { ok: true });
    return;
  }

  if (request.method === "POST" && request.url === "/auth/session") {
    await handleSessionCreate(request, response, options.identityProvider);
    return;
  }

  if (request.method === "GET" && request.url === "/admin/roles") {
    const user = await requireRole(request, response, options.identityProvider, adminBoundaryRoles);

    if (!user) {
      return;
    }

    writeJson(response, 200, { ok: true, user });
    return;
  }

  if (request.method === "GET" && request.url === "/family/overview") {
    const user = await requireRole(request, response, options.identityProvider, familyBoundaryRoles);

    if (!user) {
      return;
    }

    writeJson(response, 200, { ok: true, user });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

export function createServer(options: ServerOptions = {}): Server {
  return createHttpServer((request, response) => {
    handleRequest(request, response, options).catch((error: unknown) => {
      console.error(error);
      writeJson(response, 500, { error: "internal_error" });
    });
  });
}

async function handleSessionCreate(
  request: IncomingMessage,
  response: ServerResponse,
  identityProvider?: IdentityProvider
): Promise<void> {
  if (!identityProvider) {
    writeJson(response, 503, { error: "identity_unavailable" });
    return;
  }

  const body = await readJsonBody(request);

  if (!isAuthCredentials(body)) {
    writeJson(response, 400, { error: "invalid_auth_payload" });
    return;
  }

  const session = await identityProvider.authenticate(body);

  if (!session) {
    writeJson(response, 401, { error: "invalid_credentials" });
    return;
  }

  writeJson(response, 200, session);
}

async function requireRole(
  request: IncomingMessage,
  response: ServerResponse,
  identityProvider: IdentityProvider | undefined,
  allowedRoles: readonly Role[]
): Promise<AuthenticatedUser | null> {
  if (!identityProvider) {
    writeJson(response, 503, { error: "identity_unavailable" });
    return null;
  }

  const token = getBearerToken(request.headers.authorization);

  if (!token) {
    writeJson(response, 401, { error: "missing_session" });
    return null;
  }

  const user = await identityProvider.identifySession(token);

  if (!user) {
    writeJson(response, 401, { error: "invalid_session" });
    return null;
  }

  if (!canAccessRole(user, allowedRoles)) {
    writeJson(response, 403, { error: "forbidden" });
    return null;
  }

  return user;
}

function getBearerToken(authorization: string | string[] | undefined): string | null {
  if (typeof authorization !== "string") {
    return null;
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";

  for await (const chunk of request) {
    body += chunk;
  }

  if (!body) {
    return null;
  }

  return JSON.parse(body) as unknown;
}

function isAuthCredentials(value: unknown): value is AuthCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.username === "string" && typeof candidate.password === "string";
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
