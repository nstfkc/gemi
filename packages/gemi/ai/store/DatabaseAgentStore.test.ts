process.env.SECRET ??= "database-agent-store-test-secret";

import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import { HttpRequest } from "../../http/HttpRequest";
import { withTransaction } from "../../orm/context";
import { Agent } from "../Agent";
import { AgentController, MemoryLiveRuns } from "../AgentController";
import type { ThreadSummary } from "../contextCompaction";
import { fakeProvider } from "../providers/fakeProvider";
import type { AgentMessage } from "../types";
import {
  createAgentStoreTableStatements,
  DatabaseAgentStore,
  type DatabaseAgentStoreOptions,
} from "./DatabaseAgentStore";

/**
 * The database thread store (#1063), against SQLite always and against
 * Postgres and MySQL when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set.
 * Each test gets tables of its own.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

type Database = {
  dialect: Dialect;
  connect(): SQL;
  store(sql?: SQL, name?: string, options?: DatabaseAgentStoreOptions): DatabaseAgentStore;
  dispose(): Promise<void>;
};

type Backend = { name: string; dialect: Dialect; prepare(): Promise<Database> };

const suffix = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

function database(
  dialect: Dialect,
  url: string,
  tables: { threadsTable?: string; messagesTable?: string },
  cleanup: (first: SQL) => Promise<void>,
): () => Promise<Database> {
  return async () => {
    const clients: SQL[] = [];
    const connect = () => {
      const client = new SQL(url);
      clients.push(client);
      return client;
    };
    const first = connect();
    const store = (sql = first, name?: string, options: DatabaseAgentStoreOptions = {}) =>
      new DatabaseAgentStore({ sql, dialect, ...(name ? { name } : {}) }, { ...tables, ...options });
    await store().createTable();
    return {
      dialect,
      connect,
      store,
      async dispose() {
        await cleanup(first);
        await Promise.all(clients.map((client) => client.close()));
      },
    };
  };
}

const sqlite: Backend = {
  name: "sqlite",
  dialect: "sqlite",
  prepare() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-agent-store-"));
    return database("sqlite", `sqlite://${join(dir, "threads.db")}`, {}, async () => {
      rmSync(dir, { recursive: true, force: true });
    })();
  },
};

function server(name: string, dialect: Dialect, url: string): Backend {
  return {
    name,
    dialect,
    prepare() {
      // Mixed case: a statement that forgot to quote would miss the table.
      const threadsTable = `AgentThreads_${suffix()}`;
      const messagesTable = `AgentMessages_${suffix()}`;
      const quote = (table: string) =>
        dialect === "mysql" || dialect === "mariadb" ? `\`${table}\`` : `"${table}"`;
      return database(dialect, url, { threadsTable, messagesTable }, async (first) => {
        await first.unsafe(`DROP TABLE IF EXISTS ${quote(messagesTable)}`);
        await first.unsafe(`DROP TABLE IF EXISTS ${quote(threadsTable)}`);
      })();
    },
  };
}

const backends: Backend[] = [
  sqlite,
  ...(POSTGRES_URL ? [server("postgres", "postgres", POSTGRES_URL)] : []),
  ...(MYSQL_URL ? [server("mysql", "mysql", MYSQL_URL)] : []),
];

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DatabaseAgentStore on the servers this run has no URL for", () => {
    test("is reported", () => {
      console.warn(
        `DatabaseAgentStore: postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
          `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}.`,
      );
    });
  });
}

const message = (id: string, role: AgentMessage["role"], text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
  ...extra,
});

const summary = (cutMessageId: string, text = "summary"): ThreadSummary => ({
  cutMessageId,
  text,
  turns: 1,
  messages: 2,
  fingerprint: `fp-${cutMessageId}`,
  createdAt: new Date(0).toISOString(),
});

for (const backend of backends) {
  describe(`DatabaseAgentStore on ${backend.name}`, () => {
    let db: Database;
    let store: DatabaseAgentStore;

    beforeEach(async () => {
      db = await backend.prepare();
      store = db.store();
    });
    afterEach(async () => {
      await db.dispose();
    });

    test("a new thread is empty, and an unknown one is null", async () => {
      const { threadId } = await store.createThread({ userId: 7 });
      expect(await store.loadThread(threadId)).toEqual([]);
      expect(await store.loadThread("nope")).toBeNull();
      expect(await store.getThread(threadId)).toMatchObject({ id: threadId, userId: "7", title: null });
    });

    test("appends in order and keeps the whole message", async () => {
      const { threadId } = await store.createThread({});
      const assistant = message("a1", "assistant", "hello", {
        finishReason: "awaiting-input",
        pending: [{ toolCallId: "c1", name: "x", input: { n: 1 }, kind: "approval", signature: "sig" }],
        usage: { inputTokens: 1, outputTokens: 2 },
      });
      await store.appendMessages(threadId, [message("u1", "user", "hi")]);
      await store.appendMessages(threadId, [assistant, message("u2", "user", "again")]);
      expect(await store.loadThread(threadId)).toEqual([message("u1", "user", "hi"), assistant, message("u2", "user", "again")]);
    });

    test("upserts by id, in place, however many times a message is written", async () => {
      const { threadId } = await store.createThread({});
      await store.appendMessages(threadId, [message("u1", "user", "hi"), message("a1", "assistant", "")]);
      await store.appendMessages(threadId, [message("a1", "assistant", "hel")]);
      await store.appendMessages(threadId, [message("a1", "assistant", "hello", { finishReason: "stop" })]);
      await store.appendMessages(threadId, [message("u2", "user", "next"), message("a1", "assistant", "hello!")]);
      // The same id twice in one batch: the last one wins.
      await store.appendMessages(threadId, [message("a2", "assistant", "x"), message("a2", "assistant", "y")]);
      const thread = await store.loadThread(threadId);
      expect(thread!.map((m) => [m.id, (m.content[0] as { text: string }).text])).toEqual([
        ["u1", "hi"],
        ["a1", "hello!"],
        ["u2", "next"],
        ["a2", "y"],
      ]);
    });

    test("refuses to append to a thread it does not have", async () => {
      await expect(store.appendMessages("nope", [message("u1", "user", "hi")])).rejects.toThrow(
        /does not exist/,
      );
      await expect(store.appendMessages("nope", [])).rejects.toThrow(/does not exist/);
      expect(await store.loadThread("nope")).toBeNull();
    });

    test("removes messages, ignoring ids it does not hold, and appends after them", async () => {
      const { threadId } = await store.createThread({});
      await store.appendMessages(threadId, [
        message("u1", "user", "a"),
        message("a1", "assistant", "b"),
        message("u2", "user", "c"),
        message("a2", "assistant", "d"),
      ]);
      await store.removeMessages(threadId, ["u2", "a2", "zzz"]);
      await store.appendMessages(threadId, [message("u3", "user", "e")]);
      expect((await store.loadThread(threadId))!.map((m) => m.id)).toEqual(["u1", "a1", "u3"]);
    });

    test("the title is the first user message's text, set once", async () => {
      const { threadId } = await store.createThread({ userId: "u" });
      await store.appendMessages(threadId, [message("a0", "assistant", "welcome")]);
      expect((await store.getThread(threadId))!.title).toBeNull();
      await store.appendMessages(threadId, [message("u1", "user", `  how   many ${"x".repeat(200)}`)]);
      await store.appendMessages(threadId, [message("u2", "user", "second")]);
      const title = (await store.getThread(threadId))!.title!;
      expect(title.startsWith("how many x")).toBe(true);
      expect(title).toHaveLength(100);
      expect(title.endsWith("…")).toBe(true);
    });

    test("an event message (#1181) is not the title", async () => {
      const { threadId } = await store.createThread({ userId: "u" });
      await store.appendMessages(threadId, [
        { ...message("e1", "user", "The export finished."), event: { name: "job-settled" } },
      ]);
      expect((await store.getThread(threadId))!.title).toBeNull();
      await store.appendMessages(threadId, [message("u1", "user", "rename the page")]);
      expect((await store.getThread(threadId))!.title).toBe("rename the page");
      expect((await store.loadThread(threadId))![0]!.event).toEqual({ name: "job-settled" });
    });

    test("lists threads newest first, per user, and pages", async () => {
      const a = await store.createThread({ userId: 1 });
      const b = await store.createThread({ userId: 1 });
      const c = await store.createThread({ userId: 2 });
      const anonymous = await store.createThread({});
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.appendMessages(a.threadId, [message("u1", "user", "latest")]);

      const mine = await store.listThreads({ userId: 1 });
      expect(mine.map((t) => t.id)).toEqual([a.threadId, b.threadId]);
      expect(mine[0]!.title).toBe("latest");
      expect((await store.listThreads({ userId: "2" })).map((t) => t.id)).toEqual([c.threadId]);
      expect((await store.listThreads({ userId: null })).map((t) => t.id)).toEqual([anonymous.threadId]);
      expect(await store.listThreads()).toHaveLength(4);
      expect((await store.listThreads({ userId: 1, limit: 1, offset: 1 })).map((t) => t.id)).toEqual([
        b.threadId,
      ]);
    });

    test("deleteThread drops the thread, its messages and its summaries", async () => {
      const { threadId } = await store.createThread({});
      await store.appendMessages(threadId, [message("u1", "user", "hi")]);
      await store.saveSummary(threadId, summary("u1"));
      await store.deleteThread(threadId);
      expect(await store.loadThread(threadId)).toBeNull();
      expect(await store.loadSummaries(threadId)).toEqual([]);
      expect(await store.getThread(threadId)).toBeNull();
      // A new thread with a message of the same id is unaffected.
      const other = await store.createThread({});
      await store.appendMessages(other.threadId, [message("u1", "user", "hi")]);
      expect(await store.loadThread(other.threadId)).toHaveLength(1);
    });

    test("one message id in two threads is two messages", async () => {
      const one = await store.createThread({});
      const two = await store.createThread({});
      await store.appendMessages(one.threadId, [message("m", "user", "one")]);
      await store.appendMessages(two.threadId, [message("m", "user", "two")]);
      expect((await store.loadThread(one.threadId))![0]!.content).toEqual([{ type: "text", text: "one" }]);
      expect((await store.loadThread(two.threadId))![0]!.content).toEqual([{ type: "text", text: "two" }]);
    });

    test("summaries: upsert by cut, newest first, at most eight, none for a missing thread", async () => {
      const { threadId } = await store.createThread({});
      expect(await store.loadSummaries(threadId)).toEqual([]);
      await store.saveSummary(threadId, summary("m1", "first"));
      await store.saveSummary(threadId, summary("m2"));
      await store.saveSummary(threadId, summary("m1", "again"));
      expect((await store.loadSummaries(threadId)).map((s) => [s.cutMessageId, s.text])).toEqual([
        ["m1", "again"],
        ["m2", "summary"],
      ]);
      for (let i = 0; i < 10; i++) await store.saveSummary(threadId, summary(`n${i}`));
      expect(await store.loadSummaries(threadId)).toHaveLength(8);
      await store.saveSummary("nope", summary("x"));
      expect(await store.loadSummaries("nope")).toEqual([]);
    });

    test("lockSummary is exclusive until released or expired", async () => {
      const { threadId } = await store.createThread({});
      const release = await store.lockSummary(threadId, "m1", 60_000);
      expect(release).toBeTypeOf("function");
      expect(await store.lockSummary(threadId, "m1", 60_000)).toBeNull();
      await release!();
      const again = await store.lockSummary(threadId, "m2", 1);
      expect(again).toBeTypeOf("function");
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The holder's ttl ran out, so it can be taken; its late release frees nothing.
      const taken = await store.lockSummary(threadId, "m3", 60_000);
      expect(taken).toBeTypeOf("function");
      await again!();
      expect(await store.lockSummary(threadId, "m3", 60_000)).toBeNull();
      expect(await store.lockSummary("nope", "m1", 60_000)).toBeNull();
    });

    test("appends from two clients to one thread keep every message and distinct positions", async () => {
      const { threadId } = await store.createThread({});
      // SQLite: one client, whose transactions take turns. Two clients on one
      // file need the app's busy timeout, which is not this store's to set.
      const other = db.dialect === "sqlite" ? store : db.store(db.connect());
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        const writer = i % 2 === 0 ? store : other;
        writes.push(writer.appendMessages(threadId, [message(`m${i}`, "user", String(i))]));
      }
      await Promise.all(writes);
      const thread = (await store.loadThread(threadId))!;
      expect(new Set(thread.map((m) => m.id)).size).toBe(10);
    });

    test("table names are checked", () => {
      expect(() => new DatabaseAgentStore({ sql: db.connect(), dialect: db.dialect }, { threadsTable: "a; drop" })).toThrow(
        /plain identifier/,
      );
    });

    test("joins the ORM transaction on its connection, and rolls back with it", async () => {
      const sql = db.connect();
      const named = db.store(sql, "default");
      const { threadId } = await named.createThread({});
      await expect(
        withTransaction(
          sql,
          async () => {
            await named.appendMessages(threadId, [message("u1", "user", "hi")]);
            throw new Error("roll back");
          },
          { connection: "default" },
        ),
      ).rejects.toThrow("roll back");
      expect(await named.loadThread(threadId)).toEqual([]);
    });

    test("an AgentController turn on a thread is stored and read back", async () => {
      const agent = Agent.create({
        name: "chat",
        provider: fakeProvider([
          { type: "text-delta", delta: "hello" },
          { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
      });
      const threadStore = store;
      class Chat extends AgentController {
        agent = agent;
        store = threadStore;
        liveRuns = new MemoryLiveRuns();
      }
      const { threadId } = await store.createThread({});
      const request = new HttpRequest(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, text: "hi there" }),
        }),
        {},
        "api",
        "/chat",
      );
      const controller = new Chat();
      const response = await controller.stream(request);
      await response.text();
      // The run's last writes land after the stream closes.
      let thread = await controller.readThread(threadId);
      for (let i = 0; i < 100 && thread![1]?.finishReason === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        thread = await controller.readThread(threadId);
      }
      expect(thread!.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(thread![1]!.content).toEqual([{ type: "text", text: "hello" }]);
      expect((await store.getThread(threadId))!.title).toBe("hi there");
    });

    // --- expiring threads (#1312) ----------------------------------------

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const rowCount = async (table: string, threadId: string, column = "id") => {
      const quoted = db.dialect === "mysql" || db.dialect === "mariadb" ? `\`${table}\`` : `"${table}"`;
      const rows = (await db.connect().unsafe(
        `SELECT COUNT(*) AS n FROM ${quoted} WHERE ${column} = '${threadId}'`,
      )) as { n: number | string }[];
      return Number(rows[0]!.n);
    };

    test("an expired thread is one the store does not have, until the sweep deletes its rows", async () => {
      const expiring = db.store(undefined, undefined, { ttlMs: 60_000 });
      const kept = await expiring.createThread({ userId: 1 });
      const gone = await expiring.createThread({ userId: 1, ttlMs: 150 });
      await expiring.appendMessages(gone.threadId, [message("u1", "user", "photo")]);
      await expiring.saveSummary(gone.threadId, summary("u1"));
      expect(await expiring.loadThread(gone.threadId)).toHaveLength(1);

      const record = (await expiring.getThread(kept.threadId))!;
      expect(record.expiresAt).toBeGreaterThanOrEqual(record.createdAt + 59_000);
      expect(record.expiresAt).toBeLessThanOrEqual(record.createdAt + 61_000);

      await sleep(300);
      expect(await expiring.loadThread(gone.threadId)).toBeNull();
      expect(await expiring.getThread(gone.threadId)).toBeNull();
      expect(await expiring.loadSummaries(gone.threadId)).toEqual([]);
      expect(await expiring.lockSummary(gone.threadId, "u1", 1000)).toBeNull();
      await expect(expiring.appendMessages(gone.threadId, [message("u2", "user", "late")])).rejects.toThrow(/does not exist/);
      expect((await expiring.listThreads({ userId: 1 })).map((t) => t.id)).toEqual([kept.threadId]);
      // Unreadable, but the rows are there until the sweep.
      expect(await rowCount(expiring.messagesTable, gone.threadId, "thread_id")).toBe(1);

      expect(await expiring.sweepExpired()).toEqual({ deleted: 1 });
      expect(await rowCount(expiring.threadsTable, gone.threadId)).toBe(0);
      expect(await rowCount(expiring.messagesTable, gone.threadId, "thread_id")).toBe(0);
      expect(await expiring.loadThread(kept.threadId)).toEqual([]);
      expect(await expiring.sweepExpired()).toEqual({ deleted: 0 });
    });

    test("a fixed expiry stays put on append; a sliding one moves with it", async () => {
      const fixed = db.store(undefined, undefined, { ttlMs: 700 });
      const sliding = db.store(undefined, undefined, { ttlMs: 700, slidingTtl: true });
      const a = await fixed.createThread({});
      const b = await sliding.createThread({});
      await sleep(450);
      await fixed.appendMessages(a.threadId, [message("u1", "user", "hi")]);
      await sliding.appendMessages(b.threadId, [message("u1", "user", "hi")]);
      await sleep(450);
      // 900 ms after creation, 450 after the append.
      expect(await fixed.loadThread(a.threadId)).toBeNull();
      expect(await sliding.loadThread(b.threadId)).toHaveLength(1);
    });

    test("expiresAt is fixed, ttlMs: null keeps a thread, and now stands in for the clock", async () => {
      const expiring = db.store(undefined, undefined, { ttlMs: 60_000, slidingTtl: true });
      const at = Date.now() + 120_000;
      const dated = await expiring.createThread({ expiresAt: new Date(at) });
      const forever = await expiring.createThread({ ttlMs: null });
      const usual = await expiring.createThread({});
      await expiring.appendMessages(dated.threadId, [message("u1", "user", "x")]);
      expect((await expiring.getThread(dated.threadId))!.expiresAt).toBe(at);
      expect((await expiring.getThread(forever.threadId))!.expiresAt).toBeNull();

      expect(await expiring.sweepExpired({ now: Date.now() + 90_000 })).toEqual({ deleted: 1 });
      expect(await expiring.getThread(usual.threadId)).toBeNull();
      expect(await expiring.sweepExpired({ now: Date.now() + 10 * 365 * 86_400_000 })).toEqual({ deleted: 1 });
      expect(await expiring.getThread(dated.threadId)).toBeNull();
      expect(await expiring.getThread(forever.threadId)).not.toBeNull();
    });

    test("the sweep takes at most limit threads, and a scope sweeps its own", async () => {
      const expiring = db.store(undefined, undefined, { ttlMs: 60_000 });
      const later = Date.now() + 120_000;
      for (let i = 0; i < 3; i++) await expiring.forScope("a").createThread({});
      const other = await expiring.forScope("b").createThread({});
      expect(await expiring.forScope("a").sweepExpired({ now: later, limit: 2 })).toEqual({ deleted: 2 });
      expect(await expiring.forScope("a").sweepExpired({ now: later })).toEqual({ deleted: 1 });
      expect(await expiring.forScope("b").getThread(other.threadId)).not.toBeNull();
      expect(await expiring.sweepExpired({ now: later })).toEqual({ deleted: 1 });
    });

    test("without ttlMs nothing expires, and a thread's own expiry is refused", async () => {
      await expect(store.createThread({ ttlMs: 1000 })).rejects.toThrow(/needs a store with `ttlMs`/);
      await expect(store.createThread({ expiresAt: Date.now() })).rejects.toThrow(/needs a store with `ttlMs`/);
      const { threadId } = await store.createThread({});
      expect(await store.sweepExpired({ now: Date.now() + 10 ** 12 })).toEqual({ deleted: 0 });
      expect(await store.getThread(threadId)).not.toHaveProperty("expiresAt");
      expect(() => db.store(undefined, undefined, { ttlMs: 0 })).toThrow(/positive/);
      const expiring = db.store(undefined, undefined, { ttlMs: 1000 });
      await expect(expiring.createThread({ ttlMs: -5 })).rejects.toThrow(/positive/);
    });

    test("an AgentController turn on an expired thread is a 404 and runs nothing", async () => {
      const expiring = db.store(undefined, undefined, { ttlMs: 60_000 });
      const agent = Agent.create({
        name: "chat",
        provider: fakeProvider([
          { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
      });
      class Chat extends AgentController {
        agent = agent;
        store = expiring;
        liveRuns = new MemoryLiveRuns();
      }
      const { threadId } = await expiring.createThread({ expiresAt: Date.now() - 1000 });
      const request = new HttpRequest(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, text: "hi" }),
        }),
        {},
        "api",
        "/chat",
      );
      const response = await new Chat().stream(request);
      expect(response.status).toBe(404);
      // Nothing was written under the dead id.
      expect(await rowCount(expiring.messagesTable, threadId, "thread_id")).toBe(0);
      expect(await new Chat().readThread(threadId)).toBeNull();
    });

    test("tables made before expiry keep working, and addExpiryColumns brings them up to date", async () => {
      const quote = (table: string) =>
        db.dialect === "mysql" || db.dialect === "mariadb" ? `\`${table}\`` : `"${table}"`;
      const sql = db.connect();
      const threadsTable = `PreExpiryThreads_${suffix()}`;
      const messagesTable = `PreExpiryMessages_${suffix()}`;
      // The tables as they were: the same DDL without the expiry columns and index.
      for (const statement of createAgentStoreTableStatements(db.dialect, threadsTable, messagesTable)) {
        if (statement.includes("expires_at_idx\" ON")) continue;
        await sql.unsafe(
          statement
            .split("\n")
            .filter((line) => !/[`"](expires_at|ttl_ms)[`"]|expires_at_idx/.test(line))
            .join("\n")
            .replace(/,(\s*\))/, "$1"),
        );
      }
      try {
        const legacy = new DatabaseAgentStore({ sql, dialect: db.dialect }, { threadsTable, messagesTable });
        const old = await legacy.createThread({});
        await legacy.appendMessages(old.threadId, [message("u1", "user", "before")]);
        expect(await legacy.loadThread(old.threadId)).toHaveLength(1);

        await legacy.addExpiryColumns();
        await legacy.addExpiryColumns(); // again: nothing to do
        const migrated = new DatabaseAgentStore(
          { sql: db.connect(), dialect: db.dialect },
          { threadsTable, messagesTable, ttlMs: 60_000 },
        );
        const fresh = await migrated.createThread({});
        await migrated.appendMessages(fresh.threadId, [message("u1", "user", "after")]);
        expect(await migrated.loadThread(fresh.threadId)).toHaveLength(1);
        // A thread from before has no expiry.
        expect((await migrated.getThread(old.threadId))!.expiresAt).toBeNull();
        expect(await migrated.sweepExpired({ now: Date.now() + 120_000 })).toEqual({ deleted: 1 });
        expect(await migrated.loadThread(old.threadId)).toHaveLength(1);
      } finally {
        await sql.unsafe(`DROP TABLE IF EXISTS ${quote(messagesTable)}`);
        await sql.unsafe(`DROP TABLE IF EXISTS ${quote(threadsTable)}`);
      }
    });

    // --- scopes (#1177) ----------------------------------------------------

    test("two scopes do not see each other's threads, and the store sees both", async () => {
      const a = store.forScope("tenant-a");
      const b = store.forScope("tenant-b");
      const one = await a.createThread({ userId: 1 });
      const two = await b.createThread({ userId: 1 });
      await a.appendMessages(one.threadId, [message("u1", "user", "a's")]);
      await b.appendMessages(two.threadId, [message("u1", "user", "b's")]);
      await a.saveSummary(one.threadId, summary("u1", "a summary"));

      // Another scope's thread is a thread it does not have.
      expect(await b.loadThread(one.threadId)).toBeNull();
      expect(await b.getThread(one.threadId)).toBeNull();
      expect(await b.loadSummaries(one.threadId)).toEqual([]);
      expect(await b.lockSummary(one.threadId, "u1", 60_000)).toBeNull();
      await expect(b.appendMessages(one.threadId, [message("x", "user", "intruder")])).rejects.toThrow(
        /does not exist/,
      );
      await expect(b.appendMessages(one.threadId, [])).rejects.toThrow(/does not exist/);
      await b.saveSummary(one.threadId, summary("x", "intruder"));
      await b.removeMessages(one.threadId, ["u1"]);
      await b.deleteThread(one.threadId);

      // ...and nothing it tried reached it.
      expect(await a.loadThread(one.threadId)).toEqual([message("u1", "user", "a's")]);
      expect((await a.loadSummaries(one.threadId)).map((s) => s.text)).toEqual(["a summary"]);
      expect((await a.getThread(one.threadId))!.title).toBe("a's");

      expect((await a.listThreads({ userId: 1 })).map((t) => t.id)).toEqual([one.threadId]);
      expect((await b.listThreads()).map((t) => t.id)).toEqual([two.threadId]);
      expect((await store.listThreads({ userId: 1 })).map((t) => t.id).sort()).toEqual(
        [one.threadId, two.threadId].sort(),
      );
      // The unscoped store's own threads are in no scope.
      const plain = await store.createThread({});
      expect(await a.loadThread(plain.threadId)).toBeNull();
      expect(await store.loadThread(one.threadId)).toHaveLength(1);

      // A scope deletes its own.
      await a.deleteThread(one.threadId);
      expect(await store.loadThread(one.threadId)).toBeNull();
      expect(await b.loadThread(two.threadId)).toHaveLength(1);
    });

    test("a scope is a non-empty string, and requireScope refuses the unscoped store", async () => {
      expect(() => store.forScope("")).toThrow(/non-empty/);
      const strict = new DatabaseAgentStore(
        { sql: db.connect(), dialect: db.dialect },
        { threadsTable: store.threadsTable, messagesTable: store.messagesTable, requireScope: true },
      );
      await expect(strict.createThread({})).rejects.toThrow(/requires a scope/);
      await expect(strict.loadThread("x")).rejects.toThrow(/requires a scope/);
      await expect(strict.appendMessages("x", [message("u1", "user", "hi")])).rejects.toThrow(
        /requires a scope/,
      );
      const scoped = strict.forScope("t");
      const { threadId } = await scoped.createThread({});
      await scoped.appendMessages(threadId, [message("u1", "user", "hi")]);
      expect(await scoped.loadThread(threadId)).toHaveLength(1);
      expect(scoped.scope).toBe("t");
    });

    test("beginScope opens every transaction a scoped view starts, reads included", async () => {
      const calls: string[] = [];
      const hooked = new DatabaseAgentStore(
        { sql: db.connect(), dialect: db.dialect },
        {
          threadsTable: store.threadsTable,
          messagesTable: store.messagesTable,
          beginScope: async (tx, scope) => {
            calls.push(scope);
            await tx`SELECT 1`;
          },
        },
      );
      const view = hooked.forScope("tenant-a");
      const { threadId } = await view.createThread({});
      await view.appendMessages(threadId, [message("u1", "user", "hi")]);
      await view.loadThread(threadId);
      await view.listThreads();
      const release = await view.lockSummary(threadId, "u1", 60_000);
      await release!();
      expect(calls.length).toBe(6);
      expect(new Set(calls)).toEqual(new Set(["tenant-a"]));
      // The unscoped store never calls it.
      await hooked.listThreads();
      expect(calls.length).toBe(6);
    });

    test("tables made before scopes keep working, and addScopeColumns brings them up to date", async () => {
      const quote = (table: string) =>
        db.dialect === "mysql" || db.dialect === "mariadb" ? `\`${table}\`` : `"${table}"`;
      const sql = db.connect();
      const threadsTable = `LegacyThreads_${suffix()}`;
      const messagesTable = `LegacyMessages_${suffix()}`;
      // The tables as they were: the same DDL without the scope columns and index.
      for (const statement of createAgentStoreTableStatements(db.dialect, threadsTable, messagesTable)) {
        if (statement.includes("scope_user_id_updated_at_idx\" ON")) continue;
        await sql.unsafe(
          statement
            .split("\n")
            .filter((line) => !/[`"]scope[`"]/.test(line))
            .join("\n"),
        );
      }
      try {
        const legacy = new DatabaseAgentStore({ sql, dialect: db.dialect }, { threadsTable, messagesTable });
        const old = await legacy.createThread({ userId: 1 });
        await legacy.appendMessages(old.threadId, [message("u1", "user", "before")]);
        expect(await legacy.loadThread(old.threadId)).toHaveLength(1);
        await expect(legacy.forScope("t").createThread({})).rejects.toThrow();

        await legacy.addScopeColumns();
        await legacy.addScopeColumns(); // again: nothing to do
        // A fresh client, as an app has after its migration: MySQL clients
        // keep the statement that failed above prepared against the old table.
        const migrated = new DatabaseAgentStore(
          { sql: db.connect(), dialect: db.dialect },
          { threadsTable, messagesTable },
        );
        const scoped = migrated.forScope("t");
        const fresh = await scoped.createThread({});
        await scoped.appendMessages(fresh.threadId, [message("u1", "user", "after")]);
        expect(await scoped.loadThread(fresh.threadId)).toHaveLength(1);
        // The old rows are in no scope: the store sees them, a scope does not.
        expect(await scoped.loadThread(old.threadId)).toBeNull();
        expect(await legacy.loadThread(old.threadId)).toHaveLength(1);
      } finally {
        await sql.unsafe(`DROP TABLE IF EXISTS ${quote(messagesTable)}`);
        await sql.unsafe(`DROP TABLE IF EXISTS ${quote(threadsTable)}`);
      }
    });

    if (backend.dialect === "postgres") {
      test("beginScope's session setting is in effect for every statement of a scoped call", async () => {
        const sql = db.connect();
        // A stand-in for a row-level security policy (which a superuser
        // bypasses): every row's scope must be the transaction's setting.
        await sql.unsafe(
          `ALTER TABLE "${store.threadsTable}" ADD CONSTRAINT "${store.threadsTable}_scope_check" CHECK (scope = coalesce(nullif(current_setting('app.current_id', true), ''), '<none>'))`,
        );
        await sql.unsafe(
          `ALTER TABLE "${store.messagesTable}" ADD CONSTRAINT "${store.messagesTable}_scope_check" CHECK (scope = coalesce(nullif(current_setting('app.current_id', true), ''), '<none>'))`,
        );
        const options = { threadsTable: store.threadsTable, messagesTable: store.messagesTable };
        const unhooked = new DatabaseAgentStore({ sql, dialect: "postgres" }, options).forScope("org-1");
        await expect(unhooked.createThread({})).rejects.toThrow();

        const hooked = new DatabaseAgentStore(
          { sql, dialect: "postgres" },
          {
            ...options,
            beginScope: (tx, scope) => tx`SELECT set_config('app.current_id', ${scope}, true)`,
          },
        ).forScope("org-1");
        const { threadId } = await hooked.createThread({});
        await hooked.appendMessages(threadId, [message("u1", "user", "hi")]);
        expect(await hooked.loadThread(threadId)).toHaveLength(1);
        // Local to each transaction: nothing leaks onto the pooled connection.
        const [row] = (await sql`SELECT current_setting('app.current_id', true) AS v`) as {
          v: string | null;
        }[];
        expect(row!.v ?? "").toBe("");
      });
    }

    test("AgentController.storeScope keeps a turn inside its scope; startTurn and readThread take one", async () => {
      const agent = Agent.create({
        name: "chat",
        provider: fakeProvider([
          { type: "text-delta", delta: "hello" },
          { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
      });
      const threadStore = store;
      class Chat extends AgentController<{ org?: string }> {
        agent = agent;
        store = threadStore;
        liveRuns = new MemoryLiveRuns();
        protected storeScope(_req: HttpRequest<any, any>, { body }: { body: { org?: string } }) {
          return body.org ?? null;
        }
      }
      const turn = (threadId: string, org: string) =>
        new Chat().stream(
          new HttpRequest(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ threadId, text: "hi there", org }),
            }),
            {},
            "api",
            "/chat",
          ),
        );
      const { threadId } = await store.forScope("org-a").createThread({});

      const refused = await turn(threadId, "org-b");
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: "thread_not_found" } });

      const accepted = await turn(threadId, "org-a");
      expect(accepted.status).toBe(200);
      await accepted.text();
      const waitFor = async (read: () => Promise<AgentMessage[] | null>, length: number) => {
        let thread = await read();
        for (let i = 0; i < 100 && (thread?.length !== length || thread.at(-1)?.finishReason === undefined); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          thread = await read();
        }
        return thread;
      };
      const controller = new Chat();
      const thread = await waitFor(() => controller.readThread(threadId, { scope: "org-a" }), 2);
      expect(thread!.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(await controller.readThread(threadId, { scope: "org-b" })).toBeNull();

      // A server-started turn, with the scope named: wins over the hook.
      const server = await Chat.startTurn({ threadId, text: "again", scope: "org-a", body: { org: "org-b" } });
      await server.result();
      expect(await store.forScope("org-a").loadThread(threadId)).toHaveLength(4);
      await expect(Chat.startTurn({ threadId, text: "no", scope: "org-b" })).rejects.toMatchObject({
        status: 404,
      });

      // An event turn's message carries the scope in its row, like any other.
      const event = await Chat.startTurn({ threadId, scope: "org-a", event: { name: "job-settled" } });
      await event.result();
      const quoted =
        db.dialect === "mysql" || db.dialect === "mariadb"
          ? `\`${store.messagesTable}\``
          : `"${store.messagesTable}"`;
      const rows = (await db.connect().unsafe(
        `SELECT scope, message FROM ${quoted} WHERE thread_id = '${threadId}'`,
      )) as { scope: string | null; message: string }[];
      expect(rows.length).toBe(6);
      expect(rows.some((row) => JSON.parse(String(row.message)).event?.name === "job-settled")).toBe(true);
      expect(new Set(rows.map((row) => row.scope))).toEqual(new Set(["org-a"]));
    });
  });
}
