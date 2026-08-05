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
import { discoverCronJobs, discoverJobs } from "./discovery";
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

/**
 * Boots an application holding nothing but the provider under test, the way
 * `RateLimitMiddleware.test.ts` does — a real container, so the register/boot
 * split the override rule depends on is the real one.
 */
async function boot(
  config: ConfigItems,
  Provider: typeof QueueServiceProvider | typeof ScheduleServiceProvider,
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
