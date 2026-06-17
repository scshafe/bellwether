CREATE TABLE IF NOT EXISTS broker_flip_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_mode text NOT NULL CHECK (from_mode IN ('paper', 'live')),
  to_mode text NOT NULL CHECK (to_mode IN ('paper', 'live')),
  confirmed_by text NOT NULL CHECK (length(trim(confirmed_by)) > 0),
  confirmed_by_role text NOT NULL CHECK (confirmed_by_role IN ('admin', 'manager')),
  second_operator text NOT NULL CHECK (length(trim(second_operator)) > 0),
  second_operator_role text NOT NULL CHECK (second_operator_role IN ('admin', 'manager')),
  flip_verification_id text NOT NULL CHECK (length(trim(flip_verification_id)) > 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_flip_log_distinct_operators_check CHECK (confirmed_by <> second_operator)
);

CREATE INDEX IF NOT EXISTS broker_flip_log_created_idx
  ON broker_flip_log (created_at DESC, id DESC);
