CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  name text NOT NULL,
  source_type text NOT NULL CONSTRAINT sources_source_type_check CHECK (source_type IN ('rss', 'atom', 'programmatic', 'x-handle')),
  feed_url text,
  enabled boolean NOT NULL DEFAULT false,
  quality_rating integer NOT NULL DEFAULT 3 CHECK (quality_rating BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_type = 'programmatic' OR feed_url IS NOT NULL)
);

DO $$
DECLARE
  legacy_source_type_constraint text;
BEGIN
  SELECT table_constraint.constraint_name
  INTO legacy_source_type_constraint
  FROM information_schema.table_constraints table_constraint
  JOIN information_schema.check_constraints check_constraint
    ON check_constraint.constraint_schema = table_constraint.constraint_schema
    AND check_constraint.constraint_name = table_constraint.constraint_name
  WHERE table_constraint.constraint_schema = current_schema()
    AND table_constraint.table_name = 'sources'
    AND table_constraint.constraint_type = 'CHECK'
    AND table_constraint.constraint_name <> 'sources_source_type_check'
    AND check_constraint.check_clause LIKE '%source_type%'
    AND check_constraint.check_clause LIKE '%rss%'
    AND check_constraint.check_clause LIKE '%atom%'
    AND check_constraint.check_clause LIKE '%programmatic%'
  LIMIT 1;

  IF legacy_source_type_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sources DROP CONSTRAINT %I', legacy_source_type_constraint);
  END IF;
END $$;

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_source_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_source_type_check CHECK (source_type IN ('rss', 'atom', 'programmatic', 'x-handle'));

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
  ),
  (
    '77777777-7777-4777-8777-777777777777',
    'alpaca-news',
    'Alpaca News',
    'programmatic',
    NULL,
    true,
    4
  )
ON CONFLICT (source_key) DO NOTHING;
