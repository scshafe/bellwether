import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAgentRuntime,
  createComposeControlPlane,
  InMemoryBlobStore,
  readDatabaseUrlConfig,
  readServerEndpointsConfig,
  readWorkerPlacement
} from "./placement.js";

describe("placement config", () => {
  it("reads server endpoints from config with compose defaults", () => {
    assert.deepEqual(readServerEndpointsConfig({}), {
      host: "0.0.0.0",
      port: 3000,
      publicBaseUrl: "http://127.0.0.1:3000",
      healthcheckUrl: "http://127.0.0.1:3000/healthz"
    });

    assert.deepEqual(
      readServerEndpointsConfig({
        HOST: "127.0.0.1",
        PORT: "8080",
        PUBLIC_BASE_URL: "https://example.test",
        HEALTHCHECK_URL: "https://example.test/healthz"
      }),
      {
        host: "127.0.0.1",
        port: 8080,
        publicBaseUrl: "https://example.test",
        healthcheckUrl: "https://example.test/healthz"
      }
    );
  });

  it("requires the database URL through config", () => {
    assert.deepEqual(readDatabaseUrlConfig({ DATABASE_URL: "postgres://atp:secret@db:5432/agent_trading_platform" }), {
      databaseUrl: "postgres://atp:secret@db:5432/agent_trading_platform"
    });

    assert.throws(() => readDatabaseUrlConfig({}), /DATABASE_URL is required/);
  });

  it("validates numeric placement config", () => {
    assert.throws(() => readServerEndpointsConfig({ PORT: "70000" }), /PORT must be a valid TCP port/);
    assert.throws(() => readWorkerPlacement({ WORKER_POLL_INTERVAL_MS: "0" }), /WORKER_POLL_INTERVAL_MS must be a positive integer/);
    assert.throws(
      () => readWorkerPlacement({ QUALITATIVE_INGEST_POLL_INTERVAL_MS: "0" }),
      /QUALITATIVE_INGEST_POLL_INTERVAL_MS must be a positive integer/
    );
  });
});

describe("AgentRuntime placement", () => {
  it("describes the docker-compose worker placement without controlling it", () => {
    const runtime = createAgentRuntime({
      AGENT_RUNTIME_NAME: "docker-compose",
      DATABASE_SERVICE_NAME: "db",
      WORKER_SERVICE_NAME: "worker",
      WORKER_READY_FILE: "/tmp/worker-ready",
      WORKER_POLL_INTERVAL_MS: "2500",
      QUALITATIVE_INGEST_POLL_INTERVAL_MS: "60000"
    });

    assert.deepEqual(runtime.describeWorkerPlacement(), {
      runtimeName: "docker-compose",
      serviceName: "worker",
      coordination: "postgres",
      databaseServiceName: "db",
      pollIntervalMs: 2500,
      qualitativeIngestPollIntervalMs: 60000,
      readyFile: "/tmp/worker-ready"
    });
  });
});

describe("OrchestrationControlPlane facade", () => {
  it("describes the P0b compose decomposition", async () => {
    const controlPlane = createComposeControlPlane({
      COMPOSE_PROJECT_NAME: "agent-trading-platform",
      POSTGRES_VOLUME_NAME: "postgres-data"
    });

    assert.deepEqual(await controlPlane.describePlacement(), {
      kind: "docker-compose",
      projectName: "agent-trading-platform",
      services: [
        { name: "db", healthcheck: "pg_isready", dependsOn: [] },
        { name: "server", healthcheck: "GET /healthz", dependsOn: ["db"] },
        { name: "worker", healthcheck: "ready-file:/tmp/worker-ready", dependsOn: ["db"] }
      ],
      volumes: ["postgres-data"]
    });
  });
});

describe("InMemoryBlobStore", () => {
  it("stores defensive copies of blobs", async () => {
    const store = new InMemoryBlobStore();
    const body = new Uint8Array([1, 2, 3]);

    await store.putBlob({ key: "reports/p0d.txt", body, contentType: "text/plain" });
    body[0] = 9;

    const stored = await store.getBlob("reports/p0d.txt");
    assert.deepEqual(stored, { key: "reports/p0d.txt", body: new Uint8Array([1, 2, 3]), contentType: "text/plain" });

    if (stored) {
      stored.body[1] = 8;
    }

    assert.deepEqual(await store.getBlob("reports/p0d.txt"), {
      key: "reports/p0d.txt",
      body: new Uint8Array([1, 2, 3]),
      contentType: "text/plain"
    });
  });

  it("deletes blobs by key", async () => {
    const store = new InMemoryBlobStore();

    await store.putBlob({ key: "tmp/blob", body: new Uint8Array([1]) });
    await store.deleteBlob("tmp/blob");

    assert.equal(await store.getBlob("tmp/blob"), null);
  });
});
