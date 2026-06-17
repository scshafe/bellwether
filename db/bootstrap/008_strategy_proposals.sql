CREATE TABLE IF NOT EXISTS strategy_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending',
  strategy_id uuid REFERENCES strategies(id) ON DELETE SET NULL,
  suggested_candidate jsonb NOT NULL,
  quant_rationale text NOT NULL CHECK (length(trim(quant_rationale)) > 0),
  qualitative_evidence jsonb NOT NULL DEFAULT '{"links":[],"quotes":[],"signals":[]}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CONSTRAINT strategy_proposals_status_check CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  CONSTRAINT strategy_proposals_reviewed_at_check CHECK (
    (status = 'pending' AND reviewed_at IS NULL)
    OR (status <> 'pending' AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS strategy_proposals_status_created_idx
  ON strategy_proposals (status, created_at DESC, id DESC);
