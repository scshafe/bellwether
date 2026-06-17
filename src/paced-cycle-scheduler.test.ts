import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MarketClock, MarketClockSnapshot } from "./market-clock.js";
import { runPacedCycleScheduler } from "./paced-cycle-scheduler.js";

describe("paced cycle scheduler", () => {
  it("runs multiple non-overlapping cycles while enabled and market-open", async () => {
    let cycles = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const sleeps: number[] = [];

    await runPacedCycleScheduler({
      cadence: { cycleIntervalMs: 25, marketHoursAware: true },
      marketClock: new MutableMarketClock(true),
      isEnabled: async () => true,
      runCycle: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        cycles += 1;
        inFlight -= 1;
        return true;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      shouldContinue: () => cycles < 3,
      idleIntervalMs: 5
    });

    assert.equal(cycles, 3);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(sleeps, [25, 25, 25]);
  });

  it("idles while the market is closed and resumes when it opens", async () => {
    const marketClock = new MutableMarketClock(false);
    let cycles = 0;
    let sleeps = 0;

    await runPacedCycleScheduler({
      cadence: { cycleIntervalMs: 25, marketHoursAware: true },
      marketClock,
      isEnabled: async () => true,
      runCycle: async () => {
        cycles += 1;
        return true;
      },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) {
          marketClock.isOpen = true;
        }
      },
      shouldContinue: () => cycles < 1,
      idleIntervalMs: 5,
      nowMs: () => Date.parse("2026-06-17T14:30:00.000Z")
    });

    assert.equal(cycles, 1);
    assert.equal(sleeps, 3);
  });

  it("stops running cycles after the enabled-state read flips off", async () => {
    let enabled = true;
    let cycles = 0;
    let sleeps = 0;

    await runPacedCycleScheduler({
      cadence: { cycleIntervalMs: 25, marketHoursAware: true },
      marketClock: new MutableMarketClock(true),
      isEnabled: async () => enabled,
      runCycle: async () => {
        cycles += 1;
        enabled = false;
        return true;
      },
      sleep: async () => {
        sleeps += 1;
      },
      shouldContinue: () => sleeps < 3,
      idleIntervalMs: 5
    });

    assert.equal(cycles, 1);
    assert.equal(enabled, false);
  });
});

class MutableMarketClock implements MarketClock {
  constructor(public isOpen: boolean) {}

  async getClock(): Promise<MarketClockSnapshot> {
    return {
      timestamp: "2026-06-17T14:30:00.000Z",
      isOpen: this.isOpen,
      nextOpen: "2026-06-17T14:35:00.000Z",
      nextClose: "2026-06-17T20:00:00.000Z"
    };
  }
}
