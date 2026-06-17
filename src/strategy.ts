import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  buildQuantPlaybook,
  type PortfolioSnapshot,
  type PriceVolumeBar,
  type QuantPlaybook,
  type QuantPlaybookParameters,
  type UniverseAsset
} from "./quant-playbook.js";

export const STRATEGY_STATUSES = ["draft", "approved", "active"] as const;

export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export type StrategyRecord = {
  id: string;
  name: string;
  description?: string;
  status: StrategyStatus;
  parameters: QuantPlaybookParameters;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  activatedAt?: string;
};

export type CreateStrategyInput = {
  id?: string;
  name: string;
  description?: string;
  parameters: QuantPlaybookParameters;
};

export type StrategyPlaybookInput = {
  asOf: string;
  universe: UniverseAsset[];
  bars: PriceVolumeBar[];
  portfolio: PortfolioSnapshot;
};

export interface StrategyStore {
  createStrategy(input: CreateStrategyInput): Promise<StrategyRecord>;
  getStrategy(id: string): Promise<StrategyRecord | null>;
  approveStrategy(id: string): Promise<StrategyRecord>;
  activateStrategy(id: string): Promise<StrategyRecord>;
}

export interface StrategyTradingGate {
  getStrategyStatus(strategyId: string): Promise<StrategyStatus | null>;
}

export class StrategyLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyLifecycleError";
  }
}

export class StrategyNotFoundError extends Error {
  constructor(strategyId: string) {
    super(`strategy ${strategyId} was not found`);
    this.name = "StrategyNotFoundError";
  }
}

export class InMemoryStrategyStore implements StrategyStore, StrategyTradingGate {
  private readonly strategies = new Map<string, StrategyRecord>();

  constructor(initialStrategies: StrategyRecord[] = []) {
    for (const strategy of initialStrategies) {
      this.strategies.set(strategy.id, cloneStrategy(strategy));
    }
  }

  async createStrategy(input: CreateStrategyInput): Promise<StrategyRecord> {
    const name = normalizeStrategyName(input.name);
    const id = input.id ?? randomUUID();

    if (this.strategies.has(id)) {
      throw new Error(`strategy ${id} already exists`);
    }

    validateStrategyParameters(input.parameters);

    const now = new Date().toISOString();
    const strategy: StrategyRecord = {
      id,
      name,
      status: "draft",
      parameters: { ...input.parameters },
      createdAt: now,
      updatedAt: now
    };

    if (input.description !== undefined) {
      strategy.description = input.description;
    }

    this.strategies.set(id, cloneStrategy(strategy));
    return cloneStrategy(strategy);
  }

  async getStrategy(id: string): Promise<StrategyRecord | null> {
    const strategy = this.strategies.get(id.trim());
    return strategy ? cloneStrategy(strategy) : null;
  }

  async getStrategyStatus(strategyId: string): Promise<StrategyStatus | null> {
    return (await this.getStrategy(strategyId))?.status ?? null;
  }

  async approveStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "approved");
  }

  async activateStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "active");
  }

  private transition(id: string, nextStatus: StrategyStatus): StrategyRecord {
    const strategy = this.strategies.get(id.trim());

    if (!strategy) {
      throw new StrategyNotFoundError(id);
    }

    assertValidTransition(strategy.status, nextStatus);

    const now = new Date().toISOString();
    const updated: StrategyRecord = {
      ...strategy,
      status: nextStatus,
      updatedAt: now
    };

    if (nextStatus === "approved") {
      updated.approvedAt = now;
    }

    if (nextStatus === "active") {
      updated.activatedAt = now;
    }

    this.strategies.set(updated.id, cloneStrategy(updated));
    return cloneStrategy(updated);
  }
}

export class PostgresStrategyStore implements StrategyStore, StrategyTradingGate {
  constructor(private readonly pool: Pool) {}

  async createStrategy(input: CreateStrategyInput): Promise<StrategyRecord> {
    const name = normalizeStrategyName(input.name);
    validateStrategyParameters(input.parameters);

    const result = await this.pool.query<StrategyRow>(
      `
        INSERT INTO strategies (id, name, description, parameters)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb)
        RETURNING id, name, description, status, parameters, created_at, updated_at, approved_at, activated_at
      `,
      [input.id ?? null, name, input.description ?? null, JSON.stringify(input.parameters)]
    );

    return rowToStrategy(result.rows[0]);
  }

  async getStrategy(id: string): Promise<StrategyRecord | null> {
    const result = await this.pool.query<StrategyRow>(
      `
        SELECT id, name, description, status, parameters, created_at, updated_at, approved_at, activated_at
        FROM strategies
        WHERE id = $1
      `,
      [id.trim()]
    );

    return result.rows[0] ? rowToStrategy(result.rows[0]) : null;
  }

  async getStrategyStatus(strategyId: string): Promise<StrategyStatus | null> {
    const result = await this.pool.query<{ status: StrategyStatus }>("SELECT status FROM strategies WHERE id = $1", [strategyId.trim()]);
    return result.rows[0]?.status ?? null;
  }

  async approveStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "approved", "draft");
  }

  async activateStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "active", "approved");
  }

  private async transition(id: string, nextStatus: StrategyStatus, requiredStatus: StrategyStatus): Promise<StrategyRecord> {
    const result = await this.pool.query<StrategyRow>(
      `
        UPDATE strategies
        SET status = $2,
            approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
            activated_at = CASE WHEN $2 = 'active' THEN now() ELSE activated_at END,
            updated_at = now()
        WHERE id = $1 AND status = $3
        RETURNING id, name, description, status, parameters, created_at, updated_at, approved_at, activated_at
      `,
      [id.trim(), nextStatus, requiredStatus]
    );

    if (result.rows[0]) {
      return rowToStrategy(result.rows[0]);
    }

    const current = await this.getStrategy(id);

    if (!current) {
      throw new StrategyNotFoundError(id);
    }

    throw new StrategyLifecycleError(`cannot transition strategy ${id} from ${current.status} to ${nextStatus}`);
  }
}

export function buildStrategyQuantPlaybook(strategy: StrategyRecord, input: StrategyPlaybookInput): QuantPlaybook {
  return buildQuantPlaybook({
    ...input,
    parameters: strategy.parameters
  });
}

export async function getStrategyTradingGateViolation(
  gate: StrategyTradingGate,
  strategyId: string
): Promise<string | null> {
  const normalizedStrategyId = strategyId.trim();

  if (!normalizedStrategyId) {
    return "order strategyId is required for the strategy approval gate";
  }

  const status = await gate.getStrategyStatus(normalizedStrategyId);

  if (!status) {
    return `strategy ${normalizedStrategyId} was not found`;
  }

  if (status !== "active") {
    return `strategy ${normalizedStrategyId} is ${status}; only active strategies can trade`;
  }

  return null;
}

function assertValidTransition(currentStatus: StrategyStatus, nextStatus: StrategyStatus): void {
  if (nextStatus === "approved" && currentStatus === "draft") {
    return;
  }

  if (nextStatus === "active" && currentStatus === "approved") {
    return;
  }

  throw new StrategyLifecycleError(`cannot transition strategy from ${currentStatus} to ${nextStatus}`);
}

function normalizeStrategyName(name: string): string {
  const trimmedName = name.trim();

  if (!trimmedName) {
    throw new Error("strategy name is required");
  }

  return trimmedName;
}

function validateStrategyParameters(parameters: QuantPlaybookParameters): void {
  for (const [name, value] of Object.entries(parameters)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`strategy parameter ${name} must be a finite number`);
    }
  }

  if (parameters.signalLookbackBars < 1 || !Number.isInteger(parameters.signalLookbackBars)) {
    throw new Error("strategy parameter signalLookbackBars must be a positive integer");
  }

  if (parameters.maxOpenPositions < 1 || !Number.isInteger(parameters.maxOpenPositions)) {
    throw new Error("strategy parameter maxOpenPositions must be a positive integer");
  }
}

function cloneStrategy(strategy: StrategyRecord): StrategyRecord {
  return {
    ...strategy,
    parameters: { ...strategy.parameters }
  };
}

type StrategyRow = {
  id: string;
  name: string;
  description: string | null;
  status: StrategyStatus;
  parameters: QuantPlaybookParameters;
  created_at: Date | string;
  updated_at: Date | string;
  approved_at: Date | string | null;
  activated_at: Date | string | null;
};

function rowToStrategy(row: StrategyRow | undefined): StrategyRecord {
  if (!row) {
    throw new Error("strategy query returned no rows");
  }

  validateStrategyStatus(row.status);
  validateStrategyParameters(row.parameters);

  const strategy: StrategyRecord = {
    id: row.id,
    name: row.name,
    status: row.status,
    parameters: { ...row.parameters },
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };

  if (row.description) {
    strategy.description = row.description;
  }

  if (row.approved_at) {
    strategy.approvedAt = toIsoString(row.approved_at);
  }

  if (row.activated_at) {
    strategy.activatedAt = toIsoString(row.activated_at);
  }

  return strategy;
}

function validateStrategyStatus(status: string): asserts status is StrategyStatus {
  if (!STRATEGY_STATUSES.includes(status as StrategyStatus)) {
    throw new Error(`unknown strategy status ${status}`);
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
