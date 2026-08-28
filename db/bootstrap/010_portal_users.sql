-- Portal accounts, linked to Pocket ID.
--
-- There is no credential column here, and there never will be: the identity
-- provider is the only thing that authenticates a human, and this table only
-- records what that human may do once Pocket ID has vouched for them.
--
-- `subject` is the OIDC `sub` claim — stable for the life of the Pocket ID
-- account, unlike an email, which is why the link is made on it. Email and
-- display name are copies kept fresh at sign-in, for showing to an operator.
CREATE TABLE IF NOT EXISTS portal_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL UNIQUE,
  email text,
  display_name text,
  -- NULL until an admin grants one. Access needs BOTH a role and 'active'.
  role text CHECK (role IN ('admin', 'manager', 'viewer')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  granted_at timestamptz,
  granted_by uuid REFERENCES portal_users(id)
);

CREATE INDEX IF NOT EXISTS portal_users_status_idx ON portal_users (status);
