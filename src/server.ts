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
import type { QuantPlaybookParameters } from "./quant-playbook.js";
import type { AgentRuntimeControl } from "./runtime-control.js";
import {
  StrategyLifecycleError,
  StrategyNotFoundError,
  type CreateStrategyInput,
  type StrategyRecord,
  type StrategyStore,
  type UpdateStrategyPatch
} from "./strategy.js";

export type ServerOptions = {
  databaseUrl?: string;
  identityProvider?: IdentityProvider;
  broker?: BrokerAdapter;
  decisionLogStore?: AgentDecisionLogStore;
  runtimeControl?: AgentRuntimeControl;
  strategyStore?: StrategyStore;
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

  if (request.method === "GET" && url.pathname === "/portal/strategies") {
    const user = await requireRole(request, response, options.identityProvider, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handlePortalStrategies(response, options.strategyStore, user);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/strategies") {
    const user = await requireRole(request, response, options.identityProvider, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleStrategyCreate(request, response, options.strategyStore);
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

  const strategyRoute = parseStrategyRoute(url.pathname);

  if (request.method === "PATCH" && strategyRoute && strategyRoute.action === null) {
    const user = await requireRole(request, response, options.identityProvider, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleStrategyUpdate(request, response, options.strategyStore, strategyRoute.id);
    return;
  }

  if (request.method === "POST" && strategyRoute && strategyRoute.action !== null) {
    const user = await requireRole(request, response, options.identityProvider, adminBoundaryRoles);

    if (!user) {
      return;
    }

    if (!isStrategyAction(strategyRoute.action)) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    await handleStrategyTransition(request, response, options.strategyStore, strategyRoute.id, strategyRoute.action);
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

async function handlePortalStrategies(
  response: ServerResponse,
  strategyStore: StrategyStore | undefined,
  user: AuthenticatedUser
): Promise<void> {
  if (!strategyStore) {
    writeJson(response, 503, { error: "strategy_store_unavailable" });
    return;
  }

  const strategies = await strategyStore.listStrategies();
  writeJson(response, 200, {
    strategies: user.role === "viewer" ? strategies.filter((strategy) => strategy.status !== "draft") : strategies
  });
}

async function handleStrategyCreate(
  request: IncomingMessage,
  response: ServerResponse,
  strategyStore: StrategyStore | undefined
): Promise<void> {
  if (!strategyStore) {
    writeJson(response, 503, { error: "strategy_store_unavailable" });
    return;
  }

  const body = await readStrategyJsonBody(response, request);

  if (body === invalidJsonBody) {
    return;
  }

  const input = toCreateStrategyInput(body);

  if (!input) {
    writeJson(response, 400, { error: "invalid_strategy_payload" });
    return;
  }

  await writeStrategyMutationResult(response, 201, () => strategyStore.createStrategy(input));
}

async function handleStrategyUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  strategyStore: StrategyStore | undefined,
  strategyId: string
): Promise<void> {
  if (!strategyStore) {
    writeJson(response, 503, { error: "strategy_store_unavailable" });
    return;
  }

  const body = await readStrategyJsonBody(response, request);

  if (body === invalidJsonBody) {
    return;
  }

  const patch = toUpdateStrategyPatch(body);

  if (!patch) {
    writeJson(response, 400, { error: "invalid_strategy_payload" });
    return;
  }

  await writeStrategyMutationResult(response, 200, () => strategyStore.updateStrategy(strategyId, patch));
}

async function handleStrategyTransition(
  request: IncomingMessage,
  response: ServerResponse,
  strategyStore: StrategyStore | undefined,
  strategyId: string,
  action: StrategyAction
): Promise<void> {
  if (!strategyStore) {
    writeJson(response, 503, { error: "strategy_store_unavailable" });
    return;
  }

  if (action === "pause" || action === "retire") {
    const body = await readStrategyJsonBody(response, request);

    if (body === invalidJsonBody) {
      return;
    }

    const reason = toOptionalStrategyReason(body);

    if (reason === invalidStrategyReason) {
      writeJson(response, 400, { error: "invalid_strategy_payload" });
      return;
    }

    await writeStrategyMutationResult(response, 200, () =>
      action === "pause" ? strategyStore.pauseStrategy(strategyId, reason) : strategyStore.retireStrategy(strategyId, reason)
    );
    return;
  }

  await writeStrategyMutationResult(response, 200, () => {
    switch (action) {
      case "discuss":
        return strategyStore.startDiscussion(strategyId);
      case "return-to-draft":
        return strategyStore.returnToDraft(strategyId);
      case "approve":
        return strategyStore.approveStrategy(strategyId);
      case "activate":
        return strategyStore.activateStrategy(strategyId);
      case "resume":
        return strategyStore.resumeStrategy(strategyId);
    }
  });
}

async function writeStrategyMutationResult(
  response: ServerResponse,
  successStatus: number,
  operation: () => Promise<StrategyRecord>
): Promise<void> {
  try {
    writeJson(response, successStatus, await operation());
  } catch (error: unknown) {
    writeStrategyError(response, error);
  }
}

function writeStrategyError(response: ServerResponse, error: unknown): void {
  if (error instanceof StrategyNotFoundError) {
    writeJson(response, 404, { error: "strategy_not_found" });
    return;
  }

  if (error instanceof StrategyLifecycleError) {
    writeJson(response, 409, { error: "strategy_lifecycle_conflict" });
    return;
  }

  if (error instanceof Error) {
    writeJson(response, 400, { error: "invalid_strategy_payload" });
    return;
  }

  writeJson(response, 400, { error: "invalid_strategy_payload" });
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

type StrategyRoute = {
  id: string;
  action: string | null;
};

type StrategyAction = (typeof strategyActions)[number];

function parseStrategyRoute(pathname: string): StrategyRoute | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "portal" || parts[1] !== "strategies" || parts.length < 3 || parts.length > 4) {
    return null;
  }

  const id = decodeURIComponent(parts[2] ?? "").trim();

  if (!id) {
    return null;
  }

  return { id, action: parts[3] ?? null };
}

function isStrategyAction(action: string): action is StrategyAction {
  return strategyActions.includes(action as StrategyAction);
}

async function readStrategyJsonBody(response: ServerResponse, request: IncomingMessage): Promise<unknown | typeof invalidJsonBody> {
  try {
    return await readJsonBody(request);
  } catch {
    writeJson(response, 400, { error: "invalid_json" });
    return invalidJsonBody;
  }
}

function toCreateStrategyInput(value: unknown): CreateStrategyInput | null {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }

  if (value.description !== undefined && typeof value.description !== "string") {
    return null;
  }

  const parameters = toQuantPlaybookParameters(value.parameters);

  if (!parameters) {
    return null;
  }

  return {
    name: value.name,
    ...(value.description !== undefined ? { description: value.description } : {}),
    parameters
  };
}

function toUpdateStrategyPatch(value: unknown): UpdateStrategyPatch | null {
  if (!isRecord(value)) {
    return null;
  }

  const patch: UpdateStrategyPatch = {};

  if (value.name !== undefined) {
    if (typeof value.name !== "string") {
      return null;
    }

    patch.name = value.name;
  }

  if (value.description !== undefined) {
    if (typeof value.description !== "string" && value.description !== null) {
      return null;
    }

    patch.description = value.description;
  }

  if (value.parameters !== undefined) {
    const parameters = toQuantPlaybookParameters(value.parameters);

    if (!parameters) {
      return null;
    }

    patch.parameters = parameters;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function toOptionalStrategyReason(value: unknown): string | undefined | typeof invalidStrategyReason {
  if (value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    return invalidStrategyReason;
  }

  if (value.reason === undefined) {
    return undefined;
  }

  return typeof value.reason === "string" ? value.reason : invalidStrategyReason;
}

function toQuantPlaybookParameters(value: unknown): QuantPlaybookParameters | null {
  if (!isRecord(value)) {
    return null;
  }

  const parameters: Partial<QuantPlaybookParameters> = {};

  for (const key of quantPlaybookParameterKeys) {
    const parameter = value[key];

    if (typeof parameter !== "number" || !Number.isFinite(parameter)) {
      return null;
    }

    parameters[key] = parameter;
  }

  return parameters as QuantPlaybookParameters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

const strategyActions = ["discuss", "return-to-draft", "approve", "activate", "pause", "resume", "retire"] as const;
const invalidJsonBody = Symbol("invalidJsonBody");
const invalidStrategyReason = Symbol("invalidStrategyReason");
const quantPlaybookParameterKeys = [
  "minPrice",
  "minAverageDollarVolume",
  "signalLookbackBars",
  "minMomentumFraction",
  "maxVolatilityFraction",
  "volatilityPenalty",
  "maxPositionNotional",
  "maxPositionEquityFraction",
  "maxSectorEquityFraction",
  "maxLiquidityParticipationFraction",
  "maxOpenPositions",
  "dailyDrawdownStopFraction"
] as const;
