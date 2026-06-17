import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { featureEnvName, isFeatureEnabled } from "./config.js";

describe("feature flags", () => {
  it("maps feature names to Bellwether env variables", () => {
    assert.equal(featureEnvName("x-handles"), "BELLWETHER_FEATURE_X_HANDLES");
    assert.equal(featureEnvName(" X Handles "), "BELLWETHER_FEATURE_X_HANDLES");
  });

  it("defaults absent and false-like values off", () => {
    assert.equal(isFeatureEnabled("x-handles", {}), false);
    assert.equal(isFeatureEnabled("x-handles", { BELLWETHER_FEATURE_X_HANDLES: "" }), false);
    assert.equal(isFeatureEnabled("x-handles", { BELLWETHER_FEATURE_X_HANDLES: "0" }), false);
    assert.equal(isFeatureEnabled("x-handles", { BELLWETHER_FEATURE_X_HANDLES: "false" }), false);
  });

  it("enables only explicit on values", () => {
    assert.equal(isFeatureEnabled("x-handles", { BELLWETHER_FEATURE_X_HANDLES: "1" }), true);
    assert.equal(isFeatureEnabled("x-handles", { BELLWETHER_FEATURE_X_HANDLES: " TRUE " }), true);
    assert.equal(isFeatureEnabled("x-handles", { BELLWETHER_FEATURE_X_HANDLES: "yes" }), false);
  });
});
