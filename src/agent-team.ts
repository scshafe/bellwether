import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  BrokerOrderRejectedError,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerPosition
} from "./broker.js";
import { getOrderGuardRailViolations } from "./order-rails.js";
import type { CandidateAction, PortfolioSnapshot, QuantPlaybook } from "./quant-playbook.js";
import type { ReasoningModel } from "./llm.js";
import type { StrategyRecord } from "./strategy.js";

export type AgentProposedOrder = BrokerOrderRequest & {
  symbol: string;
  qty: number;
  side: "buy";
  type: "limit";
  timeInForce: "day";
  limitPrice: number;
  estimatedNotional: number;
};

export type QuantSignalDecisionSnapshot = {
  asOf: string;
  symbol: string;
  score: number;
  signals: CandidateAction["signals"];
  sizing: CandidateAction["sizing"];
};

export type StrategyAnalystDecision = {
  thesis: string;
  proposedOrder: AgentProposedOrder;
};

export type RiskAgentDecision = {
  approved: boolean;
  verdict: "approved" | "rejected";
  rationale: string;
  deterministicViolations: string[];
};

export type ExecutionAgentDecision = {
  decision: "placed" | "skipped" | "rejected";
  rationale: string;
  order?: BrokerOrder;
  brokerRejection?: string;
};

export type AgentDecisionLogInput = {
  id?: string;
  cycleId?: string;
  strategyId: string;
  createdAt?: string;
  quantSignal: QuantSignalDecisionSnapshot;
  brokerSnapshot: {
    account: BrokerAccount;
    positions: BrokerPosition[];
  };
  strategyAnalyst: StrategyAnalystDecision;
  risk: RiskAgentDecision;
  execution: ExecutionAgentDecision;
};

export type AgentDecisionLogEntry = Required<Pick<AgentDecisionLogInput, "id" | "cycleId" | "strategyId" | "createdAt">> &
  Omit<AgentDecisionLogInput, "id" | "cycleId" | "createdAt">;

export interface AgentDecisionLogStore {
  recordDecision(entry: AgentDecisionLogInput): Promise<AgentDecisionLogEntry>;
  getDecision(id: string): Promise<AgentDecisionLogEntry | null>;
}

export class InMemoryAgentDecisionLogStore implements AgentDecisionLogStore {
  private readonly entries = new Map<string, AgentDecisionLogEntry>();

  async recordDecision(entry: AgentDecisionLogInput): Promise<AgentDecisionLogEntry> {
    const stored = normalizeDecisionLogInput(entry);
    this.entries.set(stored.id, cloneDecisionLogEntry(stored));
    return cloneDecisionLogEntry(stored);
  }

  async getDecision(id: string): Promise<AgentDecisionLogEntry | null> {
    const entry = this.entries.get(id.trim());
    return entry ? cloneDecisionLogEntry(entry) : null;
  }
}

export class PostgresAgentDecisionLogStore implements AgentDecisionLogStore {
  constructor(private readonly pool: Pool) {}

  async recordDecision(entry: AgentDecisionLogInput): Promise<AgentDecisionLogEntry> {
    const normalized = normalizeDecisionLogInput(entry);
    const result = await this.pool.query<AgentDecisionLogRow>(
      `
        INSERT INTO agent_decision_logs (
          id, cycle_id, strategy_id, created_at, quant_signal, broker_snapshot,
          strategy_analyst, risk, execution
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
        RETURNING id, cycle_id, strategy_id, created_at, quant_signal, broker_snapshot, strategy_analyst, risk, execution
      `,
      [
        normalized.id,
        normalized.cycleId,
        normalized.strategyId,
        normalized.createdAt,
        JSON.stringify(normalized.quantSignal),
        JSON.stringify(normalized.brokerSnapshot),
        JSON.stringify(normalized.strategyAnalyst),
        JSON.stringify(normalized.risk),
        JSON.stringify(normalized.execution)
      ]
    );

    return rowToDecisionLogEntry(result.rows[0]);
  }

  async getDecision(id: string): Promise<AgentDecisionLogEntry | null> {
    const result = await this.pool.query<AgentDecisionLogRow>(
      `
        SELECT id, cycle_id, strategy_id, created_at, quant_signal, broker_snapshot, strategy_analyst, risk, execution
        FROM agent_decision_logs
        WHERE id = $1
      `,
      [id.trim()]
    );

    return result.rows[0] ? rowToDecisionLogEntry(result.rows[0]) : null;
  }
}

export async function ensureAgentDecisionLogSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_decision_logs (
      id uuid PRIMARY KEY,
      cycle_id text NOT NULL UNIQUE,
      strategy_id uuid NOT NULL,
      created_at timestamptz NOT NULL,
      quant_signal jsonb NOT NULL,
      broker_snapshot jsonb NOT NULL,
      strategy_analyst jsonb NOT NULL,
      risk jsonb NOT NULL,
      execution jsonb NOT NULL
    )
  `);
}

export class StrategyAnalystAgent {
  constructor(private readonly model: ReasoningModel) {}

  async analyze(input: {
    strategy: StrategyRecord;
    playbook: QuantPlaybook;
    portfolio: PortfolioSnapshot;
    brokerSnapshot: { account: BrokerAccount; positions: BrokerPosition[] };
  }): Promise<{ quantSignal: QuantSignalDecisionSnapshot; decision: StrategyAnalystDecision }> {
    const candidate = input.playbook.candidates[0];

    if (!candidate) {
      throw new Error("agent cycle requires at least one quant playbook candidate");
    }

    const response = await this.model.generateJson({
      schemaName: "strategy_analyst_decision",
      systemPrompt:
        "You are the Strategy/Analyst agent. Return JSON only. Form a concise thesis and one proposed buy limit order from the supplied deterministic quant candidate. Do not mention broker endpoint class or account mode.",
      userPrompt: JSON.stringify({
        strategy: strategyPromptShape(input.strategy),
        quantCandidate: candidate,
        portfolio: input.portfolio,
        brokerPositions: input.brokerSnapshot.positions
      })
    });
    const parsed = strategyAnalystResponse(response);
    const proposedOrder = toAgentProposedOrder(parsed, candidate, input.strategy.id);

    return {
      quantSignal: {
        asOf: input.playbook.asOf,
        symbol: candidate.symbol,
        score: candidate.score,
        signals: candidate.signals,
        sizing: candidate.sizing
      },
      decision: {
        thesis: parsed.thesis,
        proposedOrder
      }
    };
  }
}

export class RiskAgent {
  constructor(private readonly model: ReasoningModel) {}

  async evaluate(input: {
    strategy: StrategyRecord;
    playbook: QuantPlaybook;
    analystDecision: StrategyAnalystDecision;
  }): Promise<RiskAgentDecision> {
    const deterministicViolations = getOrderGuardRailViolations(input.analystDecision.proposedOrder, input.playbook.rails);
    const response = await this.model.generateJson({
      schemaName: "risk_agent_verdict",
      systemPrompt:
        "You are the Risk agent. Return JSON only. Explain whether the proposal should proceed inside the deterministic rails; the rails remain structural outside your reasoning.",
      userPrompt: JSON.stringify({
        strategy: strategyPromptShape(input.strategy),
        proposedOrder: input.analystDecision.proposedOrder,
        deterministicViolations
      })
    });
    const parsed = riskAgentResponse(response);
    const approved = deterministicViolations.length === 0 && parsed.verdict === "approved";

    return {
      approved,
      verdict: approved ? "approved" : "rejected",
      rationale: parsed.rationale,
      deterministicViolations
    };
  }
}

export class ExecutionAgent {
  constructor(
    private readonly model: ReasoningModel,
    private readonly broker: BrokerAdapter
  ) {}

  async execute(input: {
    strategy: StrategyRecord;
    analystDecision: StrategyAnalystDecision;
    riskDecision: RiskAgentDecision;
    cycleId: string;
  }): Promise<ExecutionAgentDecision> {
    if (!input.riskDecision.approved) {
      return {
        decision: "skipped",
        rationale: `risk rejected the order: ${input.riskDecision.rationale}`
      };
    }

    const response = await this.model.generateJson({
      schemaName: "execution_agent_decision",
      systemPrompt:
        "You are the Execution agent. Return JSON only. Decide whether to submit the already risk-approved order through the broker adapter. Do not mention broker endpoint class or account mode.",
      userPrompt: JSON.stringify({
        strategy: strategyPromptShape(input.strategy),
        proposedOrder: input.analystDecision.proposedOrder,
        riskDecision: input.riskDecision
      })
    });
    const parsed = executionAgentResponse(response);

    if (parsed.decision !== "place") {
      return { decision: "skipped", rationale: parsed.rationale };
    }

    try {
      const order = await this.broker.placeOrder({
        ...input.analystDecision.proposedOrder,
        strategyId: input.strategy.id,
        clientOrderId: `atp-${input.cycleId}`
      });

      return { decision: "placed", rationale: parsed.rationale, order };
    } catch (error: unknown) {
      if (error instanceof BrokerOrderRejectedError) {
        return { decision: "rejected", rationale: parsed.rationale, brokerRejection: error.message };
      }

      throw error;
    }
  }
}

export type RunMinimalAgentTeamTradeInput = {
  strategy: StrategyRecord;
  playbook: QuantPlaybook;
  portfolio: PortfolioSnapshot;
  broker: BrokerAdapter;
  model: ReasoningModel;
  decisionLogStore: AgentDecisionLogStore;
  cycleId?: string;
};

export type AgentTeamTradeCycleResult = {
  cycleId: string;
  quantSignal: QuantSignalDecisionSnapshot;
  strategyAnalyst: StrategyAnalystDecision;
  risk: RiskAgentDecision;
  execution: ExecutionAgentDecision;
  decisionLog: AgentDecisionLogEntry;
};

export async function runMinimalAgentTeamTrade(input: RunMinimalAgentTeamTradeInput): Promise<AgentTeamTradeCycleResult> {
  const cycleId = input.cycleId ?? randomUUID();
  const brokerSnapshot = {
    account: await input.broker.getAccount(),
    positions: await input.broker.getPositions()
  };
  const analyst = new StrategyAnalystAgent(input.model);
  const risk = new RiskAgent(input.model);
  const execution = new ExecutionAgent(input.model, input.broker);
  const analystOutput = await analyst.analyze({
    strategy: input.strategy,
    playbook: input.playbook,
    portfolio: input.portfolio,
    brokerSnapshot
  });
  const riskDecision = await risk.evaluate({
    strategy: input.strategy,
    playbook: input.playbook,
    analystDecision: analystOutput.decision
  });
  const executionDecision = await execution.execute({
    strategy: input.strategy,
    analystDecision: analystOutput.decision,
    riskDecision,
    cycleId
  });
  const decisionLog = await input.decisionLogStore.recordDecision({
    cycleId,
    strategyId: input.strategy.id,
    quantSignal: analystOutput.quantSignal,
    brokerSnapshot,
    strategyAnalyst: analystOutput.decision,
    risk: riskDecision,
    execution: executionDecision
  });

  return {
    cycleId,
    quantSignal: analystOutput.quantSignal,
    strategyAnalyst: analystOutput.decision,
    risk: riskDecision,
    execution: executionDecision,
    decisionLog
  };
}

function normalizeDecisionLogInput(entry: AgentDecisionLogInput): AgentDecisionLogEntry {
  return {
    id: entry.id ?? randomUUID(),
    cycleId: entry.cycleId ?? randomUUID(),
    strategyId: entry.strategyId,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    quantSignal: cloneJson(entry.quantSignal),
    brokerSnapshot: cloneJson(entry.brokerSnapshot),
    strategyAnalyst: cloneJson(entry.strategyAnalyst),
    risk: cloneJson(entry.risk),
    execution: cloneJson(entry.execution)
  };
}

function cloneDecisionLogEntry(entry: AgentDecisionLogEntry): AgentDecisionLogEntry {
  return cloneJson(entry);
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

type StrategyAnalystParsedResponse = {
  thesis: string;
  symbol: string;
  qty: number;
  limitPrice: number;
};

function strategyAnalystResponse(value: unknown): StrategyAnalystParsedResponse {
  const record = objectValue(value, "strategy analyst response");
  return {
    thesis: stringValue(record.thesis, "thesis"),
    symbol: stringValue(record.symbol, "symbol"),
    qty: positiveNumberValue(record.qty, "qty"),
    limitPrice: positiveNumberValue(record.limitPrice, "limitPrice")
  };
}

function toAgentProposedOrder(
  parsed: StrategyAnalystParsedResponse,
  candidate: CandidateAction,
  strategyId: string
): AgentProposedOrder {
  const symbol = parsed.symbol.trim().toUpperCase();
  const estimatedNotional = parsed.qty * parsed.limitPrice;

  if (symbol !== candidate.symbol) {
    throw new Error(`strategy analyst proposed ${symbol}, but the selected quant candidate is ${candidate.symbol}`);
  }

  return {
    strategyId,
    symbol,
    qty: parsed.qty,
    side: "buy",
    type: "limit",
    timeInForce: "day",
    limitPrice: parsed.limitPrice,
    estimatedNotional
  };
}

type RiskParsedResponse = {
  verdict: "approved" | "rejected";
  rationale: string;
};

function riskAgentResponse(value: unknown): RiskParsedResponse {
  const record = objectValue(value, "risk agent response");
  const verdict = stringValue(record.verdict, "verdict");

  if (verdict !== "approved" && verdict !== "rejected") {
    throw new Error("risk verdict must be approved or rejected");
  }

  return {
    verdict,
    rationale: stringValue(record.rationale, "rationale")
  };
}

type ExecutionParsedResponse = {
  decision: "place" | "skip";
  rationale: string;
};

function executionAgentResponse(value: unknown): ExecutionParsedResponse {
  const record = objectValue(value, "execution agent response");
  const decision = stringValue(record.decision, "decision");

  if (decision !== "place" && decision !== "skip") {
    throw new Error("execution decision must be place or skip");
  }

  return {
    decision,
    rationale: stringValue(record.rationale, "rationale")
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

  return value;
}

function positiveNumberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return value;
}

type AgentDecisionLogRow = {
  id: string;
  cycle_id: string;
  strategy_id: string;
  created_at: Date | string;
  quant_signal: QuantSignalDecisionSnapshot;
  broker_snapshot: AgentDecisionLogEntry["brokerSnapshot"];
  strategy_analyst: StrategyAnalystDecision;
  risk: RiskAgentDecision;
  execution: ExecutionAgentDecision;
};

function rowToDecisionLogEntry(row: AgentDecisionLogRow | undefined): AgentDecisionLogEntry {
  if (!row) {
    throw new Error("agent decision log query returned no rows");
  }

  return {
    id: row.id,
    cycleId: row.cycle_id,
    strategyId: row.strategy_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    quantSignal: cloneJson(row.quant_signal),
    brokerSnapshot: cloneJson(row.broker_snapshot),
    strategyAnalyst: cloneJson(row.strategy_analyst),
    risk: cloneJson(row.risk),
    execution: cloneJson(row.execution)
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
