import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { Application } from "../foundation/Application";
import { Repository } from "../support/Repository";
import type { ConfigItems } from "../support/Repository";
import { Scheduler } from "./cron/Scheduler";
import { ScheduleServiceProvider } from "./cron/ScheduleServiceProvider";
import { CronJob } from "./cron/CronJob";
import {
  discoverCommands,
  discoverCronJobs,
  discoverJobs,
  discoverListeners,
} from "./discovery";
import { EventManager } from "./events/EventManager";
import { EventServiceProvider } from "./events/EventServiceProvider";
import { Event } from "./events/Event";
import { Listener } from "./events/Listener";
import { Job } from "./queue/Job";
import { QueueManager } from "./queue/QueueManager";
import { QueueServiceProvider } from "./queue/QueueServiceProvider";

/**
 * Discovery from the outside: an application directory on disk, booted, asked
 * what it ended up with.
 *
 * The failures being guarded are both silent ones. A job class that never
 * reaches the `QueueManager`'s registry means a dispatch dropped after the
 * caller has already moved on, and a `CronJob` that never reaches the
 * `Scheduler` means a report
 * nobody is waiting for and nobody misses. Neither shows up as an error, so the
 * assertion has to be on the set itself — which is the same reason both managers
 * grew a readable view of what they took.
 *
 * The fixtures are real files in a temp directory, because that is the thing
 * under test: the skip rules are only true of a filesystem, and the config's
 * override rule turns on a distinction (absent versus `[]`) that only exists
 * before defaults are applied. They import their base class by absolute path
 * rather than from `gemi/services`, since a temp directory has no
 * `node_modules` above it to resolve that through — the path resolves to the
 * very module this file imports `Job` and `CronJob` from, so the identity
 * `discoverClasses` walks the prototype chain for holds.
 */

const JOB = JSON.stringify(resolve(import.meta.dirname, "queue/Job.ts"));
const CRON_JOB = JSON.stringify(
  resolve(import.meta.dirname, "cron/CronJob.ts"),
);

const roots: string[] = [];
const applications: Application[] = [];

/** An application tree in a temp directory. Keys are paths, values are source. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gemi-discovery-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/** A `Job` subclass whose `run` is observable through the class it returns. */
const job = (name: string) => `import { Job } from ${JOB};
export class ${name} extends Job {
  run() { return ${JSON.stringify(name)}; }
}`;

const cron = (
  name: string,
  expression = "@daily",
) => `import { CronJob } from ${CRON_JOB};
export class ${name} extends CronJob {
  name = ${JSON.stringify(name)};
  cron = ${JSON.stringify(expression)};
}`;

const EVENT = JSON.stringify(resolve(import.meta.dirname, "events/Event.ts"));
const LISTENER = JSON.stringify(
  resolve(import.meta.dirname, "events/Listener.ts"),
);

/**
 * An `Event` subclass. `declared` picks which of the two spellings of a name it
 * gets — the string literal that survives a production build, or the implicit
 * class binding that does not. Both read the same in development, which is the
 * whole reason the check on them is on the property descriptor.
 */
const event = (name: string, declared = true) => `import { Event } from ${EVENT};
export class ${name} extends Event {
  ${declared ? `static name = ${JSON.stringify(name)};` : ""}
}`;

/**
 * A `Listener` bound to an event it imports the way an app would — from
 * `app/events`, a directory nothing walks.
 */
const listener = (
  name: string,
  eventName: string,
  { from = "../events", declared = true } = {},
) => `import { Listener } from ${LISTENER};
import { ${eventName} } from "${from}/${eventName}";
export class ${name} extends Listener {
  ${declared ? `static name = ${JSON.stringify(name)};` : ""}
  static event = ${eventName};
  handle() {}
}`;

/**
 * Boots an application holding nothing but the provider under test, the way
 * `RateLimitMiddleware.test.ts` does — a real container, so the register/boot
 * split the override rule depends on is the real one.
 */
async function boot(
  config: ConfigItems,
  Provider:
    | typeof QueueServiceProvider
    | typeof ScheduleServiceProvider
    | typeof EventServiceProvider,
) {
  const application = new Application(new Repository(config));
  applications.push(application);
  application.register(Provider);
  await application.boot();
  return application;
}

const names = (classes: ReadonlyArray<{ name: string }>) =>
  classes.map((value) => value.name);

/**
 * Runs `fn` with the project root pointed at a fixture, so the *default*
 * directory — the relative `app/jobs` and `app/cron` every real app uses — has
 * something to find.
 *
 * Every other test here names an absolute `jobsDir`, which is convenient and
 * skips `resolveDir`'s relative branch entirely: an absolute path is returned
 * untouched, so the join against the project root is never exercised and a
 * change that dropped it would leave the suite green while sending every
 * deployment that sets `GEMI_PROJECT_DIR` to walk the wrong directory. The
 * variable is the lever because `projectRoot()` is `cwd` joined with it, which
 * also means it has to be handed a *relative* path — `join` does not restart on
 * an absolute segment. Setting it beats `process.chdir()`, which is not
 * available in every pool vitest can run this file in.
 */
async function withProjectRoot(root: string, fn: () => Promise<void>) {
  const previous = process.env.GEMI_PROJECT_DIR;
  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), root);
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.GEMI_PROJECT_DIR;
    else process.env.GEMI_PROJECT_DIR = previous;
  }
}

afterEach(() => {
  // Every `Bun.cron` handle a booted Scheduler registered, including the
  // cross-reload registry it keys by name — a schedule left running would keep
  // ticking into the next test file.
  for (const application of applications.splice(0)) {
    if (application.resolved(Scheduler)) application.make(Scheduler).stop();
  }
  for (const [name, handle] of globalThis.__gemiCronJobs ?? []) {
    handle.stop();
    globalThis.__gemiCronJobs?.delete(name);
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("asking an application what it has", () => {
  test("finds every Job subclass under the directory, nested included", async () => {
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": job("SendWelcomeEmail"),
      "app/jobs/billing/ChargeCard.ts": job("ChargeCard"),
    });

    // Capitals sort before lowercase, so the file beats the directory beside it.
    expect(names(await discoverJobs(join(root, "app/jobs")))).toEqual([
      "SendWelcomeEmail",
      "ChargeCard",
    ]);
  });

  test("finds every CronJob subclass, and never the base class itself", async () => {
    const root = project({
      "app/cron/DailyDigest.ts": cron("DailyDigest"),
      // The shape an app reaches for when several jobs share something: a base
      // beside them, re-exported. Scheduling it would run a job nobody wrote.
      "app/cron/base.ts": `export { CronJob } from ${CRON_JOB};`,
    });

    expect(names(await discoverCronJobs(join(root, "app/cron")))).toEqual([
      "DailyDigest",
    ]);
  });

  test("a directory that does not exist is an empty list, not a throw", async () => {
    const root = project({ "app/config/queue.ts": "" });

    expect(await discoverJobs(join(root, "app/jobs"))).toEqual([]);
    expect(await discoverCronJobs(join(root, "app/cron"))).toEqual([]);
  });
});

describe("the queue registry", () => {
  test("is filled from app/jobs when the slice leaves `jobs` out", async () => {
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": job("SendWelcomeEmail"),
      "app/jobs/billing/ChargeCard.ts": job("ChargeCard"),
    });

    const application = await boot(
      { queue: { jobsDir: join(root, "app/jobs") } },
      QueueServiceProvider,
    );
    const queue = application.make(QueueManager);

    expect(names(queue.registeredJobs)).toEqual([
      "SendWelcomeEmail",
      "ChargeCard",
    ]);
    // Keyed by name, which is what a dispatch carries and what `next()` looks
    // up before deciding to drop it.
    expect(queue.dispatchJob("ChargeCard", "[]")).toBe("ChargeCard");
  });

  test("a slice with no `queue` key at all discovers too, from the default app/jobs", async () => {
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": job("SendWelcomeEmail"),
    });

    // The whole path a scaffolded app takes: no slice, no `jobsDir`, so the
    // default relative `app/jobs` is resolved against the project root. An app
    // that never wrote a config file is the ordinary case, not an opt-out —
    // and asserting the class comes back is what tells "it looked" apart from
    // "it refused", which an empty expectation cannot.
    await withProjectRoot(root, async () => {
      const application = await boot({}, QueueServiceProvider);

      expect(names(application.make(QueueManager).registeredJobs)).toEqual([
        "SendWelcomeEmail",
      ]);
    });
  });

  test("an explicit list wins and the directory is never read", async () => {
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": job("SendWelcomeEmail"),
      "app/jobs/ChargeCard.ts": job("ChargeCard"),
    });

    class ReticulateSplines extends Job {}

    const application = await boot(
      { queue: { jobs: [ReticulateSplines], jobsDir: join(root, "app/jobs") } },
      QueueServiceProvider,
    );

    expect(names(application.make(QueueManager).registeredJobs)).toEqual([
      "ReticulateSplines",
    ]);
  });

  test("`jobs: []` means an app with no jobs, not an app that wants them found", async () => {
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": job("SendWelcomeEmail"),
    });

    const application = await boot(
      { queue: { jobs: [], jobsDir: join(root, "app/jobs") } },
      QueueServiceProvider,
    );

    expect(application.make(QueueManager).registeredJobs).toEqual([]);
  });

  /**
   * `withDefaults` treats an explicit `undefined` as an omission everywhere
   * else, and a `jobs` key spread in from an optional value is exactly that.
   * Reading the slice before defaults are applied is the only place the
   * difference is still visible.
   */
  test("`jobs: undefined` counts as absent and discovers", async () => {
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": job("SendWelcomeEmail"),
    });

    const application = await boot(
      { queue: { jobs: undefined, jobsDir: join(root, "app/jobs") } },
      QueueServiceProvider,
    );

    expect(names(application.make(QueueManager).registeredJobs)).toEqual([
      "SendWelcomeEmail",
    ]);
  });

  test("a missing app/jobs leaves the registry empty rather than failing to boot", async () => {
    const root = project({ "app/config/queue.ts": "" });

    const application = await boot(
      { queue: { jobsDir: join(root, "app/jobs") } },
      QueueServiceProvider,
    );

    expect(application.make(QueueManager).registeredJobs).toEqual([]);
  });
});

describe("the schedule", () => {
  test("is filled from app/cron when the slice leaves `jobs` out", async () => {
    const root = project({
      "app/cron/DailyDigest.ts": cron("DailyDigest"),
      "app/cron/reports/WeeklyRevenue.ts": cron("WeeklyRevenue", "@weekly"),
    });

    const application = await boot(
      { schedule: { jobsDir: join(root, "app/cron") } },
      ScheduleServiceProvider,
    );

    expect(names(application.make(Scheduler).jobs)).toEqual([
      "DailyDigest",
      "WeeklyRevenue",
    ]);
  });

  /**
   * The requirement from #323 itself: an application exported `jobs` from its
   * config module so a test could walk the same list the scheduler runs. Under
   * discovery there is no array to import, so the resolved set has to be
   * readable from the scheduler — and it has to be the set that was actually
   * scheduled, not the one the config asked for.
   */
  test("what was resolved is readable afterwards, and is what got scheduled", async () => {
    const root = project({ "app/cron/DailyDigest.ts": cron("DailyDigest") });

    const application = await boot(
      { schedule: { jobsDir: join(root, "app/cron") } },
      ScheduleServiceProvider,
    );

    expect(names(application.make(Scheduler).jobs)).toEqual(["DailyDigest"]);
    expect(globalThis.__gemiCronJobs?.has("DailyDigest")).toBe(true);
  });

  test("an application with no `schedule` slice at all discovers, from the default app/cron", async () => {
    const root = project({ "app/cron/DailyDigest.ts": cron("DailyDigest") });

    await withProjectRoot(root, async () => {
      const application = await boot({}, ScheduleServiceProvider);

      expect(names(application.make(Scheduler).jobs)).toEqual(["DailyDigest"]);
    });
  });

  test("an explicit list wins and the directory is never read", async () => {
    const root = project({ "app/cron/DailyDigest.ts": cron("DailyDigest") });

    class NightlyBackup extends CronJob {
      name = "NightlyBackup";
      cron = "@daily";
    }

    const application = await boot(
      {
        schedule: {
          jobs: [NightlyBackup],
          jobsDir: join(root, "app/cron"),
        },
      },
      ScheduleServiceProvider,
    );

    expect(names(application.make(Scheduler).jobs)).toEqual(["NightlyBackup"]);
    expect(globalThis.__gemiCronJobs?.has("DailyDigest")).toBe(false);
  });

  test("`jobs: []` means nothing scheduled, not everything found", async () => {
    const root = project({ "app/cron/DailyDigest.ts": cron("DailyDigest") });

    const application = await boot(
      { schedule: { jobs: [], jobsDir: join(root, "app/cron") } },
      ScheduleServiceProvider,
    );

    expect(application.make(Scheduler).jobs).toEqual([]);
  });

  test("a missing app/cron leaves the schedule empty rather than failing to boot", async () => {
    const root = project({ "app/config/schedule.ts": "" });

    const application = await boot(
      { schedule: { jobsDir: join(root, "app/cron") } },
      ScheduleServiceProvider,
    );

    expect(application.make(Scheduler).jobs).toEqual([]);
  });

  /**
   * `GEMI_NO_SCHEDULE=1` is what `gemi run` sets on the process it spawns.
   *
   * Booting the application is how a console command reaches the container, and
   * starting the schedule is a side effect of that which nobody asked for: a
   * `gemi run backfill` that takes four minutes would otherwise fire the whole
   * schedule in a process no operator is watching, and the `Bun.cron` handles
   * hold the loop open besides.
   *
   * The half worth pinning is the *first* assertion. Suppressing the schedule by
   * skipping discovery too would look identical from the outside — nothing ticks
   * either way — and would quietly make `app(Scheduler).jobs` answer differently
   * depending on which process asked, so a command that wanted to fire a tick by
   * hand would find nothing to fire.
   */
  test("GEMI_NO_SCHEDULE resolves and lists the jobs, and starts none of them", async () => {
    const root = project({
      "app/cron/EveryMinute.ts": cron("EveryMinute", "* * * * *"),
    });

    const previous = process.env.GEMI_NO_SCHEDULE;
    process.env.GEMI_NO_SCHEDULE = "1";

    try {
      const application = await boot(
        { schedule: { jobsDir: join(root, "app/cron") } },
        ScheduleServiceProvider,
      );

      expect(names(application.make(Scheduler).jobs)).toEqual(["EveryMinute"]);
      expect(globalThis.__gemiCronJobs?.size ?? 0).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.GEMI_NO_SCHEDULE;
      else process.env.GEMI_NO_SCHEDULE = previous;
    }
  });

  test("without it, the same schedule does start", async () => {
    const root = project({
      "app/cron/EveryMinute.ts": cron("EveryMinute", "* * * * *"),
    });

    const application = await boot(
      { schedule: { jobsDir: join(root, "app/cron") } },
      ScheduleServiceProvider,
    );

    expect(names(application.make(Scheduler).jobs)).toEqual(["EveryMinute"]);
    expect(globalThis.__gemiCronJobs?.size ?? 0).toBe(1);
  });
});

/**
 * Commands, the third directory discovery reads.
 *
 * The walk is the same one, so the skip rules and the base-class exclusion are
 * covered above and only spot-checked here. What is specific to commands is the
 * failure the builder introduces: a chain that never reached `.handle()` is a
 * plain object rather than a class, so the walk would discard it exactly as it
 * discards a helper — and the command would vanish from `gemi run` with nothing
 * raised, which is the silence this whole file exists to remove.
 */
describe("asking an application what commands it has", () => {
  const BUILDER = JSON.stringify(
    resolve(import.meta.dirname, "../console/builder.ts"),
  );

  const declaration = (name: string) =>
    `import { defineCommand } from ${BUILDER};
export default defineCommand(${JSON.stringify(name)}).handle(() => {});`;

  test("finds every command under the directory, nested included", async () => {
    const root = project({
      "app/commands/Seed.ts": declaration("db:seed"),
      "app/commands/tenants/Repair.ts": declaration("tenants:repair"),
    });

    const found = await discoverCommands(join(root, "app/commands"));

    expect(found.map((command) => command.commandName)).toEqual([
      "db:seed",
      "tenants:repair",
    ]);
  });

  test("never returns the base class, however it got re-exported", async () => {
    const root = project({
      "app/commands/Seed.ts": declaration("db:seed"),
      "app/commands/base.ts": `export { Command } from ${JSON.stringify(
        resolve(import.meta.dirname, "../console/Command.ts"),
      )};`,
    });

    expect(
      (await discoverCommands(join(root, "app/commands"))).map(
        (command) => command.commandName,
      ),
    ).toEqual(["db:seed"]);
  });

  test("a directory that does not exist is an empty list, not a throw", async () => {
    const root = project({ "app/config/command.ts": "" });

    expect(await discoverCommands(join(root, "app/commands"))).toEqual([]);
  });

  test("an unfinished builder stops the walk and names the file", async () => {
    const root = project({
      "app/commands/Seed.ts": declaration("db:seed"),
      "app/commands/Half.ts": `import { defineCommand } from ${BUILDER};
export default defineCommand("half-written").arg("who");`,
    });

    await expect(
      discoverCommands(join(root, "app/commands")),
    ).rejects.toThrow(/never called `\.handle\(\)`/);
  });

  test("the ordinary things a command file exports are not mistaken for one", async () => {
    const root = project({
      "app/commands/Seed.ts": `${declaration("db:seed")}
export const BATCH_SIZE = 100;
export function helper() {}
export const config = { retries: 3 };`,
    });

    expect(
      (await discoverCommands(join(root, "app/commands"))).map(
        (command) => command.commandName,
      ),
    ).toEqual(["db:seed"]);
  });
});

/**
 * Listeners, the fourth directory discovery reads.
 *
 * The walk is the same one, so the skip rules are covered above. What is
 * specific here is that a listener carries a *second* class — the event it
 * binds to — and the registry is keyed by that event's name. So there are two
 * name checks rather than one, and the second is the one that matters from the
 * first dispatch: an event whose name is the implicit class binding is renamed
 * by a production build on the dispatching side while discovery reads the
 * listener's copy from source, and the dispatch then reaches nobody, silently
 * and in production only.
 */
describe("asking an application what listeners it has", () => {
  test("finds every Listener subclass under the directory, nested included", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/events/OrderPaid.ts": event("OrderPaid"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
      "app/listeners/billing/IssueReceipt.ts": listener(
        "IssueReceipt",
        "OrderPaid",
        { from: "../../events" },
      ),
    });

    // The walk's order: entries are sorted per directory, and capitals sort
    // before lowercase, so the file beats the directory beside it. Reproducible
    // — which is all it is. Nothing may depend on one listener running before
    // another, because nothing about a filesystem layout was chosen to say so.
    expect(names(await discoverListeners(join(root, "app/listeners")))).toEqual([
      "SendWelcomeEmail",
      "IssueReceipt",
    ]);
  });

  test("never returns the base class, however it got re-exported", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
      "app/listeners/base.ts": `export { Listener } from ${LISTENER};`,
    });

    expect(names(await discoverListeners(join(root, "app/listeners")))).toEqual([
      "SendWelcomeEmail",
    ]);
  });

  test("a directory that does not exist is an empty list, not a throw", async () => {
    const root = project({ "app/config/events.ts": "" });

    expect(await discoverListeners(join(root, "app/listeners"))).toEqual([]);
  });

  test("a file that will not import stops the walk and names it", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/Broken.ts": `import "./styles.css?raw";
export class Broken {}`,
    });

    // Not a skip. Four listeners found out of five looks exactly like five out
    // of five, and the one that vanished is a side effect nobody is waiting on.
    await expect(
      discoverListeners(join(root, "app/listeners")),
    ).rejects.toThrow(/Broken\.ts could not be imported/);
  });

  /**
   * A listener that binds to nothing is refused rather than warned about: it
   * can be registered under no name, so it is a file the author wrote that will
   * never run — and the compiler cannot see it, because `static event` is
   * declared on the base and every subclass inherits the declaration whether or
   * not it assigns one.
   */
  test("a listener with no `static event` stops the walk, by name", async () => {
    const root = project({
      "app/listeners/Unbound.ts": `import { Listener } from ${LISTENER};
export class Unbound extends Listener {
  static name = "Unbound";
  handle() {}
}`,
    });

    await expect(
      discoverListeners(join(root, "app/listeners")),
    ).rejects.toThrow(/Unbound declare no `static event`/);
  });
});

/**
 * The hazard discovery adds rather than removes, in its events form — and here
 * it is worse than the queue's, because a dropped job at least says so on
 * stderr while a dispatch that reaches no listener says nothing at all outside
 * development.
 */
describe("a name that will not survive a production build", () => {
  test("the event's is warned about, with the line that fixes it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered", false),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
    });

    await discoverListeners(join(root, "app/listeners"));

    const message = vi.mocked(warn).mock.calls.at(-1)![0] as string;
    expect(message).toContain("Event UserRegistered");
    expect(message).toContain('static name = "UserRegistered"');
  });

  test("the listener's own is warned about too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
        { declared: false },
      ),
    });

    await discoverListeners(join(root, "app/listeners"));

    expect(vi.mocked(warn).mock.calls.at(-1)![0]).toContain(
      'Event listener SendWelcomeEmail does not declare `static name`',
    );
  });

  test("a listener and an event that both declare one are left alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
    });

    await discoverListeners(join(root, "app/listeners"));

    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The check reads the property descriptor, and this is what stops it
   * degrading into a tautology on the next refactor: both classes below report
   * the same `.name`, and only one of them will still report it after a
   * minifier has been over the file that dispatches it.
   */
  test("the two spellings are told apart exactly, not guessed at", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = project({
      // Same string on both sides. `Implicit` gets it from the class binding.
      "app/events/Declared.ts": event("Declared"),
      "app/events/Implicit.ts": event("Implicit", false),
      "app/listeners/OnDeclared.ts": listener("OnDeclared", "Declared"),
      "app/listeners/OnImplicit.ts": listener("OnImplicit", "Implicit"),
    });

    await discoverListeners(join(root, "app/listeners"));

    expect(warn).toHaveBeenCalledOnce();
    expect(vi.mocked(warn).mock.calls[0]![0]).toContain("Event Implicit");
  });

  test("and the descriptor is what separates them", () => {
    class Implicit extends Event {}
    class Explicit extends Event {
      static name = "Explicit";
    }

    expect(Implicit.name).toBe("Implicit");
    expect(Object.getOwnPropertyDescriptor(Implicit, "name")?.writable).toBe(
      false,
    );
    expect(Object.getOwnPropertyDescriptor(Explicit, "name")?.writable).toBe(
      true,
    );
  });
});

describe("the listener registry", () => {
  test("is filled from app/listeners when the slice leaves `listeners` out", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
      "app/listeners/NotifyAdmins.ts": listener(
        "NotifyAdmins",
        "UserRegistered",
      ),
    });

    const application = await boot(
      { events: { listenersDir: join(root, "app/listeners") } },
      EventServiceProvider,
    );

    // Two listeners on one event is the normal case here, where two jobs on one
    // name is the pathological one.
    expect(names(application.make(EventManager).registeredListeners)).toEqual([
      "NotifyAdmins",
      "SendWelcomeEmail",
    ]);
  });

  test("an app with no `events` slice at all discovers, from the default app/listeners", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
    });

    await withProjectRoot(root, async () => {
      const application = await boot({}, EventServiceProvider);

      expect(names(application.make(EventManager).registeredListeners)).toEqual(
        ["SendWelcomeEmail"],
      );
    });
  });

  test("an explicit list wins and the directory is never read", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
    });

    class Ping extends Event {
      static name = "Ping";
    }
    class LogThePing extends Listener {
      static name = "LogThePing";
      static event = Ping;
      handle() {}
    }

    const application = await boot(
      {
        events: {
          listeners: [LogThePing],
          listenersDir: join(root, "app/listeners"),
        },
      },
      EventServiceProvider,
    );

    expect(names(application.make(EventManager).registeredListeners)).toEqual([
      "LogThePing",
    ]);
  });

  test("`listeners: []` means an app with no listeners, not one that wants them found", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
    });

    const application = await boot(
      { events: { listeners: [], listenersDir: join(root, "app/listeners") } },
      EventServiceProvider,
    );

    expect(application.make(EventManager).registeredListeners).toEqual([]);
  });

  test("`listeners: undefined` counts as absent and discovers", async () => {
    const root = project({
      "app/events/UserRegistered.ts": event("UserRegistered"),
      "app/listeners/SendWelcomeEmail.ts": listener(
        "SendWelcomeEmail",
        "UserRegistered",
      ),
    });

    const application = await boot(
      {
        events: {
          listeners: undefined,
          listenersDir: join(root, "app/listeners"),
        },
      },
      EventServiceProvider,
    );

    expect(names(application.make(EventManager).registeredListeners)).toEqual([
      "SendWelcomeEmail",
    ]);
  });

  test("a missing app/listeners leaves the registry empty rather than failing to boot", async () => {
    const root = project({ "app/config/events.ts": "" });

    const application = await boot(
      { events: { listenersDir: join(root, "app/listeners") } },
      EventServiceProvider,
    );

    expect(application.make(EventManager).registeredListeners).toEqual([]);
  });

  /**
   * End to end, through a real container: the file on disk is what runs.
   * Everything else here asserts on the registry, which cannot tell a listener
   * that was registered from one that was registered *and dispatched to*.
   */
  test("and a dispatch reaches what was discovered", async () => {
    const root = project({
      "app/events/UserRegistered.ts": `import { Event } from ${EVENT};
export class UserRegistered extends Event {
  static name = "UserRegistered";
  constructor(email) { super(); this.email = email; }
}`,
      "app/listeners/SendWelcomeEmail.ts": `import { Listener } from ${LISTENER};
import { UserRegistered } from "../events/UserRegistered";
export const seen = [];
export class SendWelcomeEmail extends Listener {
  static name = "SendWelcomeEmail";
  static event = UserRegistered;
  handle(event) { seen.push(event.email); }
}`,
    });

    const application = await boot(
      { events: { listenersDir: join(root, "app/listeners") } },
      EventServiceProvider,
    );

    const { UserRegistered } = await import(
      join(root, "app/events/UserRegistered.ts")
    );
    const { seen } = await import(
      join(root, "app/listeners/SendWelcomeEmail.ts")
    );

    await application
      .make(EventManager)
      .dispatchAndWait(new UserRegistered("ada@example.com"));

    expect(seen).toEqual(["ada@example.com"]);
  });
});

/**
 * A missing directory reads two ways and only one of them is worth saying out
 * loud. "This app has no cron jobs" is an ordinary answer that would otherwise
 * be repeated on every boot forever; "this deploy shipped without the app's
 * source" is the silence these issues exist to remove, wearing the same face.
 */
describe("when the source is not there at all", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  test("says so when neither the directory nor the tree above it exists", async () => {
    const root = project({ "package.json": "{}" });

    await discoverCronJobs(join(root, "app/cron"));

    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain(
      join(root, "app/cron"),
    );
  });

  test("stays quiet when the app is simply there and has none", async () => {
    const root = project({ "app/config/schedule.ts": "" });

    await discoverCronJobs(join(root, "app/cron"));

    expect(console.warn).not.toHaveBeenCalled();
  });
});

/**
 * The one hazard discovery adds rather than removes.
 *
 * A production build minifies the server entry, and the app code reachable from
 * it — a controller, and the job classes it imports to dispatch — is bundled
 * and minified with it. That renames the class binding, and a class's implicit
 * `.name` *is* that binding: verified against `Bun.build({minify:true})`, a
 * `TestJob` in the bundle reports `"D"`. Discovery imports the same file from
 * source at runtime, where it is still `"TestJob"`, so the queue's key and the
 * dispatch's key stop agreeing — in production and nowhere else.
 *
 * Before discovery an app could get away without `static name`, because the
 * explicit `jobs` array was bundled too and both halves were wrong identically.
 * So the warning is on the discovery path only, where the hazard is new.
 */
describe("a job whose name will not survive a production build", () => {
  test("is warned about, by name, with the line that fixes it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": job("SendWelcomeEmail"),
    });

    await discoverJobs(join(root, "app/jobs"));

    const message = vi.mocked(warn).mock.calls.at(-1)![0] as string;
    expect(message).toContain("SendWelcomeEmail");
    expect(message).toContain('static name = "SendWelcomeEmail"');
  });

  test("a job that declares `static name` is left alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = project({
      "app/jobs/SendWelcomeEmail.ts": `import { Job } from ${JOB};
export class SendWelcomeEmail extends Job {
  static name = "SendWelcomeEmail";
  run() { return "SendWelcomeEmail"; }
}`,
    });

    await discoverJobs(join(root, "app/jobs"));

    expect(warn).not.toHaveBeenCalled();
  });

  test("the two are told apart exactly, not guessed at", () => {
    class Implicit extends Job {}
    class Explicit extends Job {
      static name = "Explicit";
    }

    // A `static name = "..."` class field defines a writable own property; the
    // implicit class name is non-writable. Both report the same string, so the
    // descriptor is the only thing that separates them.
    expect(Implicit.name).toBe("Implicit");
    expect(Object.getOwnPropertyDescriptor(Implicit, "name")?.writable).toBe(
      false,
    );
    expect(Object.getOwnPropertyDescriptor(Explicit, "name")?.writable).toBe(
      true,
    );
  });
});
