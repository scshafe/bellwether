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
  type Role,
  type TrustedProxyAuthConfig
} from "./identity.js";
import type { AgentDecisionLogEntry, AgentDecisionLogStore } from "./agent-team.js";
import type { BrokerAccount, BrokerAdapter, BrokerPosition } from "./broker.js";
import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type QuantPlaybookParameters } from "./quant-playbook.js";
import type { AgentRuntimeControl } from "./runtime-control.js";
import { isFeatureEnabled } from "./config.js";
import {
  SOURCE_TYPES,
  SourceNotFoundError,
  type CreateSourceInput,
  type SourceRecord,
  type SourcesStore,
  type SourceType,
  type UpdateSourcePatch
} from "./qualitative.js";
import {
  fallbackStrategyChatReply,
  StrategyChatAgent,
  type StrategyChatMode,
  type StrategyChatStore
} from "./strategy-chat.js";
import {
  StrategyLifecycleError,
  StrategyNotFoundError,
  validateStrategyParameters,
  type CreateStrategyInput,
  type StrategyRecord,
  type StrategyStore,
  type UpdateStrategyPatch
} from "./strategy.js";
import {
  StrategyProposalNotFoundError,
  type StrategyProposalRecord,
  type StrategyProposalsStore
} from "./strategy-proposals.js";
import type { ReasoningModel } from "./llm.js";

export type ServerOptions = {
  databaseUrl?: string;
  identityProvider?: IdentityProvider;
  broker?: BrokerAdapter;
  decisionLogStore?: AgentDecisionLogStore;
  runtimeControl?: AgentRuntimeControl;
  strategyStore?: StrategyStore;
  proposalsStore?: StrategyProposalsStore;
  strategyChatStore?: StrategyChatStore;
  strategyChatModel?: ReasoningModel;
  sourcesStore?: SourcesStore;
  env?: NodeJS.ProcessEnv;
  staticAssetsDir?: string;
  /** When set, an OIDC reverse proxy owns authentication: requireRole trusts
   *  ONLY the configured identity header (never Bearer tokens) and the
   *  password login route returns 404. See identity.ts. */
  trustedProxyAuth?: TrustedProxyAuthConfig;
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
    if (options.trustedProxyAuth) {
      // Proxy-identity mode: the password lane must be structurally
      // unreachable — the identity provider is never consulted, so no
      // password session can ever be minted while the flag is on.
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    await handleSessionCreate(request, response, options.identityProvider);
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/roles") {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    writeJson(response, 200, { ok: true, user });
    return;
  }

  if (request.method === "GET" && url.pathname === "/family/overview") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    writeJson(response, 200, { ok: true, user });
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/positions") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handlePortalPositions(response, options.broker, options.decisionLogStore, options.strategyStore);
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/decisions") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handlePortalDecisions(response, options.decisionLogStore, parseDecisionLimit(url));
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/proposals") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handlePortalProposals(response, options.proposalsStore, parseDecisionLimit(url));
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/runtime") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRuntimeStatus(response, options.runtimeControl);
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/strategies") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handlePortalStrategies(response, options.strategyStore, user);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/strategies") {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleStrategyCreate(request, response, options.strategyStore);
    return;
  }

  if (request.method === "GET" && url.pathname === "/portal/roster") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRosterList(response, options.sourcesStore);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/roster") {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRosterCreate(request, response, options.sourcesStore, options.env);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/runtime/start") {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRuntimeStart(response, options.runtimeControl);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/runtime/stop") {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRuntimeStop(response, options.runtimeControl);
    return;
  }

  const proposalRoute = parseProposalRoute(url.pathname);
  const strategyRoute = parseStrategyRoute(url.pathname);
  const rosterRoute = parseRosterRoute(url.pathname);

  if (request.method === "POST" && proposalRoute && proposalRoute.action === "review") {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleProposalReview(request, response, options.proposalsStore, options.strategyStore, proposalRoute.id);
    return;
  }

  if (request.method === "PATCH" && rosterRoute) {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRosterUpdate(request, response, options.sourcesStore, rosterRoute.id);
    return;
  }

  if (request.method === "DELETE" && rosterRoute) {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleRosterDelete(response, options.sourcesStore, rosterRoute.id);
    return;
  }

  if (request.method === "GET" && strategyRoute && strategyRoute.action === "chat") {
    const user = await requireRole(request, response, options, familyBoundaryRoles);

    if (!user) {
      return;
    }

    await handleStrategyChatHistory(response, options.strategyStore, options.strategyChatStore, strategyRoute.id);
    return;
  }

  if (request.method === "POST" && strategyRoute && strategyRoute.action === "chat") {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleStrategyChatPost(request, response, options, strategyRoute.id);
    return;
  }

  if (request.method === "PATCH" && strategyRoute && strategyRoute.action === null) {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

    if (!user) {
      return;
    }

    await handleStrategyUpdate(request, response, options.strategyStore, strategyRoute.id);
    return;
  }

  if (request.method === "POST" && strategyRoute && strategyRoute.action !== null) {
    const user = await requireRole(request, response, options, adminBoundaryRoles);

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

async function handlePortalPositions(
  response: ServerResponse,
  broker?: BrokerAdapter,
  decisionLogStore?: AgentDecisionLogStore,
  strategyStore?: StrategyStore
): Promise<void> {
  if (!broker) {
    writeJson(response, 503, { error: "broker_unavailable" });
    return;
  }

  const [account, positions, decisions, strategies] = await Promise.all([
    broker.getAccount(),
    broker.getPositions(),
    decisionLogStore?.listDecisions(250) ?? Promise.resolve([]),
    strategyStore?.listStrategies(250) ?? Promise.resolve([])
  ]);
  writeJson(response, 200, {
    account,
    positions,
    strategySummaries: buildStrategyPerformanceSummaries({ account, positions, decisions, strategies })
  });
}

export type PortalStrategyPerformanceSummary = {
  id: string;
  strategyId: string;
  strategyName?: string;
  strategyStatus?: StrategyRecord["status"];
  symbol: string;
  marketValue: string;
  equity: string;
  unrealizedPl: string;
  unrealizedPlpc?: string;
  portfolioWeight: string;
  lastDecisionAt: string;
  lastDecisionId: string;
  lastExecutionDecision: string;
};

function buildStrategyPerformanceSummaries(input: {
  account: BrokerAccount;
  positions: BrokerPosition[];
  decisions: AgentDecisionLogEntry[];
  strategies: StrategyRecord[];
}): PortalStrategyPerformanceSummary[] {
  const currentPositionsBySymbol = new Map(input.positions.map((position) => [position.symbol, position]));
  const strategiesById = new Map(input.strategies.map((strategy) => [strategy.id, strategy]));
  const latestDecisionByStrategy = new Map<string, AgentDecisionLogEntry>();

  for (const decision of input.decisions) {
    const previous = latestDecisionByStrategy.get(decision.strategyId);

    if (!previous || decision.createdAt.localeCompare(previous.createdAt) > 0) {
      latestDecisionByStrategy.set(decision.strategyId, decision);
    }
  }

  return [...latestDecisionByStrategy.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((decision) => {
      const strategy = strategiesById.get(decision.strategyId);
      const symbol = decision.execution.order?.symbol ?? decision.strategyAnalyst.proposedOrder.symbol ?? decision.quantSignal.symbol;
      const position = currentPositionsBySymbol.get(symbol) ?? decision.brokerSnapshot.positions.find((candidate) => candidate.symbol === symbol);
      const marketValue = position?.marketValue ?? "0";
      const unrealizedPl = position?.unrealizedPl ?? "0";

      return {
        id: decision.strategyId,
        strategyId: decision.strategyId,
        ...(strategy ? { strategyName: strategy.name, strategyStatus: strategy.status } : {}),
        symbol,
        marketValue,
        equity: marketValue,
        unrealizedPl,
        ...(position?.unrealizedPlpc ? { unrealizedPlpc: position.unrealizedPlpc } : {}),
        portfolioWeight: decimalRatioString(marketValue, input.account.equity),
        lastDecisionAt: decision.createdAt,
        lastDecisionId: decision.id,
        lastExecutionDecision: decision.execution.decision
      };
    });
}

function decimalRatioString(numerator: string, denominator: string): string {
  const parsedNumerator = Number(numerator);
  const parsedDenominator = Number(denominator);

  if (!Number.isFinite(parsedNumerator) || !Number.isFinite(parsedDenominator) || parsedDenominator === 0) {
    return "0";
  }

  return String(parsedNumerator / parsedDenominator);
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

async function handlePortalProposals(
  response: ServerResponse,
  proposalsStore: StrategyProposalsStore | undefined,
  limit: number
): Promise<void> {
  if (!proposalsStore) {
    writeJson(response, 503, { error: "proposals_store_unavailable" });
    return;
  }

  writeJson(response, 200, { proposals: await proposalsStore.listPending(limit) });
}

async function handleProposalReview(
  request: IncomingMessage,
  response: ServerResponse,
  proposalsStore: StrategyProposalsStore | undefined,
  strategyStore: StrategyStore | undefined,
  proposalId: string
): Promise<void> {
  if (!proposalsStore) {
    writeJson(response, 503, { error: "proposals_store_unavailable" });
    return;
  }

  const body = await readProposalJsonBody(response, request);

  if (body === invalidJsonBody) {
    return;
  }

  const decision = toProposalReviewDecision(body);

  if (!decision) {
    writeJson(response, 400, { error: "invalid_proposal_review_payload" });
    return;
  }

  if (decision === "dismiss") {
    await writeProposalMutationResult(response, () => markProposalDismissed(proposalsStore, proposalId));
    return;
  }

  if (!strategyStore) {
    writeJson(response, 503, { error: "strategy_store_unavailable" });
    return;
  }

  await writeProposalMutationResult(response, () => acceptProposal(proposalsStore, strategyStore, proposalId));
}

async function markProposalDismissed(
  proposalsStore: StrategyProposalsStore,
  proposalId: string
): Promise<{ proposal: StrategyProposalRecord }> {
  return { proposal: await proposalsStore.markReviewed(proposalId, "dismissed") };
}

async function acceptProposal(
  proposalsStore: StrategyProposalsStore,
  strategyStore: StrategyStore,
  proposalId: string
): Promise<{ strategy: StrategyRecord; proposal: StrategyProposalRecord }> {
  const proposal = await findPendingProposal(proposalsStore, proposalId);
  const parameters = { ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS, ...proposal.suggestedCandidate.suggestedParameters };

  validateStrategyParameters(parameters);

  const strategy = await strategyStore.createStrategy({
    name: proposal.suggestedCandidate.name,
    description: proposal.suggestedCandidate.mandate,
    parameters
  });
  const reviewedProposal = await proposalsStore.markReviewed(proposal.id);

  return { strategy, proposal: reviewedProposal };
}

async function findPendingProposal(proposalsStore: StrategyProposalsStore, proposalId: string): Promise<StrategyProposalRecord> {
  const normalizedId = proposalId.trim();
  const proposal = (await proposalsStore.listPending(100)).find((candidate) => candidate.id === normalizedId);

  if (!proposal) {
    throw new StrategyProposalNotFoundError(proposalId);
  }

  return proposal;
}

async function writeProposalMutationResult(
  response: ServerResponse,
  operation: () => Promise<{ strategy?: StrategyRecord; proposal: StrategyProposalRecord }>
): Promise<void> {
  try {
    writeJson(response, 200, await operation());
  } catch (error: unknown) {
    writeProposalError(response, error);
  }
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

async function handleRosterList(response: ServerResponse, sourcesStore: SourcesStore | undefined): Promise<void> {
  if (!sourcesStore) {
    writeJson(response, 503, { error: "sources_store_unavailable" });
    return;
  }

  writeJson(response, 200, { sources: await sourcesStore.listSources() });
}

async function handleRosterCreate(
  request: IncomingMessage,
  response: ServerResponse,
  sourcesStore: SourcesStore | undefined,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  if (!sourcesStore) {
    writeJson(response, 503, { error: "sources_store_unavailable" });
    return;
  }

  const body = await readSourceJsonBody(response, request);

  if (body === invalidJsonBody) {
    return;
  }

  const input = toCreateSourceInput(body);

  if (!input) {
    writeJson(response, 400, { error: "invalid_source_payload" });
    return;
  }

  if (input.sourceType === "x-handle" && !isFeatureEnabled("x-handles", env)) {
    writeJson(response, 400, { error: "x_handles_disabled" });
    return;
  }

  await writeSourceMutationResult(response, 201, () => sourcesStore.createSource(input));
}

async function handleRosterUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  sourcesStore: SourcesStore | undefined,
  sourceId: string
): Promise<void> {
  if (!sourcesStore) {
    writeJson(response, 503, { error: "sources_store_unavailable" });
    return;
  }

  const body = await readSourceJsonBody(response, request);

  if (body === invalidJsonBody) {
    return;
  }

  const patch = toUpdateSourcePatch(body);

  if (!patch) {
    writeJson(response, 400, { error: "invalid_source_payload" });
    return;
  }

  await writeSourceMutationResult(response, 200, () => sourcesStore.updateSource(sourceId, patch));
}

async function handleRosterDelete(
  response: ServerResponse,
  sourcesStore: SourcesStore | undefined,
  sourceId: string
): Promise<void> {
  if (!sourcesStore) {
    writeJson(response, 503, { error: "sources_store_unavailable" });
    return;
  }

  const deleted = await sourcesStore.deleteSource(sourceId);

  if (!deleted) {
    writeJson(response, 404, { error: "source_not_found" });
    return;
  }

  writeJson(response, 200, { deleted: true });
}

async function writeSourceMutationResult(
  response: ServerResponse,
  successStatus: number,
  operation: () => Promise<SourceRecord>
): Promise<void> {
  try {
    writeJson(response, successStatus, await operation());
  } catch (error: unknown) {
    writeSourceError(response, error);
  }
}

function writeSourceError(response: ServerResponse, error: unknown): void {
  if (error instanceof SourceNotFoundError) {
    writeJson(response, 404, { error: "source_not_found" });
    return;
  }

  if (isSourceConflictError(error)) {
    writeJson(response, 409, { error: "source_conflict" });
    return;
  }

  writeJson(response, 400, { error: "invalid_source_payload" });
}

async function handleStrategyChatHistory(
  response: ServerResponse,
  strategyStore: StrategyStore | undefined,
  chatStore: StrategyChatStore | undefined,
  strategyId: string
): Promise<void> {
  const strategy = await loadChatStrategy(response, strategyStore, strategyId);

  if (!strategy) {
    return;
  }

  if (!chatStore) {
    writeJson(response, 503, { error: "strategy_chat_unavailable" });
    return;
  }

  writeJson(response, 200, { thread: await chatStore.listMessages(strategy.id) });
}

async function handleStrategyChatPost(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
  strategyId: string
): Promise<void> {
  const strategy = await loadChatStrategy(response, options.strategyStore, strategyId);

  if (!strategy) {
    return;
  }

  if (!options.strategyChatStore) {
    writeJson(response, 503, { error: "strategy_chat_unavailable" });
    return;
  }

  if (!options.strategyChatModel) {
    writeJson(response, 503, { error: "strategy_chat_model_unavailable" });
    return;
  }

  let body: unknown;

  try {
    body = await readJsonBody(request);
  } catch {
    writeJson(response, 400, { error: "invalid_json" });
    return;
  }

  const input = toStrategyChatPostInput(body);

  if (!input) {
    writeJson(response, 400, { error: "invalid_chat_payload" });
    return;
  }

  const priorThread = await options.strategyChatStore.listMessages(strategy.id);
  await options.strategyChatStore.appendMessage({ strategyId: strategy.id, role: "user", content: input.content });

  let reply = fallbackStrategyChatReply();

  try {
    reply = await new StrategyChatAgent(options.strategyChatModel).reply({
      strategy,
      operatorMessage: input.content,
      priorThread,
      mode: input.mode
    });
  } catch {
    reply = fallbackStrategyChatReply();
  }

  const message = await options.strategyChatStore.appendMessage({
    strategyId: strategy.id,
    role: "analyst",
    content: reply.content,
    metadata: reply.metadata
  });

  writeJson(response, 200, { message });
}

async function loadChatStrategy(
  response: ServerResponse,
  strategyStore: StrategyStore | undefined,
  strategyId: string
): Promise<StrategyRecord | null> {
  if (!strategyStore) {
    writeJson(response, 503, { error: "strategy_store_unavailable" });
    return null;
  }

  const strategy = await strategyStore.getStrategy(strategyId);

  if (!strategy) {
    writeJson(response, 404, { error: "strategy_not_found" });
    return null;
  }

  return strategy;
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

function writeProposalError(response: ServerResponse, error: unknown): void {
  if (error instanceof StrategyProposalNotFoundError) {
    writeJson(response, 404, { error: "proposal_not_found" });
    return;
  }

  writeJson(response, 400, { error: "invalid_proposal_review_payload" });
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
  options: ServerOptions,
  allowedRoles: readonly Role[]
): Promise<AuthenticatedUser | null> {
  const trustedProxyAuth = options.trustedProxyAuth;

  if (trustedProxyAuth) {
    // Reverse-proxy identity mode. The header is trustworthy only because the
    // OIDC proxy (same netns) is the sole path to this listener and rewrites
    // X-Forwarded-* on every proxied request; anything else in the namespace
    // is a trusted stack member with DB credentials anyway. NEVER fall
    // through to the Bearer path in this mode — the browser client sends a
    // sentinel token that must stay meaningless.
    const raw = request.headers[trustedProxyAuth.headerName];
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const identityAccepted =
      value !== "" && (trustedProxyAuth.allowAnyIdentity || trustedProxyAuth.expectedIdentities.includes(value));

    if (!identityAccepted) {
      writeJson(response, 401, { error: "invalid_session" });
      return null;
    }

    if (!canAccessRole(trustedProxyAuth.user, allowedRoles)) {
      writeJson(response, 403, { error: "forbidden" });
      return null;
    }

    return trustedProxyAuth.user;
  }

  const identityProvider = options.identityProvider;

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

type ProposalRoute = {
  id: string;
  action: string;
};

type RosterRoute = {
  id: string;
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

function parseProposalRoute(pathname: string): ProposalRoute | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "portal" || parts[1] !== "proposals" || parts.length !== 4) {
    return null;
  }

  const id = decodeURIComponent(parts[2] ?? "").trim();

  if (!id) {
    return null;
  }

  return { id, action: parts[3] ?? "" };
}

export function parseRosterRoute(pathname: string): RosterRoute | null {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "portal" || parts[1] !== "roster" || parts.length !== 3) {
    return null;
  }

  const id = decodeURIComponent(parts[2] ?? "").trim();

  if (!id) {
    return null;
  }

  return { id };
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

async function readSourceJsonBody(response: ServerResponse, request: IncomingMessage): Promise<unknown | typeof invalidJsonBody> {
  try {
    return await readJsonBody(request);
  } catch {
    writeJson(response, 400, { error: "invalid_json" });
    return invalidJsonBody;
  }
}

async function readProposalJsonBody(response: ServerResponse, request: IncomingMessage): Promise<unknown | typeof invalidJsonBody> {
  try {
    return await readJsonBody(request);
  } catch {
    writeJson(response, 400, { error: "invalid_json" });
    return invalidJsonBody;
  }
}

function toCreateSourceInput(value: unknown): CreateSourceInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const sourceKey = stringField(value, "sourceKey", "source_key");
  const name = stringField(value, "name");
  const sourceType = sourceTypeField(value, "sourceType", "source_type");
  const feedUrl = nullableStringField(value, "feedUrl", "feed_url");
  const enabled = optionalBooleanField(value, "enabled");
  const qualityRating = numberField(value, "qualityRating", "quality_rating");

  if (!sourceKey || !name || sourceType === invalidField || feedUrl === invalidField || enabled === invalidField || qualityRating === undefined) {
    return null;
  }

  if (sourceType !== undefined && sourceType !== "programmatic" && !feedUrl?.trim()) {
    return null;
  }

  if ((sourceType ?? "rss") !== "programmatic" && !feedUrl?.trim()) {
    return null;
  }

  return {
    sourceKey,
    name,
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(feedUrl !== undefined && feedUrl !== null ? { feedUrl } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    qualityRating
  };
}

function toUpdateSourcePatch(value: unknown): UpdateSourcePatch | null {
  if (!isRecord(value)) {
    return null;
  }

  const patch: UpdateSourcePatch = {};

  if (hasAnyField(value, "name")) {
    const name = stringField(value, "name");

    if (!name) {
      return null;
    }

    patch.name = name;
  }

  if (hasAnyField(value, "feedUrl", "feed_url")) {
    const feedUrl = nullableStringField(value, "feedUrl", "feed_url");

    if (feedUrl === invalidField) {
      return null;
    }

    patch.feedUrl = feedUrl;
  }

  if (hasAnyField(value, "enabled")) {
    const enabled = optionalBooleanField(value, "enabled");

    if (enabled === invalidField || enabled === undefined) {
      return null;
    }

    patch.enabled = enabled;
  }

  if (hasAnyField(value, "qualityRating", "quality_rating")) {
    const qualityRating = numberField(value, "qualityRating", "quality_rating");

    if (qualityRating === undefined) {
      return null;
    }

    patch.qualityRating = qualityRating;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  const field = fieldValue(value, ...keys);

  if (field === undefined) {
    return undefined;
  }

  return typeof field === "string" ? field : undefined;
}

function nullableStringField(value: Record<string, unknown>, ...keys: string[]): string | null | undefined | typeof invalidField {
  const field = fieldValue(value, ...keys);

  if (field === undefined) {
    return undefined;
  }

  if (field === null) {
    return null;
  }

  return typeof field === "string" ? field : invalidField;
}

function sourceTypeField(value: Record<string, unknown>, ...keys: string[]): SourceType | undefined | typeof invalidField {
  const field = fieldValue(value, ...keys);

  if (field === undefined) {
    return undefined;
  }

  if (typeof field !== "string" || !SOURCE_TYPES.includes(field as SourceType)) {
    return invalidField;
  }

  return field as SourceType;
}

function optionalBooleanField(value: Record<string, unknown>, ...keys: string[]): boolean | undefined | typeof invalidField {
  const field = fieldValue(value, ...keys);

  if (field === undefined) {
    return undefined;
  }

  return typeof field === "boolean" ? field : invalidField;
}

function numberField(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  const field = fieldValue(value, ...keys);

  if (field === undefined) {
    return undefined;
  }

  return typeof field === "number" ? field : undefined;
}

function fieldValue(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(value, key)) {
      return value[key];
    }
  }

  return undefined;
}

function hasAnyField(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => Object.hasOwn(value, key));
}

function isSourceConflictError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return true;
  }

  return error instanceof Error && /already exists|duplicate|unique/iu.test(error.message);
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

function toProposalReviewDecision(value: unknown): "accept" | "dismiss" | null {
  if (!isRecord(value)) {
    return null;
  }

  return value.decision === "accept" || value.decision === "dismiss" ? value.decision : null;
}

function toStrategyChatPostInput(value: unknown): { content: string; mode?: StrategyChatMode } | null {
  if (!isRecord(value) || typeof value.content !== "string" || !value.content.trim()) {
    return null;
  }

  if (value.mode !== undefined && value.mode !== "formalize" && value.mode !== "brainstorm") {
    return null;
  }

  return {
    content: value.content,
    ...(value.mode ? { mode: value.mode } : {})
  };
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
const invalidField = Symbol("invalidField");
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
