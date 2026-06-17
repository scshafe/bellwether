import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool } from "pg";

import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type PriceVolumeBar } from "./quant-playbook.js";
import {
  assertValidTransition,
  buildStrategyQuantPlaybook,
  ensureStrategiesSchema,
  getStrategyTradingGateViolation,
  InMemoryStrategyStore,
  PostgresStrategyStore,
  STRATEGY_STATUSES,
  StrategyLifecycleError,
  type StrategyRow,
  type StrategyStatus
} from "./strategy.js";

function bars(symbol: string, closes: number[], volume: number): PriceVolumeBar[] {
  return closes.map((close, index) => ({
    symbol,
    timestamp: `2026-06-${String(index + 1).padStart(2, "0")}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume
  }));
}

describe("Strategy entity", () => {
  it("defines the six-state strategy lifecycle", () => {
    assert.deepEqual(STRATEGY_STATUSES, ["draft", "under_discussion", "approved", "active", "paused", "retired"]);

    for (const [from, to] of [
      ["draft", "under_discussion"],
      ["draft", "approved"],
      ["under_discussion", "approved"],
      ["under_discussion", "draft"],
      ["approved", "active"],
      ["active", "paused"],
      ["active", "retired"],
      ["paused", "active"],
      ["paused", "retired"]
    ] as Array<[StrategyStatus, StrategyStatus]>) {
      assert.doesNotThrow(() => assertValidTransition(from, to));
    }

    assert.throws(() => assertValidTransition("draft", "active"), StrategyLifecycleError);
    assert.throws(() => assertValidTransition("approved", "paused"), StrategyLifecycleError);
    assert.throws(() => assertValidTransition("retired", "active"), StrategyLifecycleError);
  });

  it("persists strategy parameters and uses them to build the quant playbook", async () => {
    const store = new InMemoryStrategyStore();
    const strategy = await store.createStrategy({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Single slot momentum",
      parameters: {
        ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
        maxOpenPositions: 1,
        minMomentumFraction: 0.05
      }
    });

    const persisted = await store.getStrategy(strategy.id);
    assert.equal(persisted?.parameters.maxOpenPositions, 1);
    assert.equal(persisted?.parameters.minMomentumFraction, 0.05);

    const playbook = buildStrategyQuantPlaybook(strategy, {
      asOf: "2026-06-17T14:30:00Z",
      universe: [{ symbol: "AAPL", sector: "technology" }],
      bars: bars("AAPL", [100, 102, 104, 106, 108, 110], 20_000),
      portfolio: {
        equity: 20_000,
        cash: 5_000,
        dailyPnl: 100,
        positions: [{ symbol: "MSFT", qty: 1, marketValue: 200, sector: "technology" }]
      }
    });

    assert.equal(playbook.parameters.maxOpenPositions, 1);
    assert.equal(playbook.candidates.length, 0);
    assert.equal(playbook.rails.symbols.AAPL?.maxBuyQty, 0);
  });

  it("requires Draft to be Approved before Active", async () => {
    const store = new InMemoryStrategyStore();
    const strategy = await store.createStrategy({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Approval gated strategy",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });

    await assert.rejects(() => store.activateStrategy(strategy.id), StrategyLifecycleError);
    assert.equal(
      await getStrategyTradingGateViolation(store, strategy.id),
      "strategy 22222222-2222-2222-2222-222222222222 is draft; only active strategies can trade"
    );

    const approved = await store.approveStrategy(strategy.id);
    assert.equal(approved.status, "approved");
    assert.equal(
      await getStrategyTradingGateViolation(store, strategy.id),
      "strategy 22222222-2222-2222-2222-222222222222 is approved; only active strategies can trade"
    );

    const active = await store.activateStrategy(strategy.id);
    assert.equal(active.status, "active");
    assert.equal(await getStrategyTradingGateViolation(store, strategy.id), null);
  });

  it("supports each lifecycle store action and keeps retired terminal", async () => {
    const store = new InMemoryStrategyStore();

    const discussed = await store.createStrategy({
      id: "33333333-3333-3333-3333-333333333333",
      name: "Discussed strategy",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    assert.equal((await store.startDiscussion(discussed.id)).status, "under_discussion");
    assert.equal((await store.returnToDraft(discussed.id)).status, "draft");

    const approvedFromDiscussion = await store.createStrategy({
      id: "44444444-4444-4444-4444-444444444444",
      name: "Discussion to approval",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    await store.startDiscussion(approvedFromDiscussion.id);
    assert.equal((await store.approveStrategy(approvedFromDiscussion.id)).status, "approved");

    const activeCycle = await store.createStrategy({
      id: "55555555-5555-5555-5555-555555555555",
      name: "Pause and resume",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    await store.approveStrategy(activeCycle.id);
    assert.equal((await store.activateStrategy(activeCycle.id)).status, "active");
    assert.equal((await store.pauseStrategy(activeCycle.id, "risk review")).status, "paused");
    assert.equal((await store.resumeStrategy(activeCycle.id)).status, "active");
    assert.equal((await store.retireStrategy(activeCycle.id, "sunset")).status, "retired");
    await assert.rejects(() => store.resumeStrategy(activeCycle.id), StrategyLifecycleError);

    const retiredFromActive = await store.createStrategy({
      id: "66666666-6666-6666-6666-666666666666",
      name: "Active to retired",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    await store.approveStrategy(retiredFromActive.id);
    await store.activateStrategy(retiredFromActive.id);
    assert.equal((await store.retireStrategy(retiredFromActive.id)).status, "retired");
  });

  it("keeps per-state timestamps immutable across re-entry and records reasons", async () => {
    const store = new InMemoryStrategyStore();
    const strategy = await store.createStrategy({
      id: "77777777-7777-7777-7777-777777777777",
      name: "Timestamp strategy",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });

    const underDiscussion = await store.startDiscussion(strategy.id);
    assert.ok(underDiscussion.discussionStartedAt);
    const approved = await store.approveStrategy(strategy.id);
    const active = await store.activateStrategy(strategy.id);
    const firstPaused = await store.pauseStrategy(strategy.id, "first pause");
    await store.resumeStrategy(strategy.id);
    const secondPaused = await store.pauseStrategy(strategy.id, "second pause");

    assert.equal(secondPaused.discussionStartedAt, underDiscussion.discussionStartedAt);
    assert.equal(secondPaused.approvedAt, approved.approvedAt);
    assert.equal(secondPaused.activatedAt, active.activatedAt);
    assert.equal(secondPaused.pausedAt, firstPaused.pausedAt);
    assert.equal(secondPaused.reason, "second pause");

    const retired = await store.retireStrategy(strategy.id, "retired after review");
    assert.equal(retired.pausedAt, firstPaused.pausedAt);
    assert.equal(retired.reason, "retired after review");
    assert.ok(retired.retiredAt);
  });

  it("lists strategies newest-first with a clamped limit and updates only mutable strategies", async () => {
    const store = new InMemoryStrategyStore([
      strategyRecord({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Old", createdAt: "2026-06-17T10:00:00.000Z" }),
      strategyRecord({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Middle", createdAt: "2026-06-17T11:00:00.000Z" }),
      strategyRecord({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "New", createdAt: "2026-06-17T12:00:00.000Z" })
    ]);

    assert.deepEqual((await store.listStrategies(2)).map((strategy) => strategy.name), ["New", "Middle"]);
    assert.deepEqual((await store.listStrategies(0)).map((strategy) => strategy.name), ["New"]);

    const updated = await store.updateStrategy("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
      name: "Updated middle",
      description: "revised",
      parameters: { ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS, maxOpenPositions: 2 }
    });
    assert.equal(updated.name, "Updated middle");
    assert.equal(updated.description, "revised");
    assert.equal(updated.parameters.maxOpenPositions, 2);

    await store.approveStrategy(updated.id);
    await assert.rejects(() => store.updateStrategy(updated.id, { name: "Too late" }), StrategyLifecycleError);
  });

  it("keeps the trading gate unchanged for paused and retired strategies", async () => {
    const store = new InMemoryStrategyStore();
    const paused = await store.createStrategy({
      id: "88888888-8888-8888-8888-888888888888",
      name: "Paused strategy",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    await store.approveStrategy(paused.id);
    await store.activateStrategy(paused.id);
    await store.pauseStrategy(paused.id, "halt");
    assert.equal(
      await getStrategyTradingGateViolation(store, paused.id),
      "strategy 88888888-8888-8888-8888-888888888888 is paused; only active strategies can trade"
    );

    const retired = await store.createStrategy({
      id: "99999999-9999-9999-9999-999999999999",
      name: "Retired strategy",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    await store.approveStrategy(retired.id);
    await store.activateStrategy(retired.id);
    await store.retireStrategy(retired.id, "sunset");
    assert.equal(
      await getStrategyTradingGateViolation(store, retired.id),
      "strategy 99999999-9999-9999-9999-999999999999 is retired; only active strategies can trade"
    );
  });

  it("uses idempotent bootstrap SQL and atomic lifecycle guards in Postgres", async () => {
    const rows = new Map<string, StrategyRow>();
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("CREATE TABLE IF NOT EXISTS strategies")) {
          return { rows: [] };
        }

        if (text.includes("INSERT INTO strategies")) {
          const id = String(values?.[0] ?? "10101010-1010-4010-8010-101010101010");
          const row = strategyRow({
            id,
            name: String(values?.[1]),
            description: values?.[2] === null ? null : String(values?.[2]),
            parameters: JSON.parse(String(values?.[3])) as typeof DEFAULT_QUANT_PLAYBOOK_PARAMETERS
          });
          rows.set(id, row);
          return { rows: [row] };
        }

        if (text.includes("ORDER BY created_at DESC")) {
          return { rows: [...rows.values()].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))) };
        }

        if (text.includes("UPDATE strategies") && text.includes("SET name = $2")) {
          const id = String(values?.[0]);
          const row = rows.get(id);
          const allowedStatuses = values?.[4] as StrategyStatus[];

          if (!row || !allowedStatuses.includes(row.status)) {
            return { rows: [] };
          }

          row.name = String(values?.[1]);
          row.description = values?.[2] === null ? null : String(values?.[2]);
          row.parameters = JSON.parse(String(values?.[3])) as typeof DEFAULT_QUANT_PLAYBOOK_PARAMETERS;
          row.updated_at = nextTimestamp();
          return { rows: [row] };
        }

        if (text.includes("UPDATE strategies") && text.includes("SET status = $2")) {
          const id = String(values?.[0]);
          const nextStatus = values?.[1] as StrategyStatus;
          const allowedStatuses = values?.[2] as StrategyStatus[];
          const row = rows.get(id);

          if (!row || !allowedStatuses.includes(row.status)) {
            return { rows: [] };
          }

          row.status = nextStatus;
          row.updated_at = nextTimestamp();

          if (nextStatus === "under_discussion") {
            row.discussion_started_at ??= row.updated_at;
          }

          if (nextStatus === "approved") {
            row.approved_at ??= row.updated_at;
          }

          if (nextStatus === "active") {
            row.activated_at ??= row.updated_at;
          }

          if (nextStatus === "paused") {
            row.paused_at ??= row.updated_at;
            row.reason = (values?.[3] as string | null) ?? null;
          }

          if (nextStatus === "retired") {
            row.retired_at ??= row.updated_at;
            row.reason = (values?.[3] as string | null) ?? null;
          }

          return { rows: [row] };
        }

        if (text.includes("FROM strategies") && text.includes("WHERE id = $1")) {
          const row = rows.get(String(values?.[0]));
          return { rows: row ? [row] : [] };
        }

        return { rows: [] };
      }
    } as unknown as Pool;
    const store = new PostgresStrategyStore(pool);

    await ensureStrategiesSchema(pool);
    const created = await store.createStrategy({
      id: "10101010-1010-4010-8010-101010101010",
      name: "Postgres lifecycle",
      parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS
    });
    const updated = await store.updateStrategy(created.id, { name: "Updated postgres lifecycle", description: null });
    await store.startDiscussion(created.id);
    await store.returnToDraft(created.id);
    await store.approveStrategy(created.id);
    await store.activateStrategy(created.id);
    const paused = await store.pauseStrategy(created.id, "pg pause");
    await store.resumeStrategy(created.id);
    const retired = await store.retireStrategy(created.id, "pg retire");
    const listed = await store.listStrategies(500);

    assert.match(queries[0]?.text ?? "", /CONSTRAINT strategies_status_check CHECK/u);
    assert.match(queries[0]?.text ?? "", /ALTER TABLE strategies ADD COLUMN IF NOT EXISTS discussion_started_at timestamptz/u);
    assert.match(queries[0]?.text ?? "", /ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_status_check/u);
    assert.match(queries[0]?.text ?? "", /DO \$\$/u);
    assert.match(queries[0]?.text ?? "", /strategies_paused_requires_activation/u);
    assert.match(queries[0]?.text ?? "", /strategies_retired_requires_activation/u);
    assert.equal(updated.name, "Updated postgres lifecycle");
    assert.equal(paused.reason, "pg pause");
    assert.equal(retired.reason, "pg retire");
    assert.equal(listed.length, 1);
    assert.deepEqual(
      queries
        .filter((query) => query.text.includes("SET status = $2"))
        .map((query) => query.values?.[2]),
      [["draft"], ["under_discussion"], ["draft", "under_discussion"], ["approved", "paused"], ["active"], ["paused"], ["active", "paused"]]
    );
    assert.match(queries.find((query) => query.text.includes("SET status = $2"))?.text ?? "", /COALESCE\(discussion_started_at, now\(\)\)/u);
    assert.match(queries.find((query) => query.text.includes("SET status = $2"))?.text ?? "", /status = ANY\(\$3::text\[\]\)/u);
  });
});

function strategyRecord(overrides: Partial<ReturnType<typeof baseStrategyRecord>>): ReturnType<typeof baseStrategyRecord> {
  return { ...baseStrategyRecord(), ...overrides };
}

function baseStrategyRecord() {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    name: "Strategy",
    status: "draft" as const,
    parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z"
  };
}

let timestampIndex = 0;

function nextTimestamp(): string {
  timestampIndex += 1;
  return `2026-06-17T00:00:${String(timestampIndex).padStart(2, "0")}.000Z`;
}

function strategyRow(overrides: Partial<StrategyRow> = {}): StrategyRow {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    name: "Strategy",
    description: null,
    status: "draft",
    parameters: DEFAULT_QUANT_PLAYBOOK_PARAMETERS,
    created_at: nextTimestamp(),
    updated_at: nextTimestamp(),
    approved_at: null,
    activated_at: null,
    discussion_started_at: null,
    paused_at: null,
    retired_at: null,
    reason: null,
    ...overrides
  };
}
