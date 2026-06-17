CREATE TABLE IF NOT EXISTS qualitative_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_item_id text NOT NULL,
  link text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  published_at timestamptz,
  tickers text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_item_id)
);

CREATE INDEX IF NOT EXISTS qualitative_items_recency_idx
  ON qualitative_items ((COALESCE(published_at, created_at)) DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS qualitative_items_tickers_idx
  ON qualitative_items USING gin (tickers);
