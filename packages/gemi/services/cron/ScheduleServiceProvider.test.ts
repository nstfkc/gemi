import { afterEach, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { Repository } from "../../support/Repository";
import { CronJob } from "./CronJob";

class Nightly extends CronJob {
  static name = "Nightly";
  cron = "@daily";
  callback() {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("a skipped schedule under vitest says so once per process (#1342)", async () => {
  vi.stubEnv("GEMI_SCHEDULE", undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const cron = vi.spyOn(Bun, "cron");
  // A fresh module, so this test does not depend on another having booted one.
  vi.resetModules();
  const { ScheduleServiceProvider } = await import("./ScheduleServiceProvider");
  const boot = async (jobs: Array<new () => CronJob>) => {
    const application = new Application(new Repository({ schedule: { jobs } }));
    application.registerMany([ScheduleServiceProvider]);
    await application.boot();
  };

  await boot([]);
  expect(warn).not.toHaveBeenCalled();
  await boot([Nightly]);
  await boot([Nightly]);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]![0]).toContain("GEMI_SCHEDULE=1");
  expect(cron).not.toHaveBeenCalled();
});
