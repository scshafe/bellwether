# Agent Trading Platform

A paper-money agent trading platform (Trial #5 / P4.x-6d).
Quant playbook + qualitative judgment, a strategy/risk/execution agent team,
co-developed strategies, a family portal. Conception: see the Mission Control plan.

**Paper money only.** No real funds at the outset.

## P0 Component Decomposition

- `server`: HTTP API process with config-addressed endpoints and DB URL.
- `worker`: Postgres-coordinated agent worker process; no message broker.
- `db`: Postgres placement for coordination and persistence in the trial compose stack.
- `placement`: swappable seams for server endpoints, database URL, agent runtime placement, blob storage, and orchestration facade.

## Paced Cadence Defaults

- `PACED_CYCLE_INTERVAL_MS` controls the interval between paced trading cycles; default `300000` (5 minutes).
- `PACED_MARKET_HOURS_AWARE` controls whether paced cycles should honor the market-hours clock; default `true`.
