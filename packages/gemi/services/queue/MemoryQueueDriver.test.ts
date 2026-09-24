import { describe, expect, test } from "vitest";

import { MemoryQueueDriver } from "./MemoryQueueDriver";
import { queueDriverContract } from "./queueDriverContract";

queueDriverContract("MemoryQueueDriver", () => new MemoryQueueDriver());

describe("MemoryQueueDriver", () => {
  test("counts what is waiting and what is leased", async () => {
    const driver = new MemoryQueueDriver();
    await driver.enqueue({ name: "A", args: "[]" });
    await driver.enqueue({ name: "B", args: "[]" });

    const [job] = await driver.claim(1, { visibilityTimeoutMs: 60_000 });

    expect(driver.waiting).toBe(1);
    expect(driver.leased).toBe(1);

    await driver.complete(job!);
    expect(driver.leased).toBe(0);
  });

  test("hands out every name, whatever the claimer has registered", async () => {
    // Nothing but this process can run what is in here, so a name it does not
    // know is known nowhere. Filtered out, the job would sit unseen until the
    // process exited; handed out, the manager dead-letters it with a line on
    // stderr that says why.
    const driver = new MemoryQueueDriver();
    await driver.enqueue({ name: "Unknown", args: "[]" });

    const claimed = await driver.claim(1, {
      visibilityTimeoutMs: 60_000,
      registered: { names: [], graceMs: Infinity },
    });

    expect(claimed).toMatchObject([{ name: "Unknown" }]);
  });

  test("hands out copies, so editing one cannot move the record", async () => {
    const driver = new MemoryQueueDriver();
    await driver.enqueue({ name: "A", args: "[]" });
    const [job] = await driver.claim(1, { visibilityTimeoutMs: 60_000 });

    job!.attempt = 99;
    await driver.complete(job!);

    // Refused as a stale claim, because the record still says attempt 1.
    expect(driver.leased).toBe(1);
  });
});
