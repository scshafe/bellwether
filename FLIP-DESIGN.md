# Broker Flip Design (Disabled Scaffolding Only)

## Scope Banner
This is DESIGN and disabled scaffolding only. Bellwether still runs on paper money only. This phase does not add a real Alpaca live endpoint, a real-money order path, live credential provisioning, reconciliation, legal/compliance sign-off, or a server endpoint that can flip a running deployment.

## Why Add The Seam Now
The execution surface should stay stable if a future approved build ever introduces a real-money path. The agent team calls only the `BrokerAdapter` interface, so the broker-mode decision must live outside agent code at one composition chokepoint.

## BrokerMode And Flip State
`BrokerMode` is `'paper' | 'live'`. `paperFlipState()` returns `{ mode: 'paper' }` and is the safe default used by current composition roots.

`BrokerFlipState` is separate from `AlpacaPaperAdapterOptions`, order guard rails, and strategy gates. Its live fields are the refusal-critical quartet: initiating operator, second operator, verification id, and timestamp. Operator roles are also stored and validated against the existing `adminBoundaryRoles` (`admin`, `manager`).

## Selector Chokepoint
`createBrokerAdapter(credentialVault, paperAccountId, flipState, options?)` is the only production paper/live selector. It returns `BrokerAdapter`, not a concrete adapter.

Current roots routed through it:
- `src/index.ts`: server composition creates the portal broker through `createBrokerAdapter(..., paperFlipState())`.
- `src/live-cycle.ts`: default live-cycle broker construction goes through `createBrokerAdapter(..., paperFlipState())`.
- `src/worker.ts`: the worker reaches broker construction through `runLiveTradeCycle`; its test-injection override remains first-class and bypasses the selector entirely for tests.

The selector returns `AlpacaPaperAdapter` for paper/default. For `mode: 'live'`, it refuses at instantiation unless all gates are present: `BELLWETHER_FEATURE_BROKER_MODE_LIVE=1|true`, distinct initiating and second operators, both operator roles are `admin` or `manager`, a verification id, a timestamp, a live credential vault, and a mounted live credential.

## AlpacaLiveAdapter Stub
`AlpacaLiveAdapter` has the same constructor shape as the paper adapter for swappability, plus a private flip guard. Construction throws unless the selector affirmed the guard. Every broker method throws `not implemented — real-money path is DESIGN-only`.

No real live base URL is wired. The only live-url artifact is an unreachable TODO constant inside `src/broker.ts` to mark the future seam.

## Two-Operator Sign-Off
No new role exists. The design reuses `adminBoundaryRoles`:
- Operator 1 (`admin` or `manager`) initiates and records `confirmedBy`, `confirmedByRole`, `flipVerificationId`, and reason.
- Operator 2 (`admin` or `manager`, a distinct user id) confirms and records `secondOperatorSignoff` plus `secondOperatorRole`.
- The app validation rejects viewer roles, missing verification, missing reason, and identical operators.
- Only after validation would the future implementation append an audit row and persist `mode: 'live'`.

Example future contract, not implemented as a route in this phase:

```http
POST /admin/broker-flip/requests
{ "toMode": "live", "flipVerificationId": "legal-ticket-123", "reason": "Operator-approved future flip request" }

POST /admin/broker-flip/requests/{id}/confirm
{ "reason": "Second operator confirms the verified request" }
```

## Append-Only Audit Log
Migration `db/bootstrap/009_broker_flip_log.sql` creates `broker_flip_log` with:
- `from_mode`, `to_mode` with mode checks.
- initiating and second operator ids.
- initiating and second operator roles checked to `admin` or `manager`.
- `flip_verification_id`, `reason`, and `created_at timestamptz DEFAULT now()`.
- a distinct-operator check and `(created_at DESC, id DESC)` index.

`ensureBrokerFlipLogSchema(pool)` is called in both `src/index.ts` and `src/worker.ts`. `PostgresBrokerFlipLogStore.appendFlipChange()` only inserts. The convention is immutable: Bellwether code does not issue `UPDATE` or `DELETE` against this table.

## Credential Separation
Paper credentials remain under `ALPACA_PAPER_CREDENTIAL_FILE` and the paper broker account id.

The future live seam uses a distinct `ALPACA_LIVE_CREDENTIAL_FILE` and `ALPACA_LIVE_BROKER_ACCOUNT_ID`. `createAlpacaLiveSecretsStore()` loads gracefully: a missing file returns an empty store. Current paper deployments do not mount a live file, so the live vault yields null and the selector refuses before any live adapter exists.

## Feature Flag
The live branch is default-off behind `isFeatureEnabled('broker-mode-live')`, which maps to `BELLWETHER_FEATURE_BROKER_MODE_LIVE`. Missing, empty, `0`, and `false` are off. The future live path requires all gates at once: flag, audited two-operator state, verification id and timestamp, plus live credentials.

## Safety Invariants
- Paper is the default and only reachable state in current deployments.
- No live key is mounted or required for paper operation.
- Live refusal happens at broker instantiation, not order time.
- Paper order validation remains in `AlpacaPaperAdapter.placeOrder()`.
- The live adapter is a refusing stub and has no real endpoint.
- The worker path routes through the same selector via `runLiveTradeCycle`.
- Test overrides still inject a `BrokerAdapter` directly, so offline tests do not need credentials.

## Agents Never Learn The Mode
Agents receive only `BrokerAdapter` behavior and broker snapshots. `BrokerMode` is confined to `src/broker-flip.ts` and composition roots. The following LLM-facing surfaces must not include broker mode words, endpoint class, credential namespace, or account id:
- strategy analyst system prompt and user prompt.
- risk agent system prompt and user prompt.
- execution agent system prompt and user prompt.
- qualitative brief prompt.
- strategy chat prompt.
- strategy proposal prompt.
- decision log fields derived from agent prompts.
- strategy labels and cycle ids generated for agent cycles.

## Intentionally Not Built
This phase intentionally does not build a real endpoint/client, real-money order path, live Alpaca URL, live key provisioning, reconciliation, compliance/legal workflow, kill switch, or running server flip endpoint.

## Future Build Sequence
Before any future live key exists, the project would need operator approval gates, legal/compliance sign-off, a reviewed API contract, reconciliation, kill switch, operational runbook, dry-run evidence, and an explicit Mission Control phase that replaces the stub with a real adapter. Until then, live mode remains design-only and refusing.
