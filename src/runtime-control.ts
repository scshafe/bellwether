import { readFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

export type AgentRuntimeState = "running" | "stopped";
export type AgentRuntimeLastCycleStatus = "succeeded" | "failed" | "cancelled";

export type AgentRuntimeStatus = {
  state: AgentRuntimeState;
  activeJobId: string | null;
  lastCycle: {
    jobId: string | null;
    status: AgentRuntimeLastCycleStatus;
    summary: string;
    decisionLogId: string | null;
    completedAt: string | null;
  } | null;
  updatedAt: string;
};

export type ClaimedRuntimeJob = {
  id: string;
  kind: "live_trade_cycle";
};

export interface AgentRuntimeControl {
  getStatus(): Promise<AgentRuntimeStatus>;
  start(): Promise<AgentRuntimeStatus>;
  stop(): Promise<AgentRuntimeStatus>;
}

type AgentRuntimeStatusRow = {
  enabled: boolean;
  active_job_id: string | null;
  last_cycle_job_id: string | null;
  last_cycle_status: AgentRuntimeLastCycleStatus | null;
  last_cycle_summary: string | null;
  last_cycle_decision_log_id: string | null;
  last_cycle_completed_at: Date | string | null;
  updated_at: Date | string;
};

export class PostgresAgentRuntimeControl implements AgentRuntimeControl {
  constructor(private readonly pool: Pool) {}

  async getStatus(): Promise<AgentRuntimeStatus> {
    const result = await this.pool.query<AgentRuntimeStatusRow>(statusSelectSql);
    return rowToRuntimeStatus(requiredStatusRow(result.rows[0]));
  }

  async start(): Promise<AgentRuntimeStatus> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockRuntimeStatus(client);

      if (current.enabled && current.active_job_id) {
        return rowToRuntimeStatus(current);
      }

      const job = await client.query<{ id: string }>(
        `
          INSERT INTO agent_jobs (kind, payload, status, run_after)
          VALUES ('live_trade_cycle', '{}'::jsonb, 'queued', now())
          RETURNING id
        `
      );
      const updated = await client.query<AgentRuntimeStatusRow>(
        `
          UPDATE agent_runtime_status
          SET enabled = true,
              active_job_id = $1,
              updated_at = now()
          WHERE id = true
          RETURNING ${statusColumns}
        `,
        [job.rows[0]?.id]
      );

      return rowToRuntimeStatus(requiredStatusRow(updated.rows[0]));
    });
  }

  async stop(): Promise<AgentRuntimeStatus> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockRuntimeStatus(client);
      let cancelledQueuedJob = false;

      if (current.active_job_id) {
        const cancelled = await client.query(
          `
            UPDATE agent_jobs
            SET status = 'failed',
                payload = payload || $2::jsonb,
                updated_at = now()
            WHERE id = $1 AND status = 'queued'
          `,
          [current.active_job_id, JSON.stringify({ cancelledBy: "operator_stop" })]
        );
        cancelledQueuedJob = Number(cancelled.rowCount ?? 0) > 0;
      }

      const updated = await client.query<AgentRuntimeStatusRow>(
        `
          UPDATE agent_runtime_status
          SET enabled = false,
              active_job_id = null,
              last_cycle_job_id = CASE WHEN $2::boolean THEN $1 ELSE last_cycle_job_id END,
              last_cycle_status = CASE WHEN $2::boolean THEN 'cancelled' ELSE last_cycle_status END,
              last_cycle_summary = CASE WHEN $2::boolean THEN 'Stopped before the worker claimed the queued live cycle.' ELSE last_cycle_summary END,
              last_cycle_decision_log_id = CASE WHEN $2::boolean THEN null ELSE last_cycle_decision_log_id END,
              last_cycle_completed_at = CASE WHEN $2::boolean THEN now() ELSE last_cycle_completed_at END,
              updated_at = now()
          WHERE id = true
          RETURNING ${statusColumns}
        `,
        [current.active_job_id, cancelledQueuedJob]
      );

      return rowToRuntimeStatus(requiredStatusRow(updated.rows[0]));
    });
  }
}

export async function ensureAgentRuntimeControlSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/004_agent_runtime_status.sql", import.meta.url), "utf8"));
}

export async function claimEnabledLiveCycleJob(pool: Pool): Promise<ClaimedRuntimeJob | null> {
  return withTransaction(pool, async (client) => {
    const status = await lockRuntimeStatus(client);

    if (!status.enabled || !status.active_job_id) {
      return null;
    }

    const result = await client.query<ClaimedRuntimeJob>(
      `
        UPDATE agent_jobs
        SET status = 'claimed', claimed_at = now(), updated_at = now()
        WHERE id = $1
          AND kind = 'live_trade_cycle'
          AND status = 'queued'
          AND run_after <= now()
        RETURNING id, kind
      `,
      [status.active_job_id]
    );

    return result.rows[0] ?? null;
  });
}

export async function recordLiveCycleSuccess(
  pool: Pool,
  jobId: string,
  decisionLogId: string,
  summary: string,
  options: { rearmDelayMs: number } = { rearmDelayMs: 0 }
): Promise<void> {
  await recordLiveCycleCompletion(pool, {
    jobId,
    jobStatus: "done",
    lastCycleStatus: "succeeded",
    summary,
    decisionLogId,
    rearmDelayMs: options.rearmDelayMs
  });
}

export async function recordLiveCycleFailure(
  pool: Pool,
  jobId: string,
  summary: string,
  options: { rearmDelayMs: number } = { rearmDelayMs: 0 }
): Promise<void> {
  await recordLiveCycleCompletion(pool, {
    jobId,
    jobStatus: "failed",
    lastCycleStatus: "failed",
    summary,
    decisionLogId: null,
    rearmDelayMs: options.rearmDelayMs
  });
}

type LiveCycleCompletion = {
  jobId: string;
  jobStatus: "done" | "failed";
  lastCycleStatus: "succeeded" | "failed";
  summary: string;
  decisionLogId: string | null;
  rearmDelayMs: number;
};

async function recordLiveCycleCompletion(pool: Pool, completion: LiveCycleCompletion): Promise<void> {
  if (!Number.isFinite(completion.rearmDelayMs) || completion.rearmDelayMs < 0) {
    throw new Error("rearmDelayMs must be a non-negative number");
  }

  await withTransaction(pool, async (client) => {
    await client.query("UPDATE agent_jobs SET status = $2, updated_at = now() WHERE id = $1", [completion.jobId, completion.jobStatus]);
    const status = await lockRuntimeStatus(client);
    let nextJobId: string | null = null;

    if (status.enabled && status.active_job_id === completion.jobId) {
      const nextJob = await client.query<{ id: string }>(
        `
          INSERT INTO agent_jobs (kind, payload, status, run_after)
          VALUES ('live_trade_cycle', '{}'::jsonb, 'queued', now() + ($1::double precision * interval '1 millisecond'))
          RETURNING id
        `,
        [completion.rearmDelayMs]
      );
      nextJobId = nextJob.rows[0]?.id ?? null;
    }

    await client.query(
      `
        UPDATE agent_runtime_status
        SET active_job_id = CASE WHEN enabled = true AND active_job_id = $1::uuid THEN $5::uuid ELSE active_job_id END,
            last_cycle_job_id = $1,
            last_cycle_status = $2,
            last_cycle_summary = $3,
            last_cycle_decision_log_id = $4,
            last_cycle_completed_at = now(),
            updated_at = now()
        WHERE id = true
      `,
      [completion.jobId, completion.lastCycleStatus, completion.summary, completion.decisionLogId, nextJobId]
    );
  });
}

const statusColumns = `
  enabled,
  active_job_id,
  last_cycle_job_id,
  last_cycle_status,
  last_cycle_summary,
  last_cycle_decision_log_id,
  last_cycle_completed_at,
  updated_at
`;

const statusSelectSql = `SELECT ${statusColumns} FROM agent_runtime_status WHERE id = true`;

async function lockRuntimeStatus(client: PoolClient): Promise<AgentRuntimeStatusRow> {
  const result = await client.query<AgentRuntimeStatusRow>(`${statusSelectSql} FOR UPDATE`);
  return requiredStatusRow(result.rows[0]);
}

async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requiredStatusRow(row: AgentRuntimeStatusRow | undefined): AgentRuntimeStatusRow {
  if (!row) {
    throw new Error("agent runtime status row is missing; run ensureAgentRuntimeControlSchema first");
  }

  return row;
}

function rowToRuntimeStatus(row: AgentRuntimeStatusRow): AgentRuntimeStatus {
  return {
    state: row.enabled ? "running" : "stopped",
    activeJobId: row.enabled ? row.active_job_id : null,
    lastCycle: row.last_cycle_status
      ? {
          jobId: row.last_cycle_job_id,
          status: row.last_cycle_status,
          summary: row.last_cycle_summary ?? "",
          decisionLogId: row.last_cycle_decision_log_id,
          completedAt: dateToIso(row.last_cycle_completed_at)
        }
      : null,
    updatedAt: dateToIso(row.updated_at) ?? new Date(0).toISOString()
  };
}

function dateToIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}
