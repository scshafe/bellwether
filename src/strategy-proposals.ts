import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import type { PortalQualitativeEvidence } from "./agent-team.js";
import type { ReasoningModel } from "./llm.js";
import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type PortfolioSnapshot, type QuantPlaybook } from "./quant-playbook.js";
import { emptyQualitativeEvidence } from "./qualitative-brief.js";
import { type StrategyRecord, validateStrategyParameters } from "./strategy.js";
import {
  candidateIdeaValue,
  parameterDeltaValue,
  type StrategyChatCandidateIdea,
  strategyPromptShape
} from "./strategy-chat.js";

export const STRATEGY_PROPOSAL_STATUSES = ["pending", "reviewed", "dismissed"] as const;

export type StrategyProposalStatus = (typeof STRATEGY_PROPOSAL_STATUSES)[number];

export type StrategyProposalRecord = {
  id: string;
  status: StrategyProposalStatus;
  strategyId?: string;
  suggestedCandidate: StrategyChatCandidateIdea;
  quantRationale: string;
  qualitativeEvidence: PortalQualitativeEvidence;
  createdAt: string;
  reviewedAt?: string;
};

export type RecordStrategyProposalInput = {
  id?: string;
  strategyId?: string;
  suggestedCandidate: StrategyChatCandidateIdea;
  quantRationale: string;
  qualitativeEvidence: PortalQualitativeEvidence;
  createdAt?: string;
};

export interface StrategyProposalsStore {
  recordProposal(input: RecordStrategyProposalInput): Promise<StrategyProposalRecord>;
  listPending(limit?: number): Promise<StrategyProposalRecord[]>;
  markReviewed(id: string, status?: Exclude<StrategyProposalStatus, "pending">): Promise<StrategyProposalRecord>;
}

export type StrategyProposalAgentInput = {
  strategy: StrategyRecord;
  playbook: QuantPlaybook;
  portfolio: PortfolioSnapshot;
  qualitativeBrief?: PortalQualitativeEvidence;
};

export type StrategyProposalAgentOutput = Pick<
  StrategyProposalRecord,
  "suggestedCandidate" | "quantRationale" | "qualitativeEvidence"
>;

export class StrategyProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`strategy proposal ${proposalId} was not found`);
    this.name = "StrategyProposalNotFoundError";
  }
}

export class InMemoryStrategyProposalsStore implements StrategyProposalsStore {
  private readonly proposals = new Map<string, StrategyProposalRecord>();

  constructor(initialProposals: StrategyProposalRecord[] = []) {
    for (const proposal of initialProposals) {
      this.proposals.set(proposal.id, cloneProposal(proposal));
    }
  }

  async recordProposal(input: RecordStrategyProposalInput): Promise<StrategyProposalRecord> {
    const proposal = normalizeRecordProposalInput(input);

    if (this.proposals.has(proposal.id)) {
      throw new Error(`strategy proposal ${proposal.id} already exists`);
    }

    this.proposals.set(proposal.id, cloneProposal(proposal));
    return cloneProposal(proposal);
  }

  async listPending(limit = 50): Promise<StrategyProposalRecord[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.status === "pending")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, normalizeProposalLimit(limit))
      .map(cloneProposal);
  }

  async markReviewed(id: string, status: Exclude<StrategyProposalStatus, "pending"> = "reviewed"): Promise<StrategyProposalRecord> {
    const proposal = this.proposals.get(id.trim());

    if (!proposal) {
      throw new StrategyProposalNotFoundError(id);
    }

    const updated: StrategyProposalRecord = {
      ...proposal,
      status,
      reviewedAt: new Date().toISOString()
    };
    this.proposals.set(updated.id, cloneProposal(updated));
    return cloneProposal(updated);
  }
}

export class PostgresStrategyProposalsStore implements StrategyProposalsStore {
  constructor(private readonly pool: Pool) {}

  async recordProposal(input: RecordStrategyProposalInput): Promise<StrategyProposalRecord> {
    const proposal = normalizeRecordProposalInput(input);
    const result = await this.pool.query<StrategyProposalRow>(
      `
        INSERT INTO strategy_proposals (
          id, status, strategy_id, suggested_candidate, quant_rationale, qualitative_evidence, created_at, reviewed_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)
        RETURNING id, status, strategy_id, suggested_candidate, quant_rationale, qualitative_evidence, created_at, reviewed_at
      `,
      [
        proposal.id,
        proposal.status,
        proposal.strategyId ?? null,
        JSON.stringify(proposal.suggestedCandidate),
        proposal.quantRationale,
        JSON.stringify(proposal.qualitativeEvidence),
        proposal.createdAt,
        proposal.reviewedAt ?? null
      ]
    );

    return rowToProposal(result.rows[0]);
  }

  async listPending(limit = 50): Promise<StrategyProposalRecord[]> {
    const result = await this.pool.query<StrategyProposalRow>(
      `
        SELECT id, status, strategy_id, suggested_candidate, quant_rationale, qualitative_evidence, created_at, reviewed_at
        FROM strategy_proposals
        WHERE status = 'pending'
        ORDER BY created_at DESC, id DESC
        LIMIT $1
      `,
      [normalizeProposalLimit(limit)]
    );

    return result.rows.map(rowToProposal);
  }

  async markReviewed(id: string, status: Exclude<StrategyProposalStatus, "pending"> = "reviewed"): Promise<StrategyProposalRecord> {
    const result = await this.pool.query<StrategyProposalRow>(
      `
        UPDATE strategy_proposals
        SET status = $2,
            reviewed_at = now()
        WHERE id = $1
        RETURNING id, status, strategy_id, suggested_candidate, quant_rationale, qualitative_evidence, created_at, reviewed_at
      `,
      [id.trim(), status]
    );

    if (!result.rows[0]) {
      throw new StrategyProposalNotFoundError(id);
    }

    return rowToProposal(result.rows[0]);
  }
}

export async function ensureStrategyProposalsSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/008_strategy_proposals.sql", import.meta.url), "utf8"));
}

export class StrategyProposalAgent {
  constructor(private readonly model: ReasoningModel) {}

  async propose(input: StrategyProposalAgentInput): Promise<StrategyProposalAgentOutput> {
    const qualitativeEvidence = cloneQualitativeEvidence(input.qualitativeBrief ?? emptyQualitativeEvidence());
    const response = await this.model.generateJson({
      schemaName: "strategy_proposal_candidate",
      systemPrompt:
        "You are the Strategy Proposal agent for a family trading platform. Return JSON only. This turn is advisory: never claim that a strategy, parameter set, lifecycle state, or order has been changed. Propose only one candidate strategy idea for operator review. Do not propose or discuss order placement. Do not mention broker endpoint class or account mode.",
      userPrompt: JSON.stringify({
        strategy: strategyPromptShape(input.strategy),
        quantPlaybook: quantPlaybookPromptShape(input.playbook),
        portfolio: input.portfolio,
        qualitativeBrief: qualitativeEvidence
      })
    });

    const record = objectValue(response, "strategy proposal response");
    const suggestedCandidate = candidateIdeaValue(record.suggestedCandidate ?? record.candidate, input.strategy.parameters);

    if (!suggestedCandidate) {
      throw new Error("strategy proposal response must include a valid suggestedCandidate");
    }

    validateStrategyParameters({ ...input.strategy.parameters, ...suggestedCandidate.suggestedParameters });

    return {
      suggestedCandidate,
      quantRationale: stringValue(record.quantRationale ?? record.rationale, "quantRationale"),
      qualitativeEvidence
    };
  }
}

function normalizeRecordProposalInput(input: RecordStrategyProposalInput): StrategyProposalRecord {
  const quantRationale = input.quantRationale.trim();
  const suggestedCandidate = normalizeSuggestedCandidate(input.suggestedCandidate);

  if (!quantRationale) {
    throw new Error("strategy proposal quantRationale is required");
  }

  return {
    id: input.id ?? randomUUID(),
    status: "pending",
    suggestedCandidate,
    quantRationale,
    qualitativeEvidence: cloneQualitativeEvidence(input.qualitativeEvidence),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.strategyId ? { strategyId: input.strategyId.trim() } : {})
  };
}

function normalizeSuggestedCandidate(candidate: StrategyChatCandidateIdea): StrategyChatCandidateIdea {
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const mandate = typeof candidate.mandate === "string" ? candidate.mandate.trim() : "";
  const suggestedParameters = parameterDeltaValue(candidate.suggestedParameters) ?? {};

  if (!name || !mandate) {
    throw new Error("strategy proposal suggestedCandidate is invalid");
  }

  validateStrategyParameters({ ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS, ...suggestedParameters });

  return { name, mandate, suggestedParameters };
}

function rowToProposal(row: StrategyProposalRow | undefined): StrategyProposalRecord {
  if (!row) {
    throw new Error("strategy proposal query returned no rows");
  }

  validateProposalStatus(row.status);
  const proposal: StrategyProposalRecord = {
    id: row.id,
    status: row.status,
    suggestedCandidate: cloneJson(row.suggested_candidate),
    quantRationale: row.quant_rationale,
    qualitativeEvidence: cloneQualitativeEvidence(row.qualitative_evidence),
    createdAt: toIsoString(row.created_at)
  };

  if (row.strategy_id) {
    proposal.strategyId = row.strategy_id;
  }

  if (row.reviewed_at) {
    proposal.reviewedAt = toIsoString(row.reviewed_at);
  }

  return proposal;
}

function validateProposalStatus(status: string): asserts status is StrategyProposalStatus {
  if (!STRATEGY_PROPOSAL_STATUSES.includes(status as StrategyProposalStatus)) {
    throw new Error(`strategy proposal status ${status} is invalid`);
  }
}

function normalizeProposalLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function quantPlaybookPromptShape(playbook: QuantPlaybook): Record<string, unknown> {
  return {
    asOf: playbook.asOf,
    parameters: playbook.parameters,
    candidates: playbook.candidates.slice(0, 5),
    screenedUniverse: playbook.screenedUniverse.slice(0, 10).map((asset) => ({
      symbol: asset.symbol,
      sector: asset.sector,
      lastPrice: asset.lastPrice,
      passed: asset.passed,
      rejectReasons: asset.rejectReasons,
      signals: asset.signals
    }))
  };
}

function objectValue(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }

  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function cloneProposal(proposal: StrategyProposalRecord): StrategyProposalRecord {
  return cloneJson(proposal);
}

function cloneQualitativeEvidence(evidence: PortalQualitativeEvidence): PortalQualitativeEvidence {
  return cloneJson(evidence);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

type StrategyProposalRow = {
  id: string;
  status: string;
  strategy_id: string | null;
  suggested_candidate: StrategyChatCandidateIdea;
  quant_rationale: string;
  qualitative_evidence: PortalQualitativeEvidence;
  created_at: Date | string;
  reviewed_at: Date | string | null;
};
