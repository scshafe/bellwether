import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  ALPACA_PAPER_BROKER_ACCOUNT_ID,
  ALPACA_PAPER_CREDENTIAL_FILE,
  AlpacaPaperAdapter,
  createAlpacaPaperSecretsStore
} from "./broker.js";
import { SecretsBackedBrokerCredentialVault } from "./secrets.js";

async function credentialFileExists(): Promise<boolean> {
  try {
    await access(ALPACA_PAPER_CREDENTIAL_FILE);
    return true;
  } catch {
    return false;
  }
}

describe("Alpaca paper live smoke", async () => {
  const hasCredentialFile = await credentialFileExists();

  it(
    "reads account and positions, then places one small bounded paper order",
    { skip: hasCredentialFile ? false : `${ALPACA_PAPER_CREDENTIAL_FILE} is not mounted` },
    async () => {
      const store = await createAlpacaPaperSecretsStore();
      const vault = new SecretsBackedBrokerCredentialVault(store);
      const adapter = new AlpacaPaperAdapter(vault, ALPACA_PAPER_BROKER_ACCOUNT_ID);

      const account = await adapter.getAccount();
      const positions = await adapter.getPositions();
      const order = await adapter.placeOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        limitPrice: 1,
        timeInForce: "day",
        clientOrderId: `atp-p1-smoke-${Date.now()}`
      });

      assert.equal(account.status.length > 0, true);
      assert.equal(Array.isArray(positions), true);
      assert.equal(order.id.length > 0, true);
      assert.match(order.status, /accepted|pending_new|new|accepted_for_bidding|partially_filled|filled/u);
      console.log(
        JSON.stringify({
          smoke: "alpaca-paper",
          accountStatus: account.status,
          positionsCount: positions.length,
          orderId: order.id,
          orderStatus: order.status,
          symbol: order.symbol
        })
      );
    }
  );
});
