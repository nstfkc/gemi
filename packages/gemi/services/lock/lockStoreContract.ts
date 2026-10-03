import { describe, expect, test } from "vitest";

import { LockLostError, type LockStore } from "./LockStore";

/**
 * What every `LockStore` promises, run by each store's test file against
 * itself. `open` returns a fresh, empty storage; `store()` hands out a store
 * over it, and for a database a new client each time, so "two processes" is
 * two clients on one database. Not a `*.test.ts` file, so vitest only runs it
 * through those files.
 */
export function lockStoreContract(
  name: string,
  open: () => Promise<{ store(): LockStore; dispose(): Promise<void> }>,
) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe(`${name} (LockStore contract)`, () => {
    async function storage() {
      const opened = await open();
      return opened;
    }

    async function each(fn: (s: { store(): LockStore }) => Promise<void>) {
      const s = await storage();
      try {
        await fn(s);
      } finally {
        await s.dispose();
      }
    }

    test("one holder at a time, with a token that grows per holder", () =>
      each(async (s) => {
        const a = s.store();
        const b = s.store();
        expect(await a.acquire("report", "a", 60_000)).toBe(1);
        expect(await b.acquire("report", "b", 60_000)).toBeNull();
        expect(await b.holder("report")).toEqual({ owner: "a", token: 1 });
        expect(await b.held("report", "a", 1)).toBe(true);

        expect(await b.release("report", "b")).toBe(false);
        expect(await a.release("report", "a", 2)).toBe(false);
        expect(await a.release("report", "a", 1)).toBe(true);
        expect(await a.holder("report")).toBeNull();

        expect(await b.acquire("report", "b", 60_000)).toBe(2);
        expect(await a.acquire("other", "a", 60_000)).toBe(1);
      }));

    test("a lapsed lease is taken over, and its old holder is fenced out", () =>
      each(async (s) => {
        const old = s.store();
        const next = s.store();
        const token = (await old.acquire("job", "old", 150))!;
        await sleep(300);

        expect(await old.held("job", "old", token)).toBe(false);
        // Lapsed is lost, even before anyone takes it: no renewing back in.
        expect(await old.extend("job", "old", token, 60_000)).toBe(false);

        const newer = await next.acquire("job", "new", 60_000);
        expect(newer).toBeGreaterThan(token);

        expect(await old.release("job", "old", token)).toBe(false);
        await expect(old.fence("job", "old", token, async () => "written")).rejects.toBeInstanceOf(
          LockLostError,
        );
        expect(await next.holder("job")).toEqual({ owner: "new", token: newer });
      }));

    test("extending keeps the lock past its first lease", () =>
      each(async (s) => {
        const a = s.store();
        const token = (await a.acquire("long", "a", 300))!;
        for (let i = 0; i < 4; i++) {
          await sleep(100);
          expect(await a.extend("long", "a", token, 300)).toBe(true);
          // Twice in a row, which can land in one millisecond.
          expect(await a.extend("long", "a", token, 300)).toBe(true);
        }
        expect(await s.store().acquire("long", "b", 300)).toBeNull();
      }));

    test("concurrent acquires from many clients: exactly one wins", () =>
      each(async (s) => {
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => s.store().acquire("race", `owner-${i}`, 60_000)),
        );
        expect(results.filter((token) => token !== null)).toEqual([1]);
      }));

    test("advance raises a counter once per value, across clients", () =>
      each(async (s) => {
        const a = s.store();
        expect(await a.advance("tick", 5)).toBe(true);
        expect(await a.advance("tick", 5)).toBe(false);
        expect(await a.advance("tick", 4)).toBe(false);
        const raced = await Promise.all(
          Array.from({ length: 8 }, () => s.store().advance("tick", 6)),
        );
        expect(raced.filter(Boolean)).toHaveLength(1);
      }));

    test("fence runs only for the current holder and holds off a takeover until it ends", () =>
      each(async (s) => {
        const holder = s.store();
        const token = (await holder.acquire("fenced", "a", 250))!;
        expect(await holder.fence("fenced", "a", token, async () => 42)).toBe(42);

        let fenceEnded = 0;
        let takenAt = 0;
        let taken: number | null = null;
        const fence = holder.fence("fenced", "a", token, async () => {
          // Past the lease, while the fence is still open.
          await sleep(450);
          fenceEnded = performance.now();
        });
        await sleep(330);
        const takeover = s
          .store()
          .acquire("fenced", "b", 60_000)
          .then(
            (result) => {
              taken = result;
              takenAt = performance.now();
            },
            // Refused outright also keeps the fence intact. SQLite in one
            // process does this: Bun waits out the file lock on the JS
            // thread, so the fence cannot finish while the takeover waits,
            // and the takeover gives up at its busy timeout.
            () => {},
          );
        await Promise.all([fence, takeover]);

        // Either the takeover waited for the fence (the database stores, whose
        // row lock it queues on) or it was refused (the memory store).
        if (taken !== null) expect(takenAt).toBeGreaterThanOrEqual(fenceEnded);
        // Once the fence is done, the lapsed lock is free.
        const after = taken ?? (await s.store().acquire("fenced", "b", 60_000));
        expect(after).toBeGreaterThan(token);
      }));

    test("hit counts a fixed window, refuses past the limit, and resets", () =>
      each(async (s) => {
        const a = s.store();
        expect(await a.hit("budget", 2, 300)).toMatchObject({ allowed: true });
        expect(await s.store().hit("budget", 2, 300)).toMatchObject({ allowed: true });
        const refused = await a.hit("budget", 2, 300);
        expect(refused.allowed).toBe(false);
        expect(refused.resetInMs).toBeGreaterThan(0);
        expect(refused.resetInMs).toBeLessThanOrEqual(300);

        await a.refund("budget");
        expect(await a.hit("budget", 2, 300)).toMatchObject({ allowed: true });
        expect(await a.hit("budget", 2, 300)).toMatchObject({ allowed: false });

        await sleep(400);
        expect(await a.hit("budget", 2, 300)).toMatchObject({ allowed: true });
      }));

    test("concurrent hits from many clients never exceed the limit", () =>
      each(async (s) => {
        const results = await Promise.all(
          Array.from({ length: 12 }, () => s.store().hit("race-budget", 5, 60_000)),
        );
        expect(results.filter((r) => r.allowed)).toHaveLength(5);
      }));
  });
}
