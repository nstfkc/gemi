import { describe, expect, test } from "vitest";

import { ChangeFeed } from "../../facades/ChangeFeed";
import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { frameworkProviders } from "../../kernel/providers";
import { Repository } from "../../support/Repository";
import { ChangeFeedManager } from "./ChangeFeedManager";
import { ChangeFeedServiceProvider } from "./ChangeFeedServiceProvider";
import { MemoryChangeFeedDriver } from "./MemoryChangeFeedDriver";

async function makeApp(changeFeed: Record<string, unknown> = {}) {
  const application = new Application(new Repository({ changeFeed }));
  application.registerMany([ChangeFeedServiceProvider]);
  await application.boot();
  return application;
}

describe("ChangeFeedServiceProvider", () => {
  test("is one of the providers every app boots with", () => {
    expect(frameworkProviders).toContain(ChangeFeedServiceProvider);
  });

  test("builds the manager from app/config/changeFeed.ts, and the facade reaches it", async () => {
    const driver = new MemoryChangeFeedDriver();
    const application = await makeApp({ driver: () => driver, batchSize: 7 });
    const manager = application.make(ChangeFeedManager);
    expect(manager.driver).toBe(driver);
    expect(manager.config.batchSize).toBe(7);

    await kernelContext.run(application, async () => {
      const subscription = ChangeFeed.subscribe("site:1");
      await subscription.ready();
      expect(await ChangeFeed.publish("site:1", { pages: ["/"] })).toBe(1);
      expect((await subscription.next()).value).toMatchObject({ seq: 1, data: { pages: ["/"] } });
      expect(await ChangeFeed.head("site:1")).toBe(1);
      expect(await ChangeFeed.cursor(["site:1", "site:2"])).toBe("site%3A1=1&site%3A2=0");
    });
  });

  test("shutdown ends every subscription", async () => {
    const application = await makeApp();
    const subscription = application.make(ChangeFeedManager).subscribe("a");
    const next = subscription.next();
    await application.shutdown({ timeoutMs: 1_000 });
    expect(await next).toEqual({ done: true, value: undefined });
  });

  test("an unknown driver name fails with the slice it came from", async () => {
    const application = await makeApp({ driver: "redis" });
    expect(() => application.make(ChangeFeedManager)).toThrow(/Unknown change feed driver "redis"/);
  });
});
