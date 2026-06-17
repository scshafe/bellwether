import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import {
  adminBoundaryRoles,
  canAccessRole,
  familyBoundaryRoles,
  type AuthCredentials,
  type AuthenticatedUser,
  type IdentityProvider,
  type Role
} from "./identity.js";
import type { AgentDecisionLogStore } from "./agent-team.js";
import type { BrokerAdapter } from "./broker.js";
import type { AgentRuntimeControl } from "./runtime-control.js";

export type ServerOptions = {
  databaseUrl?: string;
  identityProvider?: IdentityProvider;
  broker?: BrokerAdapter;
  decisionLogStore?: AgentDecisionLogStore;
  runtimeControl?: AgentRuntimeControl;
  staticAssetsDir?: string;
};

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions = {}
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, options.databaseUrl ? { ok: true, databaseConfigured: true } : { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/auth/session") {
    await handleSessionCreate(request, response, options.identityProvider);
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/roles") {
    const user = await requireRole(request, response, options.identityProvider, adminBoundaryRoles);

    if (!user) {
      return;
    }

    writeJson(response, 200, { ok: true, user });
    return;
  }

  if (request.method === "GET" && url.pathname === "/family/overview") {
    const user = await requireRole(request, response, options.identityProvider, familyBoundaryRoles);

    if (!user) {
      return;
    }

    writeJson(response, 200, { ok: true, user });
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/positions") {
    const user = await requireRole(request, response, options.identityProvider, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handlePortalPositions(response, options.broker);
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/decisions") {
    const user = await requireRole(request, response, options.identityProvider, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handlePortalDecisions(response, options.decisionLogStore, parseDecisionLimit(url));
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/runtime") {
    const user = await requireRole(request, response, options.identityProvider, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRuntimeStatus(response, options.runtimeControl);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/runtime/start") {
    const user = await requireRole(request, response, options.identityProvider, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRuntimeStart(response, options.runtimeControl);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/runtime/stop") {
    const user = await requireRole(request, response, options.identityProvider, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRuntimeStop(response, options.runtimeControl);
    return;
  }

  if (await handleStaticAssets(request, response, url, options.staticAssetsDir)) {
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

async function handlePortalPositions(response: ServerResponse, broker?: BrokerAdapter): Promise<void> {
  if (!broker) {
    writeJson(response, 503, { error: "broker_unavailable" });
    return;
  }

  const [account, positions] = await Promise.all([broker.getAccount(), broker.getPositions()]);
  writeJson(response, 200, { account, positions });
}

async function handlePortalDecisions(
  response: ServerResponse,
  decisionLogStore: AgentDecisionLogStore | undefined,
  limit: number
): Promise<void> {
  if (!decisionLogStore) {
    writeJson(response, 503, { error: "decision_log_unavailable" });
    return;
  }

  writeJson(response, 200, { decisions: await decisionLogStore.listDecisions(limit), limit });
}

async function handleRuntimeStatus(response: ServerResponse, runtimeControl: AgentRuntimeControl | undefined): Promise<void> {
  if (!runtimeControl) {
    writeJson(response, 503, { error: "runtime_control_unavailable" });
    return;
  }

  writeJson(response, 200, await runtimeControl.getStatus());
}

async function handleRuntimeStart(response: ServerResponse, runtimeControl: AgentRuntimeControl | undefined): Promise<void> {
  if (!runtimeControl) {
    writeJson(response, 503, { error: "runtime_control_unavailable" });
    return;
  }

  writeJson(response, 202, await runtimeControl.start());
}

async function handleRuntimeStop(response: ServerResponse, runtimeControl: AgentRuntimeControl | undefined): Promise<void> {
  if (!runtimeControl) {
    writeJson(response, 503, { error: "runtime_control_unavailable" });
    return;
  }

  writeJson(response, 200, await runtimeControl.stop());
}

async function handleStaticAssets(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  staticAssetsDir: string | undefined
): Promise<boolean> {
  if (!staticAssetsDir || (request.method !== "GET" && request.method !== "HEAD")) {
    return false;
  }

  const root = resolve(staticAssetsDir);
  const requestedPath = safeStaticPath(root, url.pathname);

  if (!requestedPath) {
    writeJson(response, 403, { error: "forbidden" });
    return true;
  }

  const filePath = await readStaticFilePath(requestedPath, root, url.pathname);

  if (!filePath) {
    return false;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": filePath.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache"
    });

    if (request.method === "HEAD") {
      response.end();
      return true;
    }

    response.end(body);
    return true;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function readStaticFilePath(requestedPath: string, root: string, pathname: string): Promise<string | null> {
  const requestedFile = await readableFilePath(requestedPath);

  if (requestedFile) {
    return requestedFile;
  }

  if (extname(pathname)) {
    return null;
  }

  const indexPath = safeStaticPath(root, "/index.html");

  if (!indexPath) {
    return null;
  }

  return readableFilePath(indexPath);
}

async function readableFilePath(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? filePath : null;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function safeStaticPath(root: string, pathname: string): string | null {
  let decodedPath = "/";

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath);

  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return null;
  }

  return candidate;
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".map":
      return "application/json; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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

function parseDecisionLimit(url: URL): number {
  const rawLimit = url.searchParams.get("limit");

  if (!rawLimit) {
    return 50;
  }

  const parsed = Number(rawLimit);

  if (!Number.isFinite(parsed)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
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
