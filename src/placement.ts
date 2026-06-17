import { requireConfigValue, requireEnv } from "./config.js";

export type ServerEndpointsConfig = {
  host: string;
  port: number;
  publicBaseUrl: string;
  healthcheckUrl: string;
};

export type DatabaseUrlConfig = {
  databaseUrl: string;
};

export type WorkerPlacement = {
  runtimeName: string;
  serviceName: string;
  coordination: "postgres";
  databaseServiceName: string;
  pollIntervalMs: number;
  qualitativeIngestPollIntervalMs: number;
  pacedCadence: PacedCadenceConfig;
  readyFile: string;
};

export type PacedCadenceConfig = {
  cycleIntervalMs: number;
  marketHoursAware: boolean;
};

export const DEFAULT_PACED_CYCLE_INTERVAL_MS = 300_000;
export const DEFAULT_PACED_MARKET_HOURS_AWARE = true;

export interface AgentRuntime {
  describeWorkerPlacement(): WorkerPlacement;
}

export type BlobWrite = {
  key: string;
  body: Uint8Array;
  contentType?: string;
};

export type BlobObject = BlobWrite;

export interface BlobStore {
  putBlob(blob: BlobWrite): Promise<void>;
  getBlob(key: string): Promise<BlobObject | null>;
  deleteBlob(key: string): Promise<void>;
}

export type OrchestrationService = {
  name: string;
  healthcheck: string;
  dependsOn: readonly string[];
};

export type OrchestrationPlacement = {
  kind: "docker-compose";
  projectName: string;
  services: readonly OrchestrationService[];
  volumes: readonly string[];
};

export interface OrchestrationControlPlane {
  describePlacement(): Promise<OrchestrationPlacement>;
}

export class ConfiguredAgentRuntime implements AgentRuntime {
  constructor(private readonly workerPlacement: WorkerPlacement) {}

  describeWorkerPlacement(): WorkerPlacement {
    return this.workerPlacement;
  }
}

export class InMemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, BlobObject>();

  async putBlob(blob: BlobWrite): Promise<void> {
    this.#blobs.set(blob.key, copyBlob(blob));
  }

  async getBlob(key: string): Promise<BlobObject | null> {
    const blob = this.#blobs.get(key);
    return blob ? copyBlob(blob) : null;
  }

  async deleteBlob(key: string): Promise<void> {
    this.#blobs.delete(key);
  }
}

export class StaticOrchestrationControlPlane implements OrchestrationControlPlane {
  constructor(private readonly placement: OrchestrationPlacement) {}

  async describePlacement(): Promise<OrchestrationPlacement> {
    return this.placement;
  }
}

export function readServerEndpointsConfig(config: NodeJS.ProcessEnv = process.env): ServerEndpointsConfig {
  const host = config.HOST ?? "0.0.0.0";
  const port = parsePort(config.PORT ?? "3000", "PORT");
  const healthcheckUrl = config.HEALTHCHECK_URL ?? `http://127.0.0.1:${port}/healthz`;

  return {
    host,
    port,
    publicBaseUrl: config.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
    healthcheckUrl
  };
}

export function readDatabaseUrlConfig(config: NodeJS.ProcessEnv = process.env): DatabaseUrlConfig {
  return {
    databaseUrl: config === process.env ? requireEnv("DATABASE_URL") : requireConfigValue(config, "DATABASE_URL")
  };
}

export function readWorkerPlacement(config: NodeJS.ProcessEnv = process.env): WorkerPlacement {
  return {
    runtimeName: config.AGENT_RUNTIME_NAME ?? "docker-compose",
    serviceName: config.WORKER_SERVICE_NAME ?? "worker",
    coordination: "postgres",
    databaseServiceName: config.DATABASE_SERVICE_NAME ?? "db",
    pollIntervalMs: parsePositiveInteger(config.WORKER_POLL_INTERVAL_MS ?? "5000", "WORKER_POLL_INTERVAL_MS"),
    qualitativeIngestPollIntervalMs: parsePositiveInteger(
      config.QUALITATIVE_INGEST_POLL_INTERVAL_MS ?? "300000",
      "QUALITATIVE_INGEST_POLL_INTERVAL_MS"
    ),
    pacedCadence: readPacedCadenceConfig(config),
    readyFile: config.WORKER_READY_FILE ?? "/tmp/worker-ready"
  };
}

export function readPacedCadenceConfig(config: NodeJS.ProcessEnv = process.env): PacedCadenceConfig {
  return {
    cycleIntervalMs: parsePositiveInteger(
      config.PACED_CYCLE_INTERVAL_MS ?? DEFAULT_PACED_CYCLE_INTERVAL_MS.toString(),
      "PACED_CYCLE_INTERVAL_MS"
    ),
    marketHoursAware: parseBooleanConfig(
      config.PACED_MARKET_HOURS_AWARE,
      "PACED_MARKET_HOURS_AWARE",
      DEFAULT_PACED_MARKET_HOURS_AWARE
    )
  };
}

export function createAgentRuntime(config: NodeJS.ProcessEnv = process.env): AgentRuntime {
  return new ConfiguredAgentRuntime(readWorkerPlacement(config));
}

export function createComposeControlPlane(config: NodeJS.ProcessEnv = process.env): OrchestrationControlPlane {
  const worker = readWorkerPlacement(config);

  return new StaticOrchestrationControlPlane({
    kind: "docker-compose",
    projectName: config.COMPOSE_PROJECT_NAME ?? "agent-trading-platform",
    services: [
      { name: worker.databaseServiceName, healthcheck: "pg_isready", dependsOn: [] },
      { name: "server", healthcheck: "GET /healthz", dependsOn: [worker.databaseServiceName] },
      { name: worker.serviceName, healthcheck: `ready-file:${worker.readyFile}`, dependsOn: [worker.databaseServiceName] }
    ],
    volumes: [config.POSTGRES_VOLUME_NAME ?? "postgres-data"]
  });
}

function parsePort(value: string, name: string): number {
  const port = parsePositiveInteger(value, name);

  if (port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }

  return port;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseBooleanConfig(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value`);
}

function copyBlob(blob: BlobWrite): BlobObject {
  return {
    key: blob.key,
    body: new Uint8Array(blob.body),
    contentType: blob.contentType
  };
}
