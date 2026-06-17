CREATE TABLE IF NOT EXISTS strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'active')),
  parameters jsonb NOT NULL,
  approved_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR approved_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS strategies_status_idx
  ON strategies (status, updated_at);
