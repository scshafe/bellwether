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
);

ALTER TABLE agent_decision_logs
  ADD COLUMN IF NOT EXISTS qualitative_evidence jsonb;
