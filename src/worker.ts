import { rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { Pool } from "pg";

import { createPool } from "./db.js";
import { createAgentRuntime } from "./placement.js";

const WORKER_LOCK_ID = 420_001;
const workerPlacement = createAgentRuntime().describeWorkerPlacement();

type ClaimedJob = {
  id: string;
  kind: string;
};

let shouldRun = true;

process.on("SIGINT", () => {
  shouldRun = false;
});

process.on("SIGTERM", () => {
  shouldRun = false;
});

async function claimJob(pool: Pool): Promise<ClaimedJob | null> {
  const result = await pool.query<ClaimedJob>(`
    WITH candidate AS (
      SELECT id
      FROM agent_jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY run_after, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE agent_jobs
    SET status = 'claimed', claimed_at = now(), updated_at = now()
    FROM candidate
    WHERE agent_jobs.id = candidate.id
    RETURNING agent_jobs.id, agent_jobs.kind
  `);

  return result.rows[0] ?? null;
}

async function runWorker(): Promise<void> {
  const pool = createPool();

  try {
    await pool.query("SELECT 1");
    await writeFile(workerPlacement.readyFile, "ready\n");

    while (shouldRun) {
      const lock = await pool.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [WORKER_LOCK_ID]);

      if (lock.rows[0]?.locked) {
        try {
          const job = await claimJob(pool);

          if (job) {
            console.log(`claimed job ${job.id} (${job.kind})`);
          }
        } finally {
          await pool.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID]);
        }
      }

      await delay(workerPlacement.pollIntervalMs);
    }
  } finally {
    await rm(workerPlacement.readyFile, { force: true });
    await pool.end();
  }
}

runWorker().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
