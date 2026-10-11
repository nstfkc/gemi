import { afterEach, describe, expect, test } from "vitest";

import { Runs } from "../../facades/Runs";
import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { frameworkProviders } from "../../kernel/providers";
import { Repository } from "../../support/Repository";
import { ChangeFeedManager } from "../change-feed/ChangeFeedManager";
import { ChangeFeedServiceProvider } from "../change-feed/ChangeFeedServiceProvider";
import { RunManager } from "./RunManager";
import { RunsServiceProvider } from "./RunsServiceProvider";
import { MemoryRunStore } from "./RunStore";

const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.make(ChangeFeedManager).close();
});

async function makeApp(runs?: Record<string, unknown>) {
  const application = new Application(new Repository(runs ? { runs } : {}));
  application.registerMany([ChangeFeedServiceProvider, RunsServiceProvider]);
  await application.boot();
  apps.push(application);
  return application;
}

describe("RunsServiceProvider", () => {
  test("is one of the providers every app boots with", () => {
    expect(frameworkProviders).toContain(RunsServiceProvider);
  });

  test("with no app/config/runs.ts, a memory store on the app's change feed", async () => {
    const application = await makeApp();
    const manager = application.make(RunManager);
    expect(manager.store).toBeInstanceOf(MemoryRunStore);
    expect(manager.feed).toBe(application.make(ChangeFeedManager));
  });

  test("builds the manager from app/config/runs.ts, and the facade reaches it", async () => {
    const store = new MemoryRunStore();
    const application = await makeApp({ store: () => store });
    expect(application.make(RunManager).store).toBe(store);

    await kernelContext.run(application, async () => {
      const run = await Runs.create({ kind: "k", subject: "site:1" });
      const waiting = Runs.wait(run.id);
      await Runs.progress(run.id, { fraction: 0.5 });
      await Runs.complete(run.id, { ok: true });
      expect(await waiting).toMatchObject({ status: "completed", result: { ok: true } });
      expect(await Runs.list({ subject: "site:1" })).toHaveLength(1);
      expect(Runs.channel(run.id)).toBe(`gemi:run:${run.id}`);
      expect(await Runs.cursor(run.id)).toContain("=3");
      expect(store.size).toBe(1);
    });
  });
});
