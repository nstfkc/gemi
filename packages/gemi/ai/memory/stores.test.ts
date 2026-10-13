import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import {
  type AgentMemoryStore,
  InMemoryAgentMemoryStore,
  type NewAgentMemoryRecord,
  newMemoryId,
} from "./AgentMemoryStore";
import { DatabaseAgentMemoryStore } from "./DatabaseAgentMemoryStore";

/**
 * What every `AgentMemoryStore` must do (#936), run against the in-memory
 * store and `DatabaseAgentMemoryStore` on SQLite always, and on Postgres and
 * MySQL when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set (CI's
 * `queue-databases` job sets both). Each test gets a table of its own.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

type Backend = {
  name: string;
  /** A store, and a second one on another connection to the same table. */
  prepare(): Promise<{ store: AgentMemoryStore; other: AgentMemoryStore }>;
};

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const suffix = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

const memory: Backend = {
  name: "memory",
  async prepare() {
    const store = new InMemoryAgentMemoryStore();
    return { store, other: store };
  },
};

const sqlite: Backend = {
  name: "sqlite",
  async prepare() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-agent-memories-"));
    const url = `sqlite://${join(dir, "memories.db")}`;
    const first = new SQL(url);
    const second = new SQL(url);
    const store = new DatabaseAgentMemoryStore({ sql: first, dialect: "sqlite" });
    await store.createTable();
    // Twice: `IF NOT EXISTS` all the way down.
    await store.createTable();
    disposers.push(async () => {
      await Promise.all([first.close(), second.close()]);
      rmSync(dir, { recursive: true, force: true });
    });
    return { store, other: new DatabaseAgentMemoryStore({ sql: second, dialect: "sqlite" }) };
  },
};

function server(name: string, dialect: Dialect, url: string): Backend {
  return {
    name,
    async prepare() {
      // Mixed case: a statement that forgot to quote would miss the table.
      const table = `AgentMemories_${suffix()}`;
      const first = new SQL(url);
      const second = new SQL(url);
      const store = new DatabaseAgentMemoryStore({ sql: first, dialect }, { table });
      await store.createTable();
      await store.createTable();
      const quoted = dialect === "mysql" || dialect === "mariadb" ? `\`${table}\`` : `"${table}"`;
      disposers.push(async () => {
        await first.unsafe(`DROP TABLE IF EXISTS ${quoted}`);
        await Promise.all([first.close(), second.close()]);
      });
      return { store, other: new DatabaseAgentMemoryStore({ sql: second, dialect }, { table }) };
    },
  };
}

const backends: Backend[] = [
  memory,
  sqlite,
  ...(POSTGRES_URL ? [server("postgres", "postgres", POSTGRES_URL)] : []),
  ...(MYSQL_URL ? [server("mysql", "mysql", MYSQL_URL)] : []),
];

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DatabaseAgentMemoryStore on the servers this run has no URL for", () => {
    test.skip(
      `postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
        `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}`,
      () => {},
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newMemory(overrides: Partial<NewAgentMemoryRecord> = {}): NewAgentMemoryRecord {
  return {
    id: newMemoryId(),
    scope: "project:1",
    kind: "fact",
    content: "Open Tue–Sun 8–16, Ünïcode ✓.",
    tags: ["hours", "café"],
    source: { by: "agent", agent: "site", runId: "run_1", threadId: "t1", messageId: "m1" },
    ...overrides,
  };
}

for (const backend of backends) {
  describe(`AgentMemoryStore conformance on ${backend.name}`, () => {
    test("adds, reads back and lists a scope's memories oldest first", async () => {
      const { store } = await backend.prepare();
      const first = await store.upsert(newMemory({ pinned: true }));
      expect(first.action).toBe("added");
      expect(first.record).toMatchObject({
        scope: "project:1",
        kind: "fact",
        content: "Open Tue–Sun 8–16, Ünïcode ✓.",
        key: null,
        tags: ["hours", "café"],
        pinned: true,
        version: 1,
        lastUsedAt: null,
        expiresAt: null,
        source: { by: "agent", agent: "site", runId: "run_1", threadId: "t1", messageId: "m1" },
      });
      expect(Math.abs(first.record.createdAt - Date.now())).toBeLessThan(60_000);
      expect(first.record.updatedAt).toBe(first.record.createdAt);

      await sleep(3);
      const second = await store.upsert(newMemory({ kind: "preference", content: "Second." }));
      await store.upsert(newMemory({ scope: "project:2", content: "Elsewhere." }));
      await store.upsert(newMemory({ scope: "user:1", content: "The user." }));

      expect((await store.list(["project:1"])).map((m) => m.id)).toEqual([
        first.record.id,
        second.record.id,
      ]);
      expect((await store.list(["project:1", "user:1"])).map((m) => m.content)).toEqual([
        "Open Tue–Sun 8–16, Ünïcode ✓.",
        "Second.",
        "The user.",
      ]);
      expect(await store.get(first.record.id)).toEqual(first.record);
      expect(await store.get("mem_nope")).toBeNull();
      expect(await store.list([])).toEqual([]);
      expect(await store.count("project:1")).toBe(2);
      expect(await store.count("nobody")).toBe(0);
    });

    test("filters by kind and tag, limits, and pages with `after`", async () => {
      const { store } = await backend.prepare();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { record } = await store.upsert(
          newMemory({
            content: `Memory ${i}.`,
            kind: i % 2 === 0 ? "fact" : "preference",
            tags: i < 2 ? ["pictures"] : ["copy"],
          }),
        );
        ids.push(record.id);
      }
      expect((await store.list(["project:1"], { kinds: ["preference"] })).map((m) => m.id)).toEqual([
        ids[1],
        ids[3],
      ]);
      expect(await store.list(["project:1"], { kinds: [] })).toEqual([]);
      expect((await store.list(["project:1"], { tags: ["pictures"] })).map((m) => m.id)).toEqual([
        ids[0],
        ids[1],
      ]);
      expect(
        (await store.list(["project:1"], { tags: ["copy"], limit: 2 })).map((m) => m.id),
      ).toEqual([ids[2], ids[3]]);
      const page1 = await store.list(["project:1"], { limit: 2 });
      const page2 = await store.list(["project:1"], { limit: 2, after: page1[1]!.id });
      const page3 = await store.list(["project:1"], { limit: 2, after: page2[1]!.id });
      expect([...page1, ...page2, ...page3].map((m) => m.id)).toEqual(ids);
    });

    test("a keyed write replaces the memory at its key, or answers unchanged", async () => {
      const { store } = await backend.prepare();
      const first = await store.upsert(
        newMemory({ key: "business.hours", content: "Open 8–16." }),
      );
      expect(first.action).toBe("added");
      const same = await store.upsert(newMemory({ key: "business.hours", content: "Open 8–16." }));
      expect(same).toMatchObject({ action: "unchanged", record: { id: first.record.id, version: 1 } });

      const changed = await store.upsert(
        newMemory({ key: "business.hours", content: "Open 9–17.", pinned: true, tags: [] }),
      );
      expect(changed.action).toBe("updated");
      expect(changed.record).toMatchObject({
        id: first.record.id,
        key: "business.hours",
        content: "Open 9–17.",
        pinned: true,
        tags: [],
        version: 2,
      });
      // Another scope's slot of the same name is another memory.
      const other = await store.upsert(
        newMemory({ scope: "project:2", key: "business.hours", content: "Theirs." }),
      );
      expect(other.action).toBe("added");
      expect(await store.list(["project:1"])).toHaveLength(1);
    });

    test("two keyed writes racing on one slot from two connections leave one memory", async () => {
      const { store, other } = await backend.prepare();
      const results = await Promise.all([
        store.upsert(newMemory({ key: "brand.voice", content: "Warm." })),
        other.upsert(newMemory({ key: "brand.voice", content: "Plain." })),
        store.upsert(newMemory({ key: "brand.voice", content: "Cheeky." })),
      ]);
      expect(results.filter((result) => result.action === "added")).toHaveLength(1);
      const memories = await store.list(["project:1"]);
      expect(memories).toHaveLength(1);
      expect(memories[0]!.version).toBe(1 + results.filter((r) => r.action === "updated").length);
    });

    test("update is compare-and-set on the version", async () => {
      const { store } = await backend.prepare();
      const { record } = await store.upsert(newMemory());
      expect(await store.update(record.id, { content: "Stale." }, 2)).toBeNull();
      const updated = await store.update(
        record.id,
        { content: "Changed.", pinned: true, tags: ["x"], key: "slot", expiresAt: 4_102_444_800_000 },
        1,
      );
      expect(updated).toMatchObject({
        content: "Changed.",
        pinned: true,
        tags: ["x"],
        key: "slot",
        version: 2,
        expiresAt: 4_102_444_800_000,
        // Unchanged fields stay.
        kind: "fact",
        source: { by: "agent" },
      });
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
      expect((await store.update(record.id, { key: null, expiresAt: null }))!).toMatchObject({
        key: null,
        expiresAt: null,
        version: 3,
      });
      expect(await store.update("mem_nope", { content: "x" })).toBeNull();
    });

    test("deletes are hard, by id and by scope", async () => {
      const { store } = await backend.prepare();
      const a = await store.upsert(newMemory());
      const b = await store.upsert(newMemory());
      await store.upsert(newMemory({ scope: "user:1" }));
      await store.upsert(newMemory({ scope: "user:1" }));
      expect(await store.delete([a.record.id, a.record.id, "mem_nope"])).toBe(1);
      expect(await store.delete([])).toBe(0);
      expect(await store.get(a.record.id)).toBeNull();
      expect(await store.get(b.record.id)).not.toBeNull();
      expect(await store.deleteScope("user:1")).toBe(2);
      expect(await store.deleteScope("user:1")).toBe(0);
      expect(await store.list(["user:1"], { includeExpired: true })).toEqual([]);
    });

    test("expired memories are not listed or counted, and prune deletes them", async () => {
      const { store } = await backend.prepare();
      const gone = await store.upsert(newMemory({ expiresAt: Date.now() - 60_000 }));
      const live = await store.upsert(newMemory({ expiresAt: Date.now() + 3_600_000 }));
      expect((await store.list(["project:1"])).map((m) => m.id)).toEqual([live.record.id]);
      expect(
        (await store.list(["project:1"], { includeExpired: true })).map((m) => m.id),
      ).toEqual([gone.record.id, live.record.id]);
      expect(await store.count("project:1")).toBe(1);
      expect(await store.prune!(Date.now())).toBe(1);
      expect(await store.get(gone.record.id)).toBeNull();
    });

    test("search ranks the scopes' memories by keyword", async () => {
      const { store } = await backend.prepare();
      await store.upsert(newMemory({ content: "Never use stock photos of people.", tags: [] }));
      await store.upsert(newMemory({ content: "The terrace seats twenty.", tags: [] }));
      await store.upsert(
        newMemory({ scope: "project:2", content: "Stock photos are fine here.", tags: [] }),
      );
      const found = await store.search(["project:1"], "stock photos");
      expect(found.map((m) => m.content)).toEqual(["Never use stock photos of people."]);
      expect(await store.search(["project:1"], "nothing")).toEqual([]);
      expect(await store.search(["project:1"], "terrace", { kinds: ["preference"] })).toEqual([]);
    });

    test("touch stamps lastUsedAt", async () => {
      const { store } = await backend.prepare();
      const { record } = await store.upsert(newMemory());
      await store.touch!([record.id], 1_700_000_000_000);
      expect((await store.get(record.id))!.lastUsedAt).toBe(1_700_000_000_000);
    });
  });
}

describe("DatabaseAgentMemoryStore", () => {
  test("refuses a table name that is not a plain identifier", () => {
    expect(
      () =>
        new DatabaseAgentMemoryStore(
          { sql: {} as SQL, dialect: "sqlite" },
          { table: 'memories"; DROP TABLE users; --' },
        ),
    ).toThrow(/plain identifier/);
  });
});
