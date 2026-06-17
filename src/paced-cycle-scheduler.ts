import type { MarketClock } from "./market-clock.js";
import type { PacedCadenceConfig } from "./placement.js";

export type PacedCycleSchedulerOptions = {
  cadence: PacedCadenceConfig;
  marketClock: MarketClock;
  isEnabled: () => Promise<boolean>;
  runCycle: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  shouldContinue?: () => boolean;
  idleIntervalMs?: number;
  maxSleepMs?: number;
  nowMs?: () => number;
  logger?: Pick<Console, "warn">;
};

export type PacedCycleSchedulerTickResult = {
  reason: "disabled" | "market_closed" | "clock_error" | "cycle_ran" | "no_due_job";
  ranCycle: boolean;
  waitMs: number;
};

export async function runPacedCycleScheduler(options: PacedCycleSchedulerOptions): Promise<void> {
  while (options.shouldContinue?.() ?? true) {
    const tick = await runPacedCycleSchedulerTick(options);
    await options.sleep(boundWaitMs(tick.waitMs, options.maxSleepMs));
  }
}

export async function runPacedCycleSchedulerTick(options: PacedCycleSchedulerOptions): Promise<PacedCycleSchedulerTickResult> {
  const idleIntervalMs = options.idleIntervalMs ?? options.cadence.cycleIntervalMs;

  if (!(await options.isEnabled())) {
    return { reason: "disabled", ranCycle: false, waitMs: idleIntervalMs };
  }

  if (options.cadence.marketHoursAware) {
    let clock;
    try {
      clock = await options.marketClock.getClock();
    } catch (error: unknown) {
      options.logger?.warn(`market clock unavailable; live cycle scheduler is idling: ${error instanceof Error ? error.message : "unknown clock error"}`);
      return { reason: "clock_error", ranCycle: false, waitMs: idleIntervalMs };
    }

    if (!clock.isOpen) {
      return {
        reason: "market_closed",
        ranCycle: false,
        waitMs: marketClosedWaitMs(clock.nextOpen, options.nowMs?.() ?? Date.now(), idleIntervalMs)
      };
    }
  }

  const ranCycle = await options.runCycle();
  return {
    reason: ranCycle ? "cycle_ran" : "no_due_job",
    ranCycle,
    waitMs: ranCycle ? options.cadence.cycleIntervalMs : idleIntervalMs
  };
}

function marketClosedWaitMs(nextOpen: string, nowMs: number, idleIntervalMs: number): number {
  const nextOpenMs = Date.parse(nextOpen);

  if (!Number.isFinite(nextOpenMs) || nextOpenMs <= nowMs) {
    return idleIntervalMs;
  }

  return Math.max(1, Math.min(nextOpenMs - nowMs, idleIntervalMs));
}

function boundWaitMs(waitMs: number, maxSleepMs: number | undefined): number {
  if (!maxSleepMs) {
    return waitMs;
  }

  return Math.min(waitMs, maxSleepMs);
}
