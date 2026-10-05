# bellwether Agent Contract

> Deploys are paused (2026-10-05): mc-autodeploy retired; a merge to main does not deploy.
> This project moves to the runner lane (infra docs/platform/agent-deploy.md phase 6);
> until then a deploy is an owner step.

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

- Lane `autodeploy`, stack `bellwether`, host `lubuntu` (`dev.toml [deploy]`;
  infra `stacks/bellwether/`). **Merging to `main` deploys**: mc-autodeploy
  fast-forwards Lubuntu's `~/src/bellwether`, and `tools/stack deploy
  bellwether` builds the Dockerfile, pins the image, restarts both
  `bellwether` and `bellwether-worker`, and rolls back if `/healthz` fails.
- CI never deploys (SERVICE-02). Reached at
  `https://bellwether.<tailnet>` through oauth2-proxy; `/healthz` stays open.
- The schema self-migrates on boot (`ensure*Schema`), but a fresh database
  also needs `db/bootstrap/` (the stack mounts it into initdb).

## Rules

- PAPER money only: `src/broker.ts` uses the Alpaca paper API; never add a
  real-money path or set `BELLWETHER_FEATURE_BROKER_MODE_LIVE`. Never run the
  smokes or call a broker or LLM API with real credentials outside production.
- Secrets are files, never in git or output: on Lubuntu the stack's `.env`
  and `${BELLWETHER_AGENT_RESOURCES}` (`alpaca-paper.env`,
  `openai-oauth.json`, mounted at `/run/secrets/`). Never print or commit them.
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

Merging deploys to production ([deploy] lane `autodeploy`: Lubuntu's mc-autodeploy redeploys `main`).
The agent cannot observe the deploy from its sandbox (no tailnet access). After merging, say so in your reply and name the merge commit, so the owner session watches the deploy.
<!-- scshafe-dev:end landing -->
