import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool, PoolClient } from "pg";

import { PostgresAgentRuntimeControl, recordLiveCycleFailure, recordLiveCycleSuccess } from "./runtime-control.js";

describe("postgres runtime control", () => {
  it("reports running whenever the operator has enabled the runtime", async () => {
    const pool = {
      query: async () => ({
        rows: [runtimeRow({ enabled: true, active_job_id: null })]
      })
    } as unknown as Pool;

    const status = await new PostgresAgentRuntimeControl(pool).getStatus();

    assert.equal(status.state, "running");
    assert.equal(status.activeJobId, null);
  });

  it("re-arms a successful cycle only when the completed job is still active and enabled", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const client = new RecordingClient(runtimeRow({ enabled: true, active_job_id: jobId }));
    const pool = poolFromClient(client);

    await recordLiveCycleSuccess(pool, jobId, "22222222-2222-4222-8222-222222222222", "cycle ok", { rearmDelayMs: 1234 });

    const insert = client.queries.find((query) => query.text.includes("INSERT INTO agent_jobs"));
    const runtimeUpdate = client.queries.find((query) => query.text.includes("UPDATE agent_runtime_status"));
    assert.deepEqual(insert?.values, [1234]);
    assert.deepEqual(runtimeUpdate?.values, [jobId, "succeeded", "cycle ok", "22222222-2222-4222-8222-222222222222", client.nextJobId]);
    assert.match(runtimeUpdate?.text ?? "", /active_job_id = CASE WHEN enabled = true AND active_job_id = \$1::uuid THEN \$5::uuid ELSE active_job_id END/u);
  });

  it("does not re-arm or clobber a stop that landed before completion", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const client = new RecordingClient(runtimeRow({ enabled: false, active_job_id: null }));
    const pool = poolFromClient(client);

    await recordLiveCycleFailure(pool, jobId, "cycle failed", { rearmDelayMs: 1234 });

    assert.equal(client.queries.some((query) => query.text.includes("INSERT INTO agent_jobs")), false);
    const runtimeUpdate = client.queries.find((query) => query.text.includes("UPDATE agent_runtime_status"));
    assert.deepEqual(runtimeUpdate?.values, [jobId, "failed", "cycle failed", null, null]);
  });

  it("does not let an old in-flight completion overwrite a newer start", async () => {
    const oldJobId = "11111111-1111-4111-8111-111111111111";
    const newJobId = "44444444-4444-4444-8444-444444444444";
    const client = new RecordingClient(runtimeRow({ enabled: true, active_job_id: newJobId }));
    const pool = poolFromClient(client);

    await recordLiveCycleSuccess(pool, oldJobId, "22222222-2222-4222-8222-222222222222", "old cycle ok", { rearmDelayMs: 1234 });

    assert.equal(client.queries.some((query) => query.text.includes("INSERT INTO agent_jobs")), false);
    const runtimeUpdate = client.queries.find((query) => query.text.includes("UPDATE agent_runtime_status"));
    assert.deepEqual(runtimeUpdate?.values, [oldJobId, "succeeded", "old cycle ok", "22222222-2222-4222-8222-222222222222", null]);
  });
});

type QueryRecord = { text: string; values?: unknown[] };

class RecordingClient {
  readonly queries: QueryRecord[] = [];
  readonly nextJobId = "33333333-3333-4333-8333-333333333333";

  constructor(private readonly statusRow: Record<string, unknown>) {}

  async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });

    if (text.includes("FOR UPDATE")) {
      return { rows: [this.statusRow as T] };
    }

    if (text.includes("INSERT INTO agent_jobs")) {
      return { rows: [{ id: this.nextJobId } as T] };
    }

    return { rows: [] };
  }

  release(): void {}
}

function poolFromClient(client: RecordingClient): Pool {
  return {
    connect: async () => client as unknown as PoolClient
  } as unknown as Pool;
}

function runtimeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    enabled: false,
    active_job_id: null,
    last_cycle_job_id: null,
    last_cycle_status: null,
    last_cycle_summary: null,
    last_cycle_decision_log_id: null,
    last_cycle_completed_at: null,
    updated_at: "2026-06-17T14:00:00.000Z",
    ...overrides
  };
}
