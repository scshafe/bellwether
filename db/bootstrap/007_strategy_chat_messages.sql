CREATE TABLE IF NOT EXISTS strategy_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'analyst')),
  content text NOT NULL CHECK (length(trim(content)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS strategy_chat_messages_strategy_created_idx
  ON strategy_chat_messages (strategy_id, created_at ASC, id ASC);
