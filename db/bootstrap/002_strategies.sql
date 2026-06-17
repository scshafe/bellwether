CREATE TABLE IF NOT EXISTS strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CONSTRAINT strategies_name_not_blank CHECK (btrim(name) <> ''),
  description text,
  status text NOT NULL DEFAULT 'draft' CONSTRAINT strategies_status_check CHECK (status IN ('draft', 'under_discussion', 'approved', 'active', 'paused', 'retired')),
  parameters jsonb NOT NULL,
  discussion_started_at timestamptz,
  approved_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  retired_at timestamptz,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategies_active_requires_approval CHECK (status <> 'active' OR approved_at IS NOT NULL),
  CONSTRAINT strategies_paused_requires_activation CHECK (status <> 'paused' OR activated_at IS NOT NULL),
  CONSTRAINT strategies_retired_requires_activation CHECK (status <> 'retired' OR activated_at IS NOT NULL)
);

ALTER TABLE strategies ADD COLUMN IF NOT EXISTS discussion_started_at timestamptz;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS reason text;

DO $$
DECLARE
  legacy_status_constraint text;
BEGIN
  SELECT table_constraint.constraint_name
  INTO legacy_status_constraint
  FROM information_schema.table_constraints table_constraint
  JOIN information_schema.check_constraints check_constraint
    ON check_constraint.constraint_schema = table_constraint.constraint_schema
    AND check_constraint.constraint_name = table_constraint.constraint_name
  WHERE table_constraint.constraint_schema = current_schema()
    AND table_constraint.table_name = 'strategies'
    AND table_constraint.constraint_type = 'CHECK'
    AND table_constraint.constraint_name <> 'strategies_status_check'
    AND check_constraint.check_clause LIKE '%status%'
    AND check_constraint.check_clause LIKE '%draft%'
    AND check_constraint.check_clause LIKE '%approved%'
    AND check_constraint.check_clause LIKE '%active%'
  LIMIT 1;

  IF legacy_status_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE strategies DROP CONSTRAINT %I', legacy_status_constraint);
  END IF;
END $$;

ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_status_check;
ALTER TABLE strategies ADD CONSTRAINT strategies_status_check CHECK (status IN ('draft', 'under_discussion', 'approved', 'active', 'paused', 'retired'));

ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_active_requires_approval;
ALTER TABLE strategies ADD CONSTRAINT strategies_active_requires_approval CHECK (status <> 'active' OR approved_at IS NOT NULL);

ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_paused_requires_activation;
ALTER TABLE strategies ADD CONSTRAINT strategies_paused_requires_activation CHECK (status <> 'paused' OR activated_at IS NOT NULL);

ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_retired_requires_activation;
ALTER TABLE strategies ADD CONSTRAINT strategies_retired_requires_activation CHECK (status <> 'retired' OR activated_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS strategies_status_idx
  ON strategies (status, updated_at);
