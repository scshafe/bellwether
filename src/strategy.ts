import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import {
  buildQuantPlaybook,
  type PortfolioSnapshot,
  type PriceVolumeBar,
  type QuantPlaybook,
  type QuantPlaybookParameters,
  type UniverseAsset
} from "./quant-playbook.js";

export const STRATEGY_STATUSES = ["draft", "under_discussion", "approved", "active", "paused", "retired"] as const;

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
  discussionStartedAt?: string;
  pausedAt?: string;
  retiredAt?: string;
  reason?: string;
};

export type CreateStrategyInput = {
  id?: string;
  name: string;
  description?: string;
  parameters: QuantPlaybookParameters;
};

export type UpdateStrategyPatch = {
  name?: string;
  description?: string | null;
  parameters?: QuantPlaybookParameters;
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
  listStrategies(limit?: number): Promise<StrategyRecord[]>;
  updateStrategy(id: string, patch: UpdateStrategyPatch): Promise<StrategyRecord>;
  startDiscussion(id: string): Promise<StrategyRecord>;
  returnToDraft(id: string): Promise<StrategyRecord>;
  approveStrategy(id: string): Promise<StrategyRecord>;
  activateStrategy(id: string): Promise<StrategyRecord>;
  pauseStrategy(id: string, reason?: string): Promise<StrategyRecord>;
  resumeStrategy(id: string): Promise<StrategyRecord>;
  retireStrategy(id: string, reason?: string): Promise<StrategyRecord>;
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

  async listStrategies(limit = 50): Promise<StrategyRecord[]> {
    return [...this.strategies.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, normalizeStrategiesLimit(limit))
      .map((strategy) => cloneStrategy(strategy));
  }

  async updateStrategy(id: string, patch: UpdateStrategyPatch): Promise<StrategyRecord> {
    const strategy = this.strategies.get(id.trim());

    if (!strategy) {
      throw new StrategyNotFoundError(id);
    }

    assertCanUpdateStrategy(strategy);

    const updated: StrategyRecord = {
      ...strategy,
      updatedAt: new Date().toISOString()
    };

    if (patch.name !== undefined) {
      updated.name = normalizeStrategyName(patch.name);
    }

    if (patch.description !== undefined) {
      if (patch.description === null) {
        delete updated.description;
      } else {
        updated.description = patch.description;
      }
    }

    if (patch.parameters !== undefined) {
      validateStrategyParameters(patch.parameters);
      updated.parameters = { ...patch.parameters };
    }

    this.strategies.set(updated.id, cloneStrategy(updated));
    return cloneStrategy(updated);
  }

  async startDiscussion(id: string): Promise<StrategyRecord> {
    return this.transition(id, "under_discussion");
  }

  async returnToDraft(id: string): Promise<StrategyRecord> {
    return this.transition(id, "draft");
  }

  async approveStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "approved");
  }

  async activateStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "active");
  }

  async pauseStrategy(id: string, reason?: string): Promise<StrategyRecord> {
    return this.transition(id, "paused", reason);
  }

  async resumeStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "active");
  }

  async retireStrategy(id: string, reason?: string): Promise<StrategyRecord> {
    return this.transition(id, "retired", reason);
  }

  private transition(id: string, nextStatus: StrategyStatus, reason?: string): StrategyRecord {
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
      updated.approvedAt ??= now;
    }

    if (nextStatus === "active") {
      updated.activatedAt ??= now;
    }

    if (nextStatus === "under_discussion") {
      updated.discussionStartedAt ??= now;
    }

    if (nextStatus === "paused") {
      updated.pausedAt ??= now;
      setStrategyReason(updated, reason);
    }

    if (nextStatus === "retired") {
      updated.retiredAt ??= now;
      setStrategyReason(updated, reason);
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
        RETURNING ${STRATEGY_RETURNING_COLUMNS}
      `,
      [input.id ?? null, name, input.description ?? null, JSON.stringify(input.parameters)]
    );

    return rowToStrategy(result.rows[0]);
  }

  async getStrategy(id: string): Promise<StrategyRecord | null> {
    const result = await this.pool.query<StrategyRow>(
      `
        SELECT ${STRATEGY_RETURNING_COLUMNS}
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

  async listStrategies(limit = 50): Promise<StrategyRecord[]> {
    const result = await this.pool.query<StrategyRow>(
      `
        SELECT ${STRATEGY_RETURNING_COLUMNS}
        FROM strategies
        ORDER BY created_at DESC, id DESC
        LIMIT $1
      `,
      [normalizeStrategiesLimit(limit)]
    );

    return result.rows.map(rowToStrategy);
  }

  async updateStrategy(id: string, patch: UpdateStrategyPatch): Promise<StrategyRecord> {
    const current = await this.getStrategy(id);

    if (!current) {
      throw new StrategyNotFoundError(id);
    }

    assertCanUpdateStrategy(current);

    const name = patch.name !== undefined ? normalizeStrategyName(patch.name) : current.name;
    const description = patch.description !== undefined ? patch.description : current.description ?? null;
    const parameters = patch.parameters !== undefined ? patch.parameters : current.parameters;
    validateStrategyParameters(parameters);

    const result = await this.pool.query<StrategyRow>(
      `
        UPDATE strategies
        SET name = $2,
            description = $3,
            parameters = $4::jsonb,
            updated_at = now()
        WHERE id = $1 AND status = ANY($5::text[])
        RETURNING ${STRATEGY_RETURNING_COLUMNS}
      `,
      [id.trim(), name, description, JSON.stringify(parameters), STRATEGY_MUTABLE_STATUSES]
    );

    if (result.rows[0]) {
      return rowToStrategy(result.rows[0]);
    }

    const latest = await this.getStrategy(id);

    if (!latest) {
      throw new StrategyNotFoundError(id);
    }

    assertCanUpdateStrategy(latest);
    throw new StrategyLifecycleError(`cannot update strategy ${id} while ${latest.status}`);
  }

  async startDiscussion(id: string): Promise<StrategyRecord> {
    return this.transition(id, "under_discussion", ["draft"]);
  }

  async returnToDraft(id: string): Promise<StrategyRecord> {
    return this.transition(id, "draft", ["under_discussion"]);
  }

  async approveStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "approved", ["draft", "under_discussion"]);
  }

  async activateStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "active", ["approved", "paused"]);
  }

  async pauseStrategy(id: string, reason?: string): Promise<StrategyRecord> {
    return this.transition(id, "paused", ["active"], reason);
  }

  async resumeStrategy(id: string): Promise<StrategyRecord> {
    return this.transition(id, "active", ["paused"]);
  }

  async retireStrategy(id: string, reason?: string): Promise<StrategyRecord> {
    return this.transition(id, "retired", ["active", "paused"], reason);
  }

  private async transition(id: string, nextStatus: StrategyStatus, requiredStatuses: StrategyStatus[], reason?: string): Promise<StrategyRecord> {
    const result = await this.pool.query<StrategyRow>(
      `
        UPDATE strategies
        SET status = $2,
            approved_at = CASE WHEN $2 = 'approved' THEN COALESCE(approved_at, now()) ELSE approved_at END,
            activated_at = CASE WHEN $2 = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
            discussion_started_at = CASE WHEN $2 = 'under_discussion' THEN COALESCE(discussion_started_at, now()) ELSE discussion_started_at END,
            paused_at = CASE WHEN $2 = 'paused' THEN COALESCE(paused_at, now()) ELSE paused_at END,
            retired_at = CASE WHEN $2 = 'retired' THEN COALESCE(retired_at, now()) ELSE retired_at END,
            reason = CASE WHEN $2 IN ('paused', 'retired') THEN $4 ELSE reason END,
            updated_at = now()
        WHERE id = $1 AND status = ANY($3::text[])
        RETURNING ${STRATEGY_RETURNING_COLUMNS}
      `,
      [id.trim(), nextStatus, requiredStatuses, normalizeStrategyReason(reason)]
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

export async function ensureStrategiesSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/002_strategies.sql", import.meta.url), "utf8"));
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

export function assertValidTransition(currentStatus: StrategyStatus, nextStatus: StrategyStatus): void {
  if (ALLOWED_STRATEGY_TRANSITIONS[currentStatus].includes(nextStatus)) {
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

function assertCanUpdateStrategy(strategy: StrategyRecord): void {
  if (STRATEGY_MUTABLE_STATUSES.includes(strategy.status)) {
    return;
  }

  throw new StrategyLifecycleError(`cannot update strategy ${strategy.id} while ${strategy.status}`);
}

function normalizeStrategiesLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function normalizeStrategyReason(reason: string | undefined): string | null {
  const trimmedReason = reason?.trim();
  return trimmedReason ? trimmedReason : null;
}

function setStrategyReason(strategy: StrategyRecord, reason: string | undefined): void {
  const normalizedReason = normalizeStrategyReason(reason);

  if (normalizedReason === null) {
    delete strategy.reason;
  } else {
    strategy.reason = normalizedReason;
  }
}

function cloneStrategy(strategy: StrategyRecord): StrategyRecord {
  return {
    ...strategy,
    parameters: { ...strategy.parameters }
  };
}

const ALLOWED_STRATEGY_TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  draft: ["under_discussion", "approved"],
  under_discussion: ["approved", "draft"],
  approved: ["active"],
  active: ["paused", "retired"],
  paused: ["active", "retired"],
  retired: []
};

const STRATEGY_MUTABLE_STATUSES: StrategyStatus[] = ["draft", "under_discussion"];

const STRATEGY_RETURNING_COLUMNS = "id, name, description, status, parameters, created_at, updated_at, approved_at, activated_at, discussion_started_at, paused_at, retired_at, reason";

export type StrategyRow = {
  id: string;
  name: string;
  description: string | null;
  status: StrategyStatus;
  parameters: QuantPlaybookParameters;
  created_at: Date | string;
  updated_at: Date | string;
  approved_at: Date | string | null;
  activated_at: Date | string | null;
  discussion_started_at: Date | string | null;
  paused_at: Date | string | null;
  retired_at: Date | string | null;
  reason: string | null;
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

  if (row.description !== null) {
    strategy.description = row.description;
  }

  if (row.approved_at) {
    strategy.approvedAt = toIsoString(row.approved_at);
  }

  if (row.activated_at) {
    strategy.activatedAt = toIsoString(row.activated_at);
  }

  if (row.discussion_started_at) {
    strategy.discussionStartedAt = toIsoString(row.discussion_started_at);
  }

  if (row.paused_at) {
    strategy.pausedAt = toIsoString(row.paused_at);
  }

  if (row.retired_at) {
    strategy.retiredAt = toIsoString(row.retired_at);
  }

  if (row.reason !== null) {
    strategy.reason = row.reason;
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
