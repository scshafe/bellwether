import { resolve } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { Pool } from "pg";

import { runAlpacaNewsIngestStream } from "./alpaca-news.js";
import { createAlpacaPaperSecretsStore } from "./broker.js";
import { isFeatureEnabled } from "./config.js";
import { createPool } from "./db.js";
import {
  createReasoningModel,
  OpenAiOAuthFileCredentialVault,
  OPENAI_OAUTH_PROVIDER_ID,
  type ReasoningModel
} from "./llm.js";
import { runLiveTradeCycle, type LiveTradeCycleResult, type RunLiveTradeCycleOptions } from "./live-cycle.js";
import { createAlpacaMarketClock } from "./market-clock.js";
import { runPacedCycleScheduler } from "./paced-cycle-scheduler.js";
import { createAgentRuntime } from "./placement.js";
import { emptyQualitativeEvidence } from "./qualitative-brief.js";
import {
  ensureAlpacaNewsSource,
  ensureQualitativeItemsSchema,
  ensureSourcesSchema,
  PostgresQualitativeItemsStore,
  PostgresSourcesStore,
  runRssAtomIngestPoller,
  type QualitativeItemsStore,
  type SourcesStore
} from "./qualitative.js";
import {
  claimEnabledLiveCycleJob,
  ensureAgentRuntimeControlSchema,
  PostgresAgentRuntimeControl,
  recordLiveCycleFailure,
  recordLiveCycleSuccess,
  type ClaimedRuntimeJob
} from "./runtime-control.js";
import { createXApiSecretsStore, SecretsBackedBrokerCredentialVault, SecretsBackedXApiCredentialVault, type XApiCredentialVault } from "./secrets.js";
import { ensureStrategiesSchema } from "./strategy.js";
import {
  ensureStrategyProposalsSchema,
  PostgresStrategyProposalsStore,
  StrategyProposalAgent,
  type StrategyProposalAgentInput,
  type StrategyProposalAgentOutput,
  type StrategyProposalRecord,
  type StrategyProposalsStore
} from "./strategy-proposals.js";
import { listEnabledXHandleSources, runXHandleIngestPoller } from "./x-handle-ingest.js";

const WORKER_LOCK_ID = 420_001;
const STRATEGY_PROPOSAL_TIMEOUT_MS = 45_000;
const STRATEGY_PROPOSAL_EVERY_N_CYCLES = 3;
const workerPlacement = createAgentRuntime().describeWorkerPlacement();

let shouldRun = true;

process.on("SIGINT", () => {
  shouldRun = false;
});

process.on("SIGTERM", () => {
  shouldRun = false;
});

export async function runWorker(): Promise<void> {
  const pool = createPool();
  const qualitativePollerController = new AbortController();
  const alpacaNewsController = new AbortController();
  const xHandleController = new AbortController();
  let qualitativePoller: Promise<void> | undefined;
  let alpacaNewsStream: Promise<void> | undefined;
  let xHandlePoller: Promise<void> | undefined;

  try {
    await pool.query("SELECT 1");
    await ensureAgentRuntimeControlSchema(pool);
    await ensureStrategiesSchema(pool);
    await ensureSourcesSchema(pool);
    await ensureQualitativeItemsSchema(pool);
    await ensureStrategyProposalsSchema(pool);
    await ensureAlpacaNewsSource(pool);
    const sourcesStore = new PostgresSourcesStore(pool);
    const itemsStore = new PostgresQualitativeItemsStore(pool);
    const strategyProposalsStore = new PostgresStrategyProposalsStore(pool);
    qualitativePoller = runRssAtomIngestPoller({
      sourcesStore,
      itemsStore,
      pollIntervalMs: workerPlacement.qualitativeIngestPollIntervalMs,
      signal: qualitativePollerController.signal,
      logger: console
    });
    const brokerCredentialVault = new SecretsBackedBrokerCredentialVault(await createAlpacaPaperSecretsStore());
    const marketClock = createAlpacaMarketClock(brokerCredentialVault);
    const runtimeControl = new PostgresAgentRuntimeControl(pool);
    const proposalModel = await createOptionalStrategyProposalModel({ timeoutMs: STRATEGY_PROPOSAL_TIMEOUT_MS, logger: console });
    const proposalStep = proposalModel
      ? createStrategyProposalStep({
        store: strategyProposalsStore,
        createModel: async () => proposalModel,
        timeoutMs: STRATEGY_PROPOSAL_TIMEOUT_MS,
        logger: console
      })
      : undefined;
    try {
      alpacaNewsStream = runAlpacaNewsIngestStream({
        credentialVault: brokerCredentialVault,
        itemsStore,
        signal: alpacaNewsController.signal,
        logger: console
      });
    } catch (error: unknown) {
      console.warn(`alpaca news ingest disabled: ${error instanceof Error ? error.message : "unknown credential error"}`);
    }
    xHandlePoller = (await maybeStartXHandleIngestPoller({
      sourcesStore,
      itemsStore,
      credentialVault: new SecretsBackedXApiCredentialVault(await createXApiSecretsStore()),
      pollIntervalMs: workerPlacement.qualitativeIngestPollIntervalMs,
      signal: xHandleController.signal,
      env: process.env,
      logger: console
    })).poller;
    await writeFile(workerPlacement.readyFile, "ready\n");

    await runPacedCycleScheduler({
      cadence: workerPlacement.pacedCadence,
      marketClock,
      isEnabled: async () => (await runtimeControl.getStatus()).state === "running",
      runCycle: async () => runClaimableCycle(pool, workerPlacement.pacedCadence.cycleIntervalMs, { proposalStep }),
      sleep: async (ms) => {
        await delay(ms);
      },
      shouldContinue: () => shouldRun,
      idleIntervalMs: workerPlacement.pollIntervalMs,
      maxSleepMs: workerPlacement.pollIntervalMs,
      logger: console
    });
  } finally {
    qualitativePollerController.abort();
    alpacaNewsController.abort();
    xHandleController.abort();
    await qualitativePoller?.catch((error: unknown) => {
      console.error(error);
    });
    await alpacaNewsStream?.catch((error: unknown) => {
      console.error(error);
    });
    await xHandlePoller?.catch((error: unknown) => {
      console.error(error);
    });
    await rm(workerPlacement.readyFile, { force: true });
    await pool.end();
  }
}

export type XHandleIngestStartOptions = {
  sourcesStore: SourcesStore;
  itemsStore: QualitativeItemsStore;
  credentialVault: XApiCredentialVault;
  pollIntervalMs: number;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "error" | "log" | "warn">;
};

export type XHandleIngestStartResult = {
  poller?: Promise<void>;
};

export async function maybeStartXHandleIngestPoller(options: XHandleIngestStartOptions): Promise<XHandleIngestStartResult> {
  if (!isFeatureEnabled("x-handles", options.env)) {
    return {};
  }

  let credentialPresent = false;
  try {
    credentialPresent = Boolean(await options.credentialVault.getXApiCredential());
  } catch (error: unknown) {
    options.logger?.warn(`X handle ingest disabled: ${error instanceof Error ? error.message : "unknown credential error"}`);
    return {};
  }

  if (!credentialPresent) {
    options.logger?.warn("X handle ingest disabled: missing X API credential");
    return {};
  }

  if ((await listEnabledXHandleSources(options.sourcesStore)).length === 0) {
    return {};
  }

  return { poller: runXHandleIngestPoller(options) };
}

type WorkerLogger = Pick<Console, "error" | "log" | "warn">;

export type ClaimedJobProposalStep = (result: LiveTradeCycleResult, job: ClaimedRuntimeJob) => Promise<void>;

export type RunClaimedJobOptions = {
  runLiveTradeCycle?: (options: RunLiveTradeCycleOptions) => Promise<LiveTradeCycleResult>;
  proposalStep?: ClaimedJobProposalStep;
  logger?: WorkerLogger;
};

export type OptionalStrategyProposalModelOptions = {
  credentialFile?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<Console, "warn">;
};

export type StrategyProposalAgentLike = {
  propose(input: StrategyProposalAgentInput): Promise<StrategyProposalAgentOutput>;
};

export type StrategyProposalEmissionPolicyInput = {
  result: LiveTradeCycleResult;
  pendingProposals: StrategyProposalRecord[];
  cycleNumberForStrategy: number;
};

export type StrategyProposalEmissionPolicy = (input: StrategyProposalEmissionPolicyInput) => boolean;

export type StrategyProposalStepOptions = {
  store: StrategyProposalsStore;
  createModel: () => Promise<ReasoningModel | null>;
  createAgent?: (model: ReasoningModel) => StrategyProposalAgentLike;
  emissionPolicy?: StrategyProposalEmissionPolicy;
  timeoutMs?: number;
  logger?: WorkerLogger;
};

async function runClaimableCycle(pool: Pool, rearmDelayMs: number, options: RunClaimedJobOptions = {}): Promise<boolean> {
  const lock = await pool.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [WORKER_LOCK_ID]);

  if (!lock.rows[0]?.locked) {
    return false;
  }

  try {
    const job = await claimEnabledLiveCycleJob(pool);

    if (!job) {
      return false;
    }

    await runClaimedJob(pool, job, rearmDelayMs, options);
    return true;
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID]);
  }
}

export async function runClaimedJob(pool: Pool, job: ClaimedRuntimeJob, rearmDelayMs: number, options: RunClaimedJobOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  logger.log(`claimed job ${job.id} (${job.kind})`);
  let result: LiveTradeCycleResult;

  try {
    result = await (options.runLiveTradeCycle ?? runLiveTradeCycle)({ pool, cycleId: `job-${job.id.replaceAll("-", "")}` });
    const orderId = result.execution.order?.id ?? "no broker order";
    await recordLiveCycleSuccess(pool, job.id, result.decisionLog.id, `Live cycle completed with ${result.execution.decision}; order ${orderId}.`, {
      rearmDelayMs
    });
  } catch (error: unknown) {
    const summary = error instanceof Error ? error.message : "unknown live cycle failure";
    await recordLiveCycleFailure(pool, job.id, summary, { rearmDelayMs });
    logger.error(`live cycle job ${job.id} failed: ${summary}`);
    return;
  }

  try {
    await options.proposalStep?.(result, job);
  } catch (error: unknown) {
    logger.warn(`strategy proposal skipped for job ${job.id}: ${error instanceof Error ? error.message : "unknown proposal error"}`);
  }
}

export async function createOptionalStrategyProposalModel(
  options: OptionalStrategyProposalModelOptions = {}
): Promise<ReasoningModel | null> {
  const logger = options.logger ?? console;

  try {
    const credentialVault = new OpenAiOAuthFileCredentialVault(options.credentialFile);
    await credentialVault.getLlmCredential(OPENAI_OAUTH_PROVIDER_ID);
    return createReasoningModel(credentialVault, {
      providerId: OPENAI_OAUTH_PROVIDER_ID,
      fetchFn: createTimeoutFetch(options.fetchFn ?? fetch, options.timeoutMs ?? STRATEGY_PROPOSAL_TIMEOUT_MS)
    });
  } catch (error: unknown) {
    logger.warn(
      "Strategy proposal model unavailable; continuing without proactive proposals.",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

export function createStrategyProposalStep(options: StrategyProposalStepOptions): ClaimedJobProposalStep {
  const logger = options.logger ?? console;
  const createAgent = options.createAgent ?? ((model) => new StrategyProposalAgent(model));
  const emissionPolicy = options.emissionPolicy ?? createEveryNthCycleProposalPolicy(STRATEGY_PROPOSAL_EVERY_N_CYCLES);
  const timeoutMs = options.timeoutMs ?? STRATEGY_PROPOSAL_TIMEOUT_MS;
  const cycleCountsByStrategy = new Map<string, number>();

  return async (result, job) => {
    try {
      const strategyId = result.strategy.id;
      const cycleNumberForStrategy = (cycleCountsByStrategy.get(strategyId) ?? 0) + 1;
      cycleCountsByStrategy.set(strategyId, cycleNumberForStrategy);
      const pendingProposals = await options.store.listPending(25);

      if (!emissionPolicy({ result, pendingProposals, cycleNumberForStrategy })) {
        return;
      }

      const model = await options.createModel();

      if (!model) {
        return;
      }

      const proposal = await withTimeout(
        createAgent(model).propose({
          strategy: result.strategy,
          playbook: result.playbook,
          portfolio: result.portfolio,
          qualitativeBrief: result.qualitativeBrief ?? emptyQualitativeEvidence()
        }),
        timeoutMs,
        `strategy proposal generation timed out after ${timeoutMs}ms`
      );

      await options.store.recordProposal({
        strategyId,
        suggestedCandidate: proposal.suggestedCandidate,
        quantRationale: proposal.quantRationale,
        qualitativeEvidence: proposal.qualitativeEvidence
      });
      logger.log(`recorded strategy proposal for job ${job.id} and strategy ${strategyId}`);
    } catch (error: unknown) {
      logger.warn(`strategy proposal skipped for job ${job.id}: ${error instanceof Error ? error.message : "unknown proposal error"}`);
    }
  };
}

export function createEveryNthCycleProposalPolicy(everyNCycles = STRATEGY_PROPOSAL_EVERY_N_CYCLES): StrategyProposalEmissionPolicy {
  if (!Number.isInteger(everyNCycles) || everyNCycles <= 0) {
    throw new Error("everyNCycles must be a positive integer");
  }

  return ({ result, pendingProposals, cycleNumberForStrategy }) => {
    if (pendingProposals.some((proposal) => proposal.strategyId === result.strategy.id)) {
      return false;
    }

    return cycleNumberForStrategy % everyNCycles === 0;
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }

  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      globalThis.clearTimeout(timeout);
    }
  }
}

function createTimeoutFetch(fetchFn: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

    if (upstreamSignal?.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
    }

    try {
      timeout = globalThis.setTimeout(() => controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`)), timeoutMs);
      return await fetchFn(input, { ...init, signal: controller.signal });
    } finally {
      if (timeout) {
        globalThis.clearTimeout(timeout);
      }
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  };
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href;
}

if (isMainModule()) {
  runWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
