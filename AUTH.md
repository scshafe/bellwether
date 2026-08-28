# Identity: Pocket ID is the only human credential

Status: adopted, 2026-08-27. Supersedes the in-app credential system and the
trusted-header identity mode added the same month.

## Decision

Bellwether has **no login of its own**. A human authenticates at Pocket ID; the
portal learns who they are from an id token that Pocket ID signed. The password
mechanism is **deleted, not disabled** — there is no flag that brings it back,
and no code path that could check a password if one were supplied.

What was removed, in full:

- `InMemoryIdentityProvider`, `createIdentityProvider`, the seeded
  admin/manager/viewer users, and the `change-me` default password.
- `POST /auth/session` and `handleSessionCreate`. The path now 404s exactly as
  any never-registered path does, identically whether or not the credentials it
  names would once have matched an account.
- Password-minted session tokens (`in-memory-session:*`) and the Bearer session
  lookup that resolved them.
- The SPA login card and every client path that posted credentials.
- `PORTAL_ADMIN_*`, `PORTAL_MANAGER_*`, `PORTAL_VIEWER_*`,
  `PORTAL_TRUSTED_PROXY_AUTH`, `PORTAL_TRUSTED_PROXY_IDENTITY`,
  `PORTAL_TRUSTED_PROXY_HEADER`, and the two rosters that briefly replaced
  them (`PORTAL_ROLE_ADMINS`/`_MANAGERS`/`_VIEWERS` by email, then
  `..._GROUP` by Pocket ID group). Setting any of these now **refuses the
  boot** rather than being quietly ignored: their presence means someone still
  believes a password, a header, or a config file decides who gets in.
- The two-mode branch around the proxy flag. With one identity source there is
  no second mode to switch between.

## Why a signature, not a header

The retired mode read `X-Forwarded-Email` and trusted it because the proxy was
believed to be the only route to the listener. That holds exactly as long as the
network topology does. Anything that reaches the app's port directly — a
misrouted `tailscale serve`, a container on the same network, a future port
publish — could set that header and be admitted as the shared admin.

So identity now travels as the id token itself. oauth2-proxy forwards it
(`--pass-authorization-header`), and the server verifies:

- the **signature**, against a key fetched from Pocket ID's JWKS (discovered
  from the issuer, cached, refreshed on rotation);
- `iss` is the configured issuer, exactly;
- `aud` (and `azp`, when present) name this portal's OIDC client;
- `exp`/`nbf`/`iat`, with 60s of clock tolerance;
- the algorithm is asymmetric — `none` and the HMAC family are not in the
  table at all, so alg-substitution has nothing to substitute into.

A forged header now buys nothing, because no header is believed. This was not
theoretical: on 2026-08-27, from an ordinary tailnet peer,
`GET http://<node>:3000/admin/roles -H 'x-forwarded-email: anything@nowhere'`
returned `200` with `role: admin` on the running build. Userspace-mode
tailscaled forwards inbound tailnet connections to localhost, so `HOST` bound
to `127.0.0.1` inside the sidecar netns exposed the app port — and 5432 — to
every device on the tailnet.

## Landing on the app port

Reaching the app port directly now yields `401` on every data route. A browser
that lands there is answered with `302` to `PUBLIC_BASE_URL`, the address the
door answers on — a shell served from the raw port could never sign in, so
offering one is a dead end dressed as a page.

The redirect is deliberately narrow. Data routes answer 401 before it, so no
XHR gets a surprise 302; `/healthz` answers before that, so the deploy probe
and the container healthcheck are untouched; and a request carrying a token is
left alone, which is what makes a loop impossible even if the proxy stops
preserving `Host`.

## Authentication vs authorization

Pocket ID says **who you are**. Bellwether says **what you may do**, and keeps
that in its own table:

```sql
portal_users (
  id, subject, email, display_name,
  role,    -- admin | manager | viewer, NULL until granted
  status,  -- pending | active | disabled
  first_seen_at, last_seen_at, granted_at, granted_by
)
```

**There is no credential column, and there never will be.** A row here admits
nobody on its own — without a signed Pocket ID token it is inert. The table
records what a person may do *after* the identity provider has vouched for
them.

**`subject`, not email, is the link.** It is the OIDC `sub` claim, stable for
the life of the Pocket ID account. Email and display name are copies kept
fresh at sign-in so an operator can recognise a row; changing your email in
Pocket ID moves the copy, not the account.

Access requires **both** a role and `active`. A role alone is not access, and
neither is being active — the pair is.

### Enrolment: knocking is how you get on the list

A verified identity with no account gets one, `pending`, on its first request.
That is the whole enrolment story:

1. The person signs in through the door. They get `403 not_provisioned`.
2. They now appear on the portal's **Access** screen — with their email and
   display name, because their token carried them.
3. An admin clicks a role. Their next request works.

Nobody types an email into a config file and nobody transcribes an opaque
subject. Granting takes effect on the very next request; revoking (clearing
the role, or setting `disabled`) does too. Neither needs a redeploy, which is
why an env-var roster was rejected: it put a fact the portal could hold in a
file on the runtime host, behind a restart.

Granting is **admin-only** — the one surface a manager does not reach.
Operating the runtime is reversible; handing someone a role is how the
boundary moves.

### The first account

On an **empty** portal, the first verified arrival becomes `admin`. That is
the bootstrap, and it happens exactly once — the second arrival is `pending`
like everyone else. Who can trigger it is bounded by the door: only a Pocket
ID user whom the OIDC client's allowed-groups admit ever reaches the app.
Concurrent first sign-ins are serialised by an advisory lock, so the race
cannot mint two admins.

The store refuses to remove the last active admin — by role change, by
revocation, or by disabling. That lockout has no recovery inside the app; the
only way back would be hand-editing the table.

## Server configuration

| Env var | Meaning |
| --- | --- |
| `PORTAL_OIDC_ISSUER` | Pocket ID base URL; required, https (`https://id.colobus-stargazer.ts.net`) |
| `PORTAL_OIDC_AUDIENCE` | the OIDC client id tokens must be minted for; required — the same client id the door uses |
| `PORTAL_OIDC_JWKS_URL` | optional; pins the key set and skips discovery |
| `PORTAL_OIDC_TOKEN_HEADER` | optional; default `authorization` (Bearer) |

## Proxy configuration

The door is `oauth2-proxy` in infra's `stacks/bellwether` — same netns as the
app, reached through the tailnet sidecar's `serve` at
`https://bellwether.colobus-stargazer.ts.net`. It must **forward the token**,
or the app answers 401 to everything, since it has no other way to learn who
you are:

```
OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER=true            # the id token, upstream
OAUTH2_PROXY_PASS_USER_HEADERS=false                   # nothing reads them now
OAUTH2_PROXY_SCOPE="openid email profile offline_access"
OAUTH2_PROXY_COOKIE_REFRESH=30m                        # < the id token lifetime
```

The proxy session must not outlive the id token it forwards. Bellwether's
cookie lasts 12h, so `offline_access` + a 30m refresh is what keeps the
forwarded token fresh; without it the app starts answering 401 mid-session
while the proxy still considers the user signed in, and the SPA shows a
signed-out shell that no amount of reloading fixes.

`OAUTH2_PROXY_SKIP_AUTH_ROUTES: "GET=^/healthz$"` stays: `/healthz` is
tenant-less liveness with no data behind it, and the deploy probe reads it.

`deploy/docker/` in this repo is a superseded reference with no door of its
own; do not deploy from it.

Sign-out is RP-initiated: the SPA sends the browser to `/oauth2/sign_out` with
a redirect to Pocket ID's `end-session` endpoint, so the IdP session ends too.
A plain proxy sign-out would clear only the cookie, and the live IdP session
would sign the user straight back in.

## Failure modes, on purpose

| Situation | Answer |
| --- | --- |
| No token | `401 missing_session` |
| Token not signed by the issuer, expired, or for another client | `401 invalid_session` |
| Verified identity with no granted account | `403 not_provisioned` (enrolled as pending) |
| Verified portal user, insufficient role | `403 forbidden` |
| Pocket ID's JWKS unreachable | `503 identity_unavailable` |
| No identity source configured | `503 identity_unavailable` |

A JWKS outage is deliberately **not** a 401: an identity provider being down is
not a failed login, and the distinction matters when reading logs at 3am. The
key store keeps serving its last good key set through a failed refresh, so an
outage does not evict signed-in users.

## Proving the absence

Every deleted surface has a test that constructs the *old* usage and asserts it
is gone — `src/server.test.ts` ("the deleted in-app credential system"),
`src/portal-identity.test.ts`, `src/identity.test.ts`, and
`src/portal-client-absence.test.ts`, which reads the client source *and the
built bundle* so a login form cannot return through a component the API tests
never see. `src/portal-users.test.ts` asserts the account table's own absence:
no credential field on a record, no credential column in the schema, and a
patch carrying one is refused.
