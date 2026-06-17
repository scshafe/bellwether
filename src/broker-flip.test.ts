import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALPACA_PAPER_BROKER_ACCOUNT_ID, AlpacaLiveAdapter, AlpacaPaperAdapter } from "./broker.js";
import {
  BrokerFlipRefusedError,
  createBrokerAdapter,
  ensureBrokerFlipLogSchema,
  paperFlipState,
  PostgresBrokerFlipLogStore,
  validateBrokerFlipLogInput,
  type BrokerFlipState
} from "./broker-flip.js";
import { ALPACA_LIVE_BROKER_ACCOUNT_ID, InMemorySecretsStore, SecretsBackedBrokerCredentialVault } from "./secrets.js";

function paperVault(): SecretsBackedBrokerCredentialVault {
  return new SecretsBackedBrokerCredentialVault(
    new InMemorySecretsStore({
      "broker-credentials/alpaca-paper/key-id": "paper-key",
      "broker-credentials/alpaca-paper/secret-key": "paper-secret"
    })
  );
}

function liveVault(): SecretsBackedBrokerCredentialVault {
  return new SecretsBackedBrokerCredentialVault(
    new InMemorySecretsStore({
      [`broker-credentials/${ALPACA_LIVE_BROKER_ACCOUNT_ID}/key-id`]: "live-key",
      [`broker-credentials/${ALPACA_LIVE_BROKER_ACCOUNT_ID}/secret-key`]: "live-secret"
    })
  );
}

function completeLiveState(overrides: Partial<BrokerFlipState> = {}): BrokerFlipState {
  return {
    mode: "live",
    confirmedBy: "operator-admin",
    confirmedByRole: "admin",
    secondOperatorSignoff: "operator-manager",
    secondOperatorRole: "manager",
    flipVerificationId: "flip-verification-1",
    flipTimestamp: "2026-06-17T20:00:00.000Z",
    ...overrides
  };
}

describe("broker flip selector", () => {
  it("returns the paper adapter by default", async () => {
    const adapter = await createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, paperFlipState(), {
      fetchFn: async () => new Response("{}")
    });

    assert.equal(adapter instanceof AlpacaPaperAdapter, true);
  });

  it("refuses live mode at instantiation when the feature flag is disabled", async () => {
    await assert.rejects(
      () => createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState(), {
        env: {},
        liveCredentialVault: liveVault()
      }),
      (error: unknown) => error instanceof BrokerFlipRefusedError && /feature flag is disabled/u.test(error.message)
    );
  });

  it("refuses live mode when either operator sign-off is incomplete", async () => {
    await assert.rejects(
      () => createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState({ secondOperatorSignoff: undefined }), {
        env: { BELLWETHER_FEATURE_BROKER_MODE_LIVE: "1" },
        liveCredentialVault: liveVault()
      }),
      /second operator sign-off is missing/u
    );
  });

  it("refuses live mode when both approvals come from the same operator", async () => {
    await assert.rejects(
      () => createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState({ secondOperatorSignoff: "operator-admin" }), {
        env: { BELLWETHER_FEATURE_BROKER_MODE_LIVE: "true" },
        liveCredentialVault: liveVault()
      }),
      /distinct operators are required/u
    );
  });

  it("refuses live mode when the verification id or timestamp is missing", async () => {
    await assert.rejects(
      () => createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState({ flipVerificationId: undefined }), {
        env: { BELLWETHER_FEATURE_BROKER_MODE_LIVE: "1" },
        liveCredentialVault: liveVault()
      }),
      /verification id is missing/u
    );

    await assert.rejects(
      () => createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState({ flipTimestamp: undefined }), {
        env: { BELLWETHER_FEATURE_BROKER_MODE_LIVE: "1" },
        liveCredentialVault: liveVault()
      }),
      /verification timestamp is missing/u
    );
  });

  it("refuses live mode when the live credential vault is absent or empty", async () => {
    await assert.rejects(
      () => createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState(), {
        env: { BELLWETHER_FEATURE_BROKER_MODE_LIVE: "1" }
      }),
      /live credential vault is unavailable/u
    );

    await assert.rejects(
      () => createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState(), {
        env: { BELLWETHER_FEATURE_BROKER_MODE_LIVE: "1" },
        liveCredentialVault: new SecretsBackedBrokerCredentialVault(new InMemorySecretsStore())
      }),
      /live credentials are not mounted/u
    );
  });

  it("returns only the BrokerAdapter surface after every live gate is satisfied", async () => {
    const adapter = await createBrokerAdapter(paperVault(), ALPACA_PAPER_BROKER_ACCOUNT_ID, completeLiveState(), {
      env: { BELLWETHER_FEATURE_BROKER_MODE_LIVE: "1" },
      liveCredentialVault: liveVault()
    });

    assert.equal(adapter instanceof AlpacaLiveAdapter, true);
  });
});

describe("broker flip audit log", () => {
  it("ensures the schema idempotently and appends immutable flip rows", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("INSERT INTO broker_flip_log")) {
          return {
            rows: [{
              id: values?.[0] ?? "33333333-3333-4333-8333-333333333333",
              from_mode: values?.[1],
              to_mode: values?.[2],
              confirmed_by: values?.[3],
              confirmed_by_role: values?.[4],
              second_operator: values?.[5],
              second_operator_role: values?.[6],
              flip_verification_id: values?.[7],
              reason: values?.[8],
              created_at: values?.[9] ?? "2026-06-17T20:01:00.000Z"
            }]
          };
        }

        return { rows: [] };
      }
    };
    const store = new PostgresBrokerFlipLogStore(pool as never);

    await ensureBrokerFlipLogSchema(pool as never);
    await ensureBrokerFlipLogSchema(pool as never);
    const entry = await store.appendFlipChange({
      id: "44444444-4444-4444-8444-444444444444",
      fromMode: "paper",
      toMode: "live",
      confirmedBy: "operator-admin",
      confirmedByRole: "admin",
      secondOperator: "operator-manager",
      secondOperatorRole: "manager",
      flipVerificationId: "flip-verification-1",
      reason: "Design-scope audit row for a future flip request.",
      createdAt: "2026-06-17T20:01:00.000Z"
    });

    assert.match(queries[0]?.text ?? "", /CREATE TABLE IF NOT EXISTS broker_flip_log/u);
    assert.match(queries[0]?.text ?? "", /to_mode text NOT NULL CHECK \(to_mode IN \('paper', 'live'\)\)/u);
    assert.match(queries[0]?.text ?? "", /confirmed_by_role text NOT NULL CHECK \(confirmed_by_role IN \('admin', 'manager'\)\)/u);
    assert.match(queries[0]?.text ?? "", /CREATE INDEX IF NOT EXISTS broker_flip_log_created_idx/u);
    assert.match(queries[1]?.text ?? "", /CREATE TABLE IF NOT EXISTS broker_flip_log/u);
    assert.match(queries[2]?.text ?? "", /INSERT INTO broker_flip_log/u);
    assert.equal(queries.some((query) => /\bUPDATE\b|\bDELETE\b/iu.test(query.text)), false);
    assert.equal(entry.toMode, "live");
    assert.equal(entry.confirmedByRole, "admin");
    assert.equal(entry.secondOperatorRole, "manager");
  });

  it("enforces distinct admin-boundary operators before appending", () => {
    assert.throws(
      () => validateBrokerFlipLogInput({
        fromMode: "paper",
        toMode: "live",
        confirmedBy: "operator-1",
        confirmedByRole: "admin",
        secondOperator: "operator-1",
        secondOperatorRole: "manager",
        flipVerificationId: "flip-verification-1",
        reason: "Future flip request."
      }),
      /two distinct operators/u
    );

    assert.throws(
      () => validateBrokerFlipLogInput({
        fromMode: "paper",
        toMode: "live",
        confirmedBy: "operator-1",
        confirmedByRole: "viewer",
        secondOperator: "operator-2",
        secondOperatorRole: "manager",
        flipVerificationId: "flip-verification-1",
        reason: "Future flip request."
      }),
      /admin or manager/u
    );
  });
});
