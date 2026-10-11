import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import { withTransaction } from "../../orm/context";
import { ChangeFeedManager } from "../change-feed/ChangeFeedManager";
import { DatabaseRunStore } from "./DatabaseRunStore";
import { RunManager } from "./RunManager";

/**
 * The database run store (#908), against SQLite always and against Postgres
 * and MySQL when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set. Each test
 * gets a table of its own.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

type Database = { dialect: Dialect; sql: SQL; table: string; dispose(): Promise<void> };
type Backend = { name: string; prepare(): Promise<Database> };

const suffix = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

const sqlite: Backend = {
  name: "sqlite",
  async prepare() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-runs-"));
    const sql = new SQL(`sqlite://${join(dir, "runs.db")}`);
    return {
      dialect: "sqlite",
      sql,
      table: "gemi_runs",
      async dispose() {
        await sql.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};

function server(name: string, dialect: Dialect, url: string): Backend {
  return {
    name,
    async prepare() {
      // Mixed case: a statement that forgot to quote would miss the table.
      const table = `Runs_${suffix()}`;
      const sql = new SQL(url);
      const quoted = dialect === "mysql" ? `\`${table}\`` : `"${table}"`;
      return {
        dialect,
        sql,
        table,
        async dispose() {
          await sql.unsafe(`DROP TABLE IF EXISTS ${quoted}`);
          await sql.close();
        },
      };
    },
  };
}

const backends: Backend[] = [
  sqlite,
  ...(POSTGRES_URL ? [server("postgres", "postgres", POSTGRES_URL)] : []),
  ...(MYSQL_URL ? [server("mysql", "mysql", MYSQL_URL)] : []),
];

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DatabaseRunStore on the servers this run has no URL for", () => {
    test.skip(
      `postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
        `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}`,
      () => {},
    );
  });
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(backend: Backend) {
  const db = await backend.prepare();
  disposers.push(db.dispose);
  const store = new DatabaseRunStore(
    { sql: db.sql, dialect: db.dialect, name: "default" },
    { table: db.table },
  );
  await store.createTable();
  await store.createTable(); // idempotent
  const feed = new ChangeFeedManager();
  disposers.push(() => feed.close());
  const manager = new RunManager({ store }, { feed });
  return { db, store, manager };
}

describe.each(backends)("DatabaseRunStore on $name", (backend) => {
  test("keeps the whole record, and moves it by compare-and-set", async () => {
    const { store, manager } = await setup(backend);
    const run = await manager.create({
      kind: "page-build",
      subject: "site:1",
      owner: "user:2",
      meta: { pageId: 3, title: "Ünïcode ✓" },
      deadline: "10m",
    });
    expect(run).toMatchObject({
      kind: "page-build",
      subject: "site:1",
      owner: "user:2",
      status: "pending",
      meta: { pageId: 3, title: "Ünïcode ✓" },
      progress: null,
      result: null,
      error: null,
      version: 1,
      startedAt: null,
      finishedAt: null,
    });
    expect(run.deadlineAt! - run.createdAt).toBe(600_000);
    expect(Math.abs(run.createdAt - Date.now())).toBeLessThan(60_000);

    const progressed = await manager.progress(run.id, { fraction: 0.25, message: "Copy" });
    expect(progressed).toMatchObject({
      status: "running",
      version: 2,
      progress: { fraction: 0.25, message: "Copy" },
    });
    expect(progressed!.startedAt).not.toBeNull();

    const done = await manager.complete(run.id, { pageId: 3 });
    expect(done).toMatchObject({ status: "completed", version: 3, result: { pageId: 3 } });
    expect(done!.finishedAt).not.toBeNull();
    expect(done!.startedAt).toBe(progressed!.startedAt);

    expect(await manager.fail(run.id, "late")).toBeNull();
    expect(await store.transition(run.id, [], { status: "failed" })).toBeNull();
    expect(await store.get("run_missing")).toBeNull();
    await expect(manager.create({ kind: "k", id: run.id })).rejects.toThrow();
  });

  test("lists by kind, subject, owner and status, newest first", async () => {
    const { manager } = await setup(backend);
    const a = await manager.create({ kind: "build", subject: "site:1", owner: "user:1" });
    await sleep(3);
    const b = await manager.create({ kind: "import", subject: "site:1", start: true });
    await sleep(3);
    const c = await manager.create({ kind: "build", subject: "site:2" });
    const ids = async (filter: Parameters<typeof manager.list>[0]) =>
      (await manager.list(filter)).map((run) => run.id);
    expect(await ids({ subject: "site:1" })).toEqual([b.id, a.id]);
    expect(await ids({ kind: "build" })).toEqual([c.id, a.id]);
    expect(await ids({ owner: "user:1" })).toEqual([a.id]);
    expect(await ids({ statuses: ["running"] })).toEqual([b.id]);
    expect(await ids({ statuses: [] })).toEqual([]);
    expect(await ids({ limit: 2 })).toEqual([c.id, b.id]);
  });

  test("sweeps overdue runs and prunes ended ones on the database's clock", async () => {
    const { store, manager } = await setup(backend);
    const late = await manager.create({ kind: "k", deadline: 1 });
    const fine = await manager.create({ kind: "k", deadline: "1h" });
    await sleep(20);
    expect((await store.overdue(await store.now(), 10)).map((run) => run.id)).toEqual([late.id]);
    expect(await manager.sweep()).toBe(1);
    expect(await manager.get(late.id)).toMatchObject({
      status: "timed_out",
      error: { code: "deadline" },
    });
    expect(await manager.prune("1h")).toBe(0);
    await sleep(20);
    expect(await manager.prune(5)).toBe(1);
    expect(await manager.get(late.id)).toBeNull();
    expect(await manager.get(fine.id)).not.toBeNull();
  });

  test("wait resolves when another writer completes the run", async () => {
    const { manager } = await setup(backend);
    const { id } = await manager.create({ kind: "k" });
    const waiting = manager.wait(id, { timeout: "5s" });
    await sleep(10);
    await manager.complete(id, "ok");
    expect(await waiting).toMatchObject({ status: "completed", result: "ok" });
  });

  test("inside a transaction on its connection, a rollback takes the run with it", async () => {
    const { db, manager } = await setup(backend);
    let id = "";
    await expect(
      withTransaction(
        db.sql,
        async () => {
          id = (await manager.create({ kind: "k" })).id;
          expect(await manager.get(id)).not.toBeNull();
          throw new Error("rollback");
        },
        { connection: "default" },
      ),
    ).rejects.toThrow("rollback");
    expect(await manager.get(id)).toBeNull();
  });
});
