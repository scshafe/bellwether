CREATE TABLE IF NOT EXISTS agent_runtime_status (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  active_job_id uuid REFERENCES agent_jobs(id),
  last_cycle_job_id uuid REFERENCES agent_jobs(id),
  last_cycle_status text CHECK (last_cycle_status IN ('succeeded', 'failed', 'cancelled')),
  last_cycle_summary text,
  last_cycle_decision_log_id uuid,
  last_cycle_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_runtime_status (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;
