import { expect, test } from "vitest";

import type { ChangeFeedDriver } from "./ChangeFeedDriver";

/**
 * What every `ChangeFeedDriver` promises, run against each by its own test
 * file. `make` builds a fresh, empty driver keeping `retain` entries per
 * channel.
 */
export function changeFeedDriverContract(
  label: string,
  make: (retain: number) => Promise<ChangeFeedDriver>,
) {
  test(`${label}: seqs count up per channel from 1`, async () => {
    const driver = await make(100);
    expect(await driver.publish("a", { n: 1 })).toBe(1);
    expect(await driver.publish("a", { n: 2 })).toBe(2);
    expect(await driver.publish("b", null)).toBe(1);
    expect(await driver.heads(["a", "b", "never"])).toEqual(
      new Map([
        ["a", 2],
        ["b", 1],
        ["never", 0],
      ]),
    );
  });

  test(`${label}: reads entries after a seq, oldest first, up to a limit`, async () => {
    const driver = await make(100);
    for (let n = 1; n <= 5; n++) await driver.publish("a", { n, nested: { list: [n] } });
    expect(await driver.read("a", 1, 2)).toEqual({
      entries: [
        { seq: 2, data: { n: 2, nested: { list: [2] } } },
        { seq: 3, data: { n: 3, nested: { list: [3] } } },
      ],
      head: 5,
      gap: false,
    });
    expect(await driver.read("a", 5, 10)).toEqual({ entries: [], head: 5, gap: false });
    expect(await driver.read("never", 0, 10)).toEqual({ entries: [], head: 0, gap: false });
  });

  test(`${label}: keeps data as JSON, and nothing as null`, async () => {
    const driver = await make(100);
    await driver.publish("a", "text");
    await driver.publish("a", 7);
    await driver.publish("a", null);
    await driver.publish("a", { at: "2026-10-05", ok: true });
    const { entries } = await driver.read("a", 0, 10);
    expect(entries.map((entry) => entry.data)).toEqual([
      "text",
      7,
      null,
      { at: "2026-10-05", ok: true },
    ]);
  });

  test(`${label}: a seq older than what is kept is a gap`, async () => {
    const driver = await make(3);
    for (let n = 1; n <= 6; n++) await driver.publish("a", n);
    expect(await driver.read("a", 2, 10)).toEqual({ entries: [], head: 6, gap: true });
    expect(await driver.read("a", 3, 10)).toEqual({
      entries: [
        { seq: 4, data: 4 },
        { seq: 5, data: 5 },
        { seq: 6, data: 6 },
      ],
      head: 6,
      gap: false,
    });
  });

  test(`${label}: a seq ahead of the head is a gap`, async () => {
    const driver = await make(10);
    await driver.publish("a", 1);
    expect(await driver.read("a", 9, 10)).toEqual({ entries: [], head: 1, gap: true });
    expect(await driver.read("never", 3, 10)).toEqual({ entries: [], head: 0, gap: true });
  });

  test(`${label}: concurrent publishes to one channel get distinct seqs`, async () => {
    const driver = await make(100);
    const seqs = await Promise.all(Array.from({ length: 20 }, (_, n) => driver.publish("a", n)));
    expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    const { entries } = await driver.read("a", 0, 100);
    expect(entries.map((entry) => entry.seq)).toEqual(seqs.slice().sort((x, y) => x - y));
  });
}
