import { resolve } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { Pool } from "pg";

import { runAlpacaNewsIngestStream } from "./alpaca-news.js";
import { createAlpacaPaperSecretsStore } from "./broker.js";
import { createPool } from "./db.js";
import { runLiveTradeCycle } from "./live-cycle.js";
import { createAgentRuntime } from "./placement.js";
import {
  ensureAlpacaNewsSource,
  ensureQualitativeItemsSchema,
  ensureSourcesSchema,
  PostgresQualitativeItemsStore,
  PostgresSourcesStore,
  runRssAtomIngestPoller
} from "./qualitative.js";
import {
  claimEnabledLiveCycleJob,
  ensureAgentRuntimeControlSchema,
  recordLiveCycleFailure,
  recordLiveCycleSuccess,
  type ClaimedRuntimeJob
} from "./runtime-control.js";
import { SecretsBackedBrokerCredentialVault } from "./secrets.js";

const WORKER_LOCK_ID = 420_001;
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
  let qualitativePoller: Promise<void> | undefined;
  let alpacaNewsStream: Promise<void> | undefined;

  try {
    await pool.query("SELECT 1");
    await ensureAgentRuntimeControlSchema(pool);
    await ensureSourcesSchema(pool);
    await ensureQualitativeItemsSchema(pool);
    await ensureAlpacaNewsSource(pool);
    qualitativePoller = runRssAtomIngestPoller({
      sourcesStore: new PostgresSourcesStore(pool),
      itemsStore: new PostgresQualitativeItemsStore(pool),
      pollIntervalMs: workerPlacement.qualitativeIngestPollIntervalMs,
      signal: qualitativePollerController.signal,
      logger: console
    });
    try {
      const credentialVault = new SecretsBackedBrokerCredentialVault(await createAlpacaPaperSecretsStore());
      alpacaNewsStream = runAlpacaNewsIngestStream({
        credentialVault,
        itemsStore: new PostgresQualitativeItemsStore(pool),
        signal: alpacaNewsController.signal,
        logger: console
      });
    } catch (error: unknown) {
      console.warn(`alpaca news ingest disabled: ${error instanceof Error ? error.message : "unknown credential error"}`);
    }
    await writeFile(workerPlacement.readyFile, "ready\n");

    while (shouldRun) {
      const lock = await pool.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [WORKER_LOCK_ID]);

      if (lock.rows[0]?.locked) {
        try {
          const job = await claimEnabledLiveCycleJob(pool);

          if (job) {
            await runClaimedJob(pool, job);
          }
        } finally {
          await pool.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID]);
        }
      }

      await delay(workerPlacement.pollIntervalMs);
    }
  } finally {
    qualitativePollerController.abort();
    alpacaNewsController.abort();
    await qualitativePoller?.catch((error: unknown) => {
      console.error(error);
    });
    await alpacaNewsStream?.catch((error: unknown) => {
      console.error(error);
    });
    await rm(workerPlacement.readyFile, { force: true });
    await pool.end();
  }
}

async function runClaimedJob(pool: Pool, job: ClaimedRuntimeJob): Promise<void> {
  console.log(`claimed job ${job.id} (${job.kind})`);

  try {
    const result = await runLiveTradeCycle({ pool, cycleId: `job-${job.id.replaceAll("-", "")}` });
    const orderId = result.execution.order?.id ?? "no broker order";
    await recordLiveCycleSuccess(pool, job.id, result.decisionLog.id, `Live cycle completed with ${result.execution.decision}; order ${orderId}.`);
  } catch (error: unknown) {
    const summary = error instanceof Error ? error.message : "unknown live cycle failure";
    await recordLiveCycleFailure(pool, job.id, summary);
    console.error(`live cycle job ${job.id} failed: ${summary}`);
  }
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
