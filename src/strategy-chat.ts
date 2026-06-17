import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import type { PortalQualitativeEvidence } from "./agent-team.js";
import type { LlmJsonRequest, ReasoningModel } from "./llm.js";
import type { QuantPlaybookParameters } from "./quant-playbook.js";
import { type StrategyRecord, validateStrategyParameters } from "./strategy.js";

export const STRATEGY_CHAT_ROLES = ["user", "analyst"] as const;
export const STRATEGY_CHAT_MODES = ["formalize", "brainstorm"] as const;

export type StrategyChatRole = (typeof STRATEGY_CHAT_ROLES)[number];
export type StrategyChatMode = (typeof STRATEGY_CHAT_MODES)[number];

export type StrategyChatMessage = {
  id: string;
  strategyId: string;
  role: StrategyChatRole;
  content: string;
  createdAt: string;
  metadata?: StrategyChatMessageMetadata;
};

export type StrategyChatMessageMetadata = {
  mode?: StrategyChatMode;
  proposedParameterDelta?: Partial<QuantPlaybookParameters>;
  candidateIdeas?: StrategyChatCandidateIdea[];
  fallback?: boolean;
};

export type StrategyChatCandidateIdea = {
  name: string;
  mandate: string;
  suggestedParameters: Partial<QuantPlaybookParameters>;
};

export type AppendStrategyChatMessageInput = {
  id?: string;
  strategyId: string;
  role: StrategyChatRole;
  content: string;
  createdAt?: string;
  metadata?: StrategyChatMessageMetadata;
};

export interface StrategyChatStore {
  appendMessage(input: AppendStrategyChatMessageInput): Promise<StrategyChatMessage>;
  listMessages(strategyId: string, limit?: number): Promise<StrategyChatMessage[]>;
}

export class InMemoryStrategyChatStore implements StrategyChatStore {
  private messages: StrategyChatMessage[] = [];

  constructor(initialMessages: StrategyChatMessage[] = []) {
    this.messages = initialMessages.map(cloneMessage);
  }

  async appendMessage(input: AppendStrategyChatMessageInput): Promise<StrategyChatMessage> {
    const message = normalizeChatMessageInput(input);
    this.messages.push(cloneMessage(message));
    return cloneMessage(message);
  }

  async listMessages(strategyId: string, limit = 100): Promise<StrategyChatMessage[]> {
    const normalizedStrategyId = strategyId.trim();
    return this.messages
      .filter((message) => message.strategyId === normalizedStrategyId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(-normalizeChatLimit(limit))
      .map(cloneMessage);
  }
}

export class PostgresStrategyChatStore implements StrategyChatStore {
  constructor(private readonly pool: Pool) {}

  async appendMessage(input: AppendStrategyChatMessageInput): Promise<StrategyChatMessage> {
    const message = normalizeChatMessageInput(input);
    const result = await this.pool.query<StrategyChatMessageRow>(
      `
        INSERT INTO strategy_chat_messages (id, strategy_id, role, content, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        RETURNING id, strategy_id, role, content, metadata, created_at
      `,
      [
        message.id,
        message.strategyId,
        message.role,
        message.content,
        JSON.stringify(message.metadata ?? {}),
        message.createdAt
      ]
    );

    return rowToChatMessage(result.rows[0]);
  }

  async listMessages(strategyId: string, limit = 100): Promise<StrategyChatMessage[]> {
    const result = await this.pool.query<StrategyChatMessageRow>(
      `
        SELECT id, strategy_id, role, content, metadata, created_at
        FROM strategy_chat_messages
        WHERE strategy_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      `,
      [strategyId.trim(), normalizeChatLimit(limit)]
    );

    return result.rows.map(rowToChatMessage);
  }
}

export async function ensureStrategyChatSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/007_strategy_chat_messages.sql", import.meta.url), "utf8"));
}

export type StrategyChatTurnInput = {
  strategy: StrategyRecord;
  operatorMessage: string;
  priorThread: StrategyChatMessage[];
  mode?: StrategyChatMode;
  qualitativeBrief?: PortalQualitativeEvidence;
};

export class StrategyChatAgent {
  constructor(private readonly model: ReasoningModel) {}

  async reply(input: StrategyChatTurnInput): Promise<Pick<AppendStrategyChatMessageInput, "content" | "metadata">> {
    const mode = input.mode ?? inferChatMode(input.operatorMessage);
    const response = await this.model.generateJson({
      schemaName: "strategy_chat_turn",
      systemPrompt:
        "You are the Strategy/Analyst chat agent for a paper-only family trading platform. Return JSON only. This chat is advisory: never claim that a strategy, parameter set, lifecycle state, or order has been changed. For formalize mode, explain the rationale and propose only a QuantPlaybookParameters delta for operator review; it is not applied. For brainstorm mode, propose candidate strategy ideas for discussion. Do not propose or discuss order placement. Do not mention broker endpoint class or account mode.",
      userPrompt: JSON.stringify({
        mode,
        strategy: strategyPromptShape(input.strategy),
        quantPlaybookParameters: input.strategy.parameters,
        qualitativeBrief: input.qualitativeBrief,
        priorThread: input.priorThread.map((message) => ({
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          metadata: message.metadata
        })),
        operatorMessage: input.operatorMessage
      })
    });

    return parsedChatReply(response, input.strategy.parameters, mode);
  }
}

export function fallbackStrategyChatReply(): Pick<AppendStrategyChatMessageInput, "content" | "metadata"> {
  return {
    content:
      "I saved your message, but the Strategy/Analyst chat turn could not complete. No strategy fields, parameters, lifecycle state, or orders were changed.",
    metadata: { fallback: true }
  };
}

export function withStrategyChatSchemaHints(model: ReasoningModel): ReasoningModel {
  return {
    generateJson: (request: LlmJsonRequest) => model.generateJson({
      ...request,
      systemPrompt: `${request.systemPrompt}\n\n${strategyChatSchemaHint(request)}`
    })
  };
}

function strategyChatSchemaHint(request: LlmJsonRequest): string {
  if (request.schemaName === "strategy_chat_turn") {
    return "Schema: return exactly {\"mode\": \"formalize\" | \"brainstorm\", \"content\": string, \"proposedParameterDelta\"?: object, \"candidateIdeas\"?: [{\"name\": string, \"mandate\": string, \"suggestedParameters\": object}]}. proposedParameterDelta and suggestedParameters may include only QuantPlaybookParameters numeric keys. Return advisory proposals only; do not say anything was applied.";
  }

  return "Return only a single JSON object matching the named strategy chat schema.";
}

function parsedChatReply(
  value: unknown,
  currentParameters: QuantPlaybookParameters,
  requestedMode: StrategyChatMode
): Pick<AppendStrategyChatMessageInput, "content" | "metadata"> {
  const record = objectValue(value, "strategy chat response");
  const mode = optionalMode(record.mode) ?? requestedMode;
  const content = stringValue(record.content, "content");
  const metadata: StrategyChatMessageMetadata = { mode };

  const proposedParameterDelta = parameterDeltaValue(record.proposedParameterDelta);
  if (proposedParameterDelta) {
    validateStrategyParameters({ ...currentParameters, ...proposedParameterDelta });
    metadata.proposedParameterDelta = proposedParameterDelta;
  }

  const candidateIdeas = candidateIdeasValue(record.candidateIdeas, currentParameters);
  if (candidateIdeas.length > 0) {
    metadata.candidateIdeas = candidateIdeas;
  }

  return { content, metadata };
}

function candidateIdeasValue(value: unknown, currentParameters: QuantPlaybookParameters): StrategyChatCandidateIdea[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((candidate) => candidateIdeaValue(candidate, currentParameters)).filter(isDefined).slice(0, 5);
}

function candidateIdeaValue(value: unknown, currentParameters: QuantPlaybookParameters): StrategyChatCandidateIdea | null {
  const record = optionalObjectValue(value);

  if (!record) {
    return null;
  }

  const name = optionalString(record.name);
  const mandate = optionalString(record.mandate);
  const suggestedParameters = parameterDeltaValue(record.suggestedParameters) ?? {};

  if (!name || !mandate) {
    return null;
  }

  validateStrategyParameters({ ...currentParameters, ...suggestedParameters });

  return { name, mandate, suggestedParameters };
}

function parameterDeltaValue(value: unknown): Partial<QuantPlaybookParameters> | null {
  const record = optionalObjectValue(value);

  if (!record) {
    return null;
  }

  const delta: Partial<QuantPlaybookParameters> = {};

  for (const key of quantPlaybookParameterKeys) {
    if (record[key] === undefined) {
      continue;
    }

    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
      throw new Error(`strategy chat parameter ${key} must be a finite number`);
    }

    delta[key] = record[key];
  }

  return Object.keys(delta).length > 0 ? delta : null;
}

function normalizeChatMessageInput(input: AppendStrategyChatMessageInput): StrategyChatMessage {
  const strategyId = input.strategyId.trim();
  const content = input.content.trim();

  if (!strategyId) {
    throw new Error("strategy chat message strategyId is required");
  }

  if (!STRATEGY_CHAT_ROLES.includes(input.role)) {
    throw new Error("strategy chat message role must be user or analyst");
  }

  if (!content) {
    throw new Error("strategy chat message content is required");
  }

  return {
    id: input.id ?? randomUUID(),
    strategyId,
    role: input.role,
    content,
    createdAt: input.createdAt ?? nextChatTimestamp(),
    ...(input.metadata ? { metadata: cloneJson(input.metadata) } : {})
  };
}

function nextChatTimestamp(): string {
  const now = Date.now();
  lastGeneratedChatTimestampMs = Math.max(now, lastGeneratedChatTimestampMs + 1);
  return new Date(lastGeneratedChatTimestampMs).toISOString();
}

function rowToChatMessage(row: StrategyChatMessageRow | undefined): StrategyChatMessage {
  if (!row) {
    throw new Error("strategy chat message query returned no rows");
  }

  return {
    id: row.id,
    strategyId: row.strategy_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    ...(Object.keys(row.metadata ?? {}).length > 0 ? { metadata: cloneJson(row.metadata) } : {})
  };
}

function normalizeChatLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 100;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function inferChatMode(message: string): StrategyChatMode {
  return /brainstorm|idea|candidate|new strategy/iu.test(message) ? "brainstorm" : "formalize";
}

function strategyPromptShape(strategy: StrategyRecord): Record<string, unknown> {
  return {
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    status: strategy.status,
    parameters: strategy.parameters
  };
}

function optionalMode(value: unknown): StrategyChatMode | null {
  return value === "formalize" || value === "brainstorm" ? value : null;
}

function objectValue(value: unknown, description: string): Record<string, unknown> {
  const record = optionalObjectValue(value);

  if (!record) {
    throw new Error(`${description} must be an object`);
  }

  return record;
}

function optionalObjectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, name: string): string {
  const normalized = optionalString(value);

  if (!normalized) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cloneMessage(message: StrategyChatMessage): StrategyChatMessage {
  return cloneJson(message);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

type StrategyChatMessageRow = {
  id: string;
  strategy_id: string;
  role: StrategyChatRole;
  content: string;
  metadata: StrategyChatMessageMetadata;
  created_at: Date | string;
};

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

let lastGeneratedChatTimestampMs = 0;
