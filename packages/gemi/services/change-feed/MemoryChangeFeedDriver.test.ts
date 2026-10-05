import { describe, expect, test } from "vitest";

import { changeFeedDriverContract } from "./changeFeedDriverContract";
import { MemoryChangeFeedDriver } from "./MemoryChangeFeedDriver";

describe("MemoryChangeFeedDriver", () => {
  changeFeedDriverContract("memory", async (retain) => new MemoryChangeFeedDriver({ retain }));

  test("keeps a copy, so the publisher changing its object later changes nothing", async () => {
    const driver = new MemoryChangeFeedDriver();
    const data = { pages: ["/"] };
    await driver.publish("a", data);
    data.pages.push("/about");
    expect((await driver.read("a", 0, 1)).entries[0]!.data).toEqual({ pages: ["/"] });
  });

  test("refuses a retain that is not a positive whole number", () => {
    expect(() => new MemoryChangeFeedDriver({ retain: 0 })).toThrow(/retain/);
  });
});
