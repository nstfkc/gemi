import { afterEach, describe, expect, test, vi } from "vitest";

import { CronJob } from "./CronJob";
import { Scheduler, runTick } from "./Scheduler";

/**
 * The tick, driven by hand.
 *
 * `shouldRun` exists because there was no place in a job that covered a whole
 * tick, so the assertions here are almost all about the *other two* hooks: a
 * gate that only stopped `callback` would be sugar for an early `return`, and
 * the job it was written for — one that mails or pages on `onTick` and
 * `onComplete` — would still report from a laptop. Every test below therefore
 * records all three and asserts on the list, not on whether the work ran.
 *
 * Time is the awkward part. The tightest schedule `Bun.cron` accepts is once a
 * minute, which no test can sit through, so the tick is fired directly. Two
 * ways in are used deliberately: `runTick` for the gate's own semantics, and a
 * stubbed `Bun.cron` for the questions that are really about the scheduler —
 * that the callback it registered is gated at all, that the gate runs inside
 * the runner, and that it is asked again rather than remembered.
 */

/** A job that records which hooks ran, in order. */
function recorder(calls: string[]) {
  return class Recorded extends CronJob {
    name = "Recorded";
    cron = "@daily";
    onTick() {
      calls.push("onTick");
    }
    callback() {
      calls.push("callback");
    }
    onComplete() {
      calls.push("onComplete");
    }
  };
}

/**
 * Starts a scheduler over `jobs` with `Bun.cron` stubbed, and hands back a way
 * to fire each registered tick on demand. What is given up is Bun's clock,
 * which is not under test; what is kept is every line the scheduler puts
 * between the clock and the job, which is.
 */
function scheduled(
  jobs: Array<new () => CronJob>,
  run?: <T>(cb: () => T | Promise<T>) => Promise<T> | T,
) {
  const ticks: Array<() => unknown> = [];
  // Handles that remember being stopped, because "which schedule is still
  // running" is a question one of the tests below is entirely about.
  const handles: Array<{ stopped: boolean }> = [];
  vi.spyOn(Bun, "cron").mockImplementation(((
    _expression: string,
    callback: () => unknown,
  ) => {
    ticks.push(callback);
    const handle = {
      stopped: false,
      stop() {
        handle.stopped = true;
      },
    };
    handles.push(handle);
    return handle;
  }) as unknown as typeof Bun.cron);

  const scheduler = new Scheduler({ jobs, jobsDir: "app/cron" });
  scheduler.start(run);

  return {
    scheduler,
    handles,
    registered: ticks.length,
    tick: async (index = 0) => {
      await ticks[index]!();
    },
  };
}

afterEach(() => {
  // The stub's handles are inert, but the name-keyed registry survives the file
  // and a stale entry would be `stop()`ed by the next scheduler that reuses the
  // name — after `Bun.cron` has been restored, on an object that is not a
  // handle.
  globalThis.__gemiCronJobs?.clear();
  vi.restoreAllMocks();
});

describe("the default", () => {
  test("a job that says nothing runs, hooks and all", async () => {
    const calls: string[] = [];

    await runTick(new (recorder(calls))());

    expect(calls).toEqual(["onTick", "callback", "onComplete"]);
  });

  test("`shouldRun` is on the base class, so every job has one", () => {
    class DailyDigest extends CronJob {
      name = "DailyDigest";
      cron = "@daily";
    }

    expect(new DailyDigest().shouldRun()).toBe(true);
  });
});

describe("a gate that says no", () => {
  test("skips onTick, callback and onComplete alike", async () => {
    const calls: string[] = [];
    class Gated extends recorder(calls) {
      shouldRun() {
        return false;
      }
    }

    await runTick(new Gated());

    // Not just `callback`: an outward-reporting job announces itself in
    // `onTick` and `onComplete`, which is most of what the gate is for.
    expect(calls).toEqual([]);
  });

  test("still leaves the job scheduled and readable", async () => {
    const calls: string[] = [];
    class Gated extends recorder(calls) {
      shouldRun() {
        return false;
      }
    }

    const { scheduler, registered, tick } = scheduled([Gated]);
    await tick();

    // Gating work is not the same as unscheduling: "is it scheduled" and "will
    // it do anything" are different questions, and a schedule that hid its own
    // gated jobs would make `scheduler.jobs` lie to the test that walks it.
    expect(registered).toBe(1);
    expect(scheduler.jobs).toEqual([Gated]);
    expect(globalThis.__gemiCronJobs?.has("Recorded")).toBe(true);
    expect(calls).toEqual([]);
  });

  test("an async gate is awaited before anything runs", async () => {
    const calls: string[] = [];
    class Gated extends recorder(calls) {
      async shouldRun() {
        await Promise.resolve();
        return false;
      }
    }

    await runTick(new Gated());

    expect(calls).toEqual([]);
  });
});

describe("when the gate is asked", () => {
  test("every tick, not once when the schedule was registered", async () => {
    const calls: string[] = [];
    let allowed = false;
    class Gated extends recorder(calls) {
      shouldRun() {
        return allowed;
      }
    }

    const { tick } = scheduled([Gated]);

    // The scheduler constructs the job once, inside `start()`. A gate read at
    // that moment — a field rather than a method — would freeze whatever it saw
    // at boot, which is the one thing an environment gate must not do.
    await tick();
    expect(calls).toEqual([]);

    allowed = true;
    await tick();
    expect(calls).toEqual(["onTick", "callback", "onComplete"]);

    allowed = false;
    await tick();
    expect(calls).toEqual(["onTick", "callback", "onComplete"]);
  });

  test("inside the runner, where it can resolve services like the job body can", async () => {
    const calls: string[] = [];
    let inside = false;
    class Gated extends recorder(calls) {
      shouldRun() {
        calls.push(inside ? "gate inside" : "gate outside");
        return true;
      }
    }

    const { tick } = scheduled([Gated], async (cb) => {
      inside = true;
      try {
        return await cb();
      } finally {
        inside = false;
      }
    });
    await tick();

    // A gate evaluated in the `Bun.cron` arrow instead of inside the runner
    // would have no application context — and under the fail-closed rule below,
    // a gate that throws for want of one means the job never runs anywhere.
    expect(calls[0]).toBe("gate inside");
  });
});

describe("a gate that throws", () => {
  test("skips the tick rather than running it", async () => {
    const calls: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class Gated extends recorder(calls) {
      shouldRun(): boolean {
        throw new Error("config unavailable");
      }
    }

    await runTick(new Gated());

    // Fail closed: a gate that threw has said nothing about whether the job may
    // run, and the two wrong answers are not the same size. A skipped tick of
    // recurring work comes back on the next tick; an email sent from the wrong
    // machine does not come back at all.
    expect(calls).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("shouldRun");
    expect(error.mock.calls[0]?.[0]).toContain("Recorded");
  });

  test("and a rejected promise counts as a throw", async () => {
    const calls: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    class Gated extends recorder(calls) {
      async shouldRun(): Promise<boolean> {
        throw new Error("config unavailable");
      }
    }

    await runTick(new Gated());

    expect(calls).toEqual([]);
  });

  test("without taking the scheduler down with it", async () => {
    const calls: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    class Gated extends recorder(calls) {
      shouldRun(): boolean {
        throw new Error("config unavailable");
      }
    }

    const { tick } = scheduled([Gated]);

    await expect(tick()).resolves.toBeUndefined();
  });
});

describe("a gate inherited from a base class", () => {
  test("covers a subclass that does not override it", async () => {
    const calls: string[] = [];
    let production = false;

    // The shape the issue describes: several jobs report outward, so the gate
    // is written once on a base they share. Before `shouldRun`, that base had
    // to shadow `callback` and rename the real body to `run()`.
    abstract class ReportingCron extends CronJob {
      shouldRun() {
        return production;
      }
    }
    class WeeklyRevenue extends ReportingCron {
      name = "WeeklyRevenue";
      cron = "@weekly";
      onTick() {
        calls.push("onTick");
      }
      callback() {
        calls.push("callback");
      }
      onComplete() {
        calls.push("onComplete");
      }
    }

    await runTick(new WeeklyRevenue());
    expect(calls).toEqual([]);

    production = true;
    await runTick(new WeeklyRevenue());
    // And the subclass kept `callback` — the name the documentation teaches,
    // rather than a `run()` only its own base class knows to call.
    expect(calls).toEqual(["onTick", "callback", "onComplete"]);
  });

  test("narrows rather than disappears when a subclass calls super", async () => {
    const calls: string[] = [];
    abstract class ReportingCron extends CronJob {
      // Annotated, not inferred. A base that returns a plain `boolean` narrows
      // the signature its subclasses inherit, and the `super` composition below
      // has to be `async` to await it — which TypeScript then rejects as
      // incompatible with the base. Writing the type `CronJob` declares keeps
      // both spellings open.
      shouldRun(): Promise<boolean> | boolean {
        return false;
      }
    }
    class WeeklyRevenue extends ReportingCron {
      name = "WeeklyRevenue";
      cron = "@weekly";
      subscribers = true;
      async shouldRun() {
        return (await super.shouldRun()) && this.subscribers;
      }
      callback() {
        calls.push("callback");
      }
    }

    await runTick(new WeeklyRevenue());

    expect(calls).toEqual([]);
  });
});

describe("what the gate did not change", () => {
  test("onComplete still runs when callback throws", async () => {
    const calls: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    class Failing extends recorder(calls) {
      callback(): void {
        calls.push("callback");
        throw new Error("nope");
      }
    }

    await runTick(new Failing());

    // It is a `finally`, not a success handler — true before `shouldRun` and
    // still true after, which is why a gated tick has to skip it explicitly
    // rather than rely on the work not happening.
    expect(calls).toEqual(["onTick", "callback", "onComplete"]);
  });

  test("a job with no name or no expression is still refused, unasked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const asked: string[] = [];

    class Nameless extends CronJob {
      cron = "@daily";
      shouldRun() {
        asked.push("Nameless");
        return true;
      }
    }
    class Scheduleless extends CronJob {
      name = "Scheduleless";
      shouldRun() {
        asked.push("Scheduleless");
        return true;
      }
    }

    const { registered } = scheduled([Nameless, Scheduleless]);

    expect(registered).toBe(0);
    expect(asked).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
  });
});

/**
 * What discovery did to a name.
 *
 * Under an explicit `jobs` array both of these were at least visible: two
 * classes claiming one name sat on adjacent lines of a config file, and a base
 * class was one nobody had listed. Reading a directory takes that away — the
 * set is assembled from whatever is on disk — so the scheduler is now the only
 * thing in a position to notice, and both of these used to pass through it
 * without a word that helped.
 */
describe("what a directory can hand the scheduler", () => {
  test("two jobs claiming one name: the first keeps it, the second is refused", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    class BillingDailyReport extends CronJob {
      name = "DailyReport";
      cron = "@daily";
    }
    class AnalyticsDailyReport extends CronJob {
      name = "DailyReport";
      cron = "@daily";
    }

    const { registered, handles, scheduler } = scheduled([
      BillingDailyReport,
      AnalyticsDailyReport,
    ]);

    // One schedule, and it is the first job's — still running. Before this, the
    // second registration reached `registry.get(name).stop()` and killed the
    // first one's handle on its way past, so the surviving schedule was the
    // *last* class the walk happened to return.
    expect(registered).toBe(1);
    expect(handles[0]!.stopped).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      'Two cron jobs claim the name "DailyReport"',
    );

    // `jobs` still lists both, deliberately: it reports what the scheduler was
    // handed, and a test walking it should see the collision rather than have
    // it tidied away.
    expect(scheduler.jobs).toHaveLength(2);
  });

  test("re-registering the same name across a reload still replaces in place", () => {
    class DailyDigest extends CronJob {
      name = "DailyDigest";
      cron = "@daily";
    }

    const first = scheduled([DailyDigest]);
    expect(first.handles[0]!.stopped).toBe(false);

    // A second `start()`, which is what a `bun --hot` reload amounts to. The
    // name-claimed check is per-pass, so it must not mistake this for the
    // collision above — the previous handle is stopped and replaced.
    const second = scheduled([DailyDigest]);

    expect(first.handles[0]!.stopped).toBe(true);
    expect(second.registered).toBe(1);
  });

  test("`jobs` is a copy, so walking it cannot edit what the scheduler runs from", () => {
    class DailyDigest extends CronJob {
      name = "DailyDigest";
      cron = "@daily";
    }

    const { scheduler } = scheduled([DailyDigest]);
    (scheduler.jobs as Array<new () => CronJob>).length = 0;

    expect(scheduler.jobs).toHaveLength(1);
  });

  test("a nameless class is refused by a message that names it and says why", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // `abstract` is erased before any of this runs, so a shared base sitting in
    // the walked directory arrives here indistinguishable from a job. Nothing
    // in the framework can tell them apart; the message is the whole remedy,
    // and `JSON.stringify` of a nameless job prints `{}`.
    abstract class AlertingCronJob extends CronJob {
      shouldRun() {
        return process.env.NODE_ENV === "production";
      }
    }

    const { registered } = scheduled([AlertingCronJob as new () => CronJob]);

    expect(registered).toBe(0);
    const message = vi.mocked(error).mock.calls[0]![0] as string;
    expect(message).toContain("AlertingCronJob");
    expect(message).toContain("base class");
  });
});
