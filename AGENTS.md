# bellwether Agent Contract

Bellwether (package name `agent-trading-platform`) is a **paper-money-only**
agent trading platform: a TypeScript HTTP server with a React/Vite family
portal (`src/server.ts`, `client/`), a Postgres-coordinated worker that runs the
strategy/risk/execution agent team (`src/worker.ts`), and Postgres. Read
`README.md`, `AUTH.md` (Pocket ID is the only human credential),
`FLIP-DESIGN.md` (the disabled live-broker seam) and `ROADMAP.md` first.
scshafe-dev kind: `service` (`dev.toml`).

## Run and verify

- Node 22 (Dockerfile `node:22-alpine`; engines `>=22`), npm with
  `package-lock.json`. `.npmrc` sets `bin-links=false`, so scripts call
  `node ./node_modules/...` directly.
- `npm run build` (server `tsc` to `dist/`, client Vite to `client/dist/`);
  `npm start` (server), `npm run worker` (worker). Both need `DATABASE_URL`;
  `.env.example` lists the settings, `docker-compose.yml` is a local stack.
- Verify (`dev.toml [verify]`, run by `.github/workflows/ci.yml`):
  `npm ci && npm run typecheck && npm test`, with `NODE_ENV` unset
  (`scripts/conductor-gate.sh test` is the same check). Tests need no
  database; the live smokes skip unless their credential file is mounted
  (`/srv/bellwether/*.env|json`) and `live-cycle` skips without `DATABASE_URL`.

## Production

- Lane `runner`, layout `app`, host `laptop`, node `bellwether`, door
  `pocket-id` (`dev.toml [deploy]`). The stack is this repository's
  `deploy/stack/` (compose, serve.json, stack.toml); infra's
  `stacks/bellwether/host.conf` holds only the host's allowances. A merge to
  `main` runs `.github/workflows/deploy.yml`: verify (hosted), then the host
  entrypoint on the `bellwether-prod` runner builds the Dockerfile, backs up
  (the identity, `.env`, `state/secrets` and a `pg_dump`), restarts both
  `bellwether` and `bellwether-worker` onto the new pin, and rolls back if
  either is unready or `/healthz` fails through the door; then `health`.
- CI never deploys (SERVICE-02). Reached at `https://bellwether.<tailnet>`
  through oauth2-proxy; `/healthz` stays open.
- The database is Postgres 16 in `state/db` on the host (never recreate it; a
  major-version bump is a dump and restore). The schema self-migrates on boot
  (`ensure*Schema`), but a fresh, empty database also needs `db/bootstrap/`,
  which the stack no longer mounts into initdb: restore the nightly `pg_dump`
  instead, or apply `db/bootstrap/*.sql` in order with `psql` before the
  server starts.

## Rules

- PAPER money only: `src/broker.ts` uses the Alpaca paper API; never add a
  real-money path or set `BELLWETHER_FEATURE_BROKER_MODE_LIVE`. Never run the
  smokes or call a broker or LLM API with real credentials outside production.
- Secrets are files, never in git or output: on the laptop the stack's `.env`
  and `state/secrets/` (`alpaca-paper.env`, `openai-oauth.json`, mounted
  read-only at `/run/secrets/`). Never print or commit them.
- No login, password or role env in the app (`AUTH.md`); roles live in
  `portal_users`.

<!-- scshafe-dev:begin landing -->
## Verify and landing

Managed by scshafe-dev: `dev adopt` and `dev update` refresh this section from `dev.toml`; change `dev.toml`, not these lines.

Before finishing, both of these must pass:

```sh
npm ci && npm run typecheck && npm test
dev check .
```

How a change lands:

1. Work on a branch and open a PR.
2. Run the two commands above. If the repository is private, GitHub Actions does not run for it: verify locally and say in the PR what you ran. If it is public, wait for CI to be green.
3. Merge your own PR with a merge commit, one change at a time: `gh pr merge <N> --merge --subject "Merge #<N>: <title>"`. Never squash or rebase (both are off on the repository), and pass `--subject`: `gh pr merge` does not make the `Merge #N: <title>` subject by itself.

The project's agent may merge its own PR and push `main`; there is no approval gate.

Merging deploys to production ([deploy] lane `runner`: `.github/workflows/deploy.yml` verifies on a GitHub-hosted runner, deploys through the host entrypoint on the `bellwether-prod` self-hosted runner, then checks health).
Watch the run yourself with `gh run list -w deploy`, `gh run watch <id>` and `gh run view <id> --log` (a public repository's deploy log is a summary only); say in your reply what the run did, naming the merge commit.
Roll back by merging a `git revert`, or by dispatching `deploy.yml` with `sha=<older commit on main>` and `allow_rollback=true` (`gh workflow run deploy.yml -f sha=<sha> -f allow_rollback=true`).
<!-- scshafe-dev:end landing -->
