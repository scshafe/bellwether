CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('rss', 'atom', 'programmatic')),
  feed_url text,
  enabled boolean NOT NULL DEFAULT false,
  quality_rating integer NOT NULL DEFAULT 3 CHECK (quality_rating BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_type = 'programmatic' OR feed_url IS NOT NULL)
);

INSERT INTO sources (id, source_key, name, source_type, feed_url, enabled, quality_rating)
VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'example-market-rss',
    'Example Market RSS Source',
    'rss',
    'https://example.invalid/markets/rss.xml',
    false,
    3
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'example-research-atom',
    'Example Research Atom Source',
    'atom',
    'https://example.invalid/research/atom.xml',
    false,
    4
  )
ON CONFLICT (source_key) DO NOTHING;
