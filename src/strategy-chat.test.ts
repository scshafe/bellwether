import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Pool } from "pg";

import {
  ensureStrategyChatSchema,
  InMemoryStrategyChatStore,
  PostgresStrategyChatStore,
  type StrategyChatMessage
} from "./strategy-chat.js";

describe("strategy chat store", () => {
  it("keeps in-memory messages chronological for a strategy", async () => {
    const store = new InMemoryStrategyChatStore();

    await store.appendMessage({
      strategyId: "11111111-1111-4111-8111-111111111111",
      role: "user",
      content: "First",
      createdAt: "2026-06-17T12:00:00.000Z"
    });
    await store.appendMessage({
      strategyId: "22222222-2222-4222-8222-222222222222",
      role: "user",
      content: "Other strategy",
      createdAt: "2026-06-17T12:01:00.000Z"
    });
    await store.appendMessage({
      strategyId: "11111111-1111-4111-8111-111111111111",
      role: "analyst",
      content: "Second",
      createdAt: "2026-06-17T12:02:00.000Z",
      metadata: { mode: "formalize", proposedParameterDelta: { maxOpenPositions: 2 } }
    });

    const thread = await store.listMessages("11111111-1111-4111-8111-111111111111");

    assert.deepEqual(thread.map((message) => message.content), ["First", "Second"]);
    assert.deepEqual(thread[1]?.metadata?.proposedParameterDelta, { maxOpenPositions: 2 });
  });

  it("uses bootstrap SQL and maps Postgres chat message rows", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const rows: StrategyChatMessageRow[] = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("INSERT INTO strategy_chat_messages")) {
          const row: StrategyChatMessageRow = {
            id: String(values?.[0]),
            strategy_id: String(values?.[1]),
            role: values?.[2] as StrategyChatMessage["role"],
            content: String(values?.[3]),
            metadata: JSON.parse(String(values?.[4])) as StrategyChatMessage["metadata"],
            created_at: String(values?.[5])
          };
          rows.push(row);
          return { rows: [row] };
        }

        if (text.includes("FROM strategy_chat_messages")) {
          return { rows: rows.filter((row) => row.strategy_id === values?.[0]) };
        }

        return { rows: [] };
      }
    } as Pool;

    await ensureStrategyChatSchema(pool);

    const store = new PostgresStrategyChatStore(pool);
    const analyst = await store.appendMessage({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      strategyId: "33333333-3333-4333-8333-333333333333",
      role: "analyst",
      content: "Advisory only.",
      createdAt: "2026-06-17T12:03:00.000Z",
      metadata: { mode: "brainstorm", candidateIdeas: [{ name: "Idea", mandate: "Discuss", suggestedParameters: {} }] }
    });
    const thread = await store.listMessages("33333333-3333-4333-8333-333333333333");

    assert.ok(queries[0]?.text.includes("CREATE TABLE IF NOT EXISTS strategy_chat_messages"));
    assert.equal(analyst.role, "analyst");
    assert.equal(thread.length, 1);
    assert.equal(thread[0]?.metadata?.mode, "brainstorm");
    assert.equal(thread[0]?.metadata?.candidateIdeas?.[0]?.name, "Idea");
  });
});

type StrategyChatMessageRow = {
  id: string;
  strategy_id: string;
  role: StrategyChatMessage["role"];
  content: string;
  metadata: StrategyChatMessage["metadata"];
  created_at: string;
};
