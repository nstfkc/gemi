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
import { DatabaseAgentStore } from "./DatabaseAgentStore";

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
  store(sql?: SQL, name?: string): DatabaseAgentStore;
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
    const store = (sql = first, name?: string) =>
      new DatabaseAgentStore({ sql, dialect, ...(name ? { name } : {}) }, tables);
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
  });
}
