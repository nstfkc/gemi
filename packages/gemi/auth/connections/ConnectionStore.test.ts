import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import { Encrypter } from "../../services/encryption/Encrypter";
import {
  type ConnectionStore,
  DatabaseConnectionStore,
  MemoryConnectionStore,
} from "./ConnectionStore";
import type { OAuthTokenSet } from "./OAuthConnectionProvider";

/**
 * The connection stores (#845) against one contract: the memory store, and
 * the database store on SQLite always and on Postgres / MySQL when
 * `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set.
 */

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");
let encrypter = new Encrypter({ keys: { k1 } });

function tokens(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    tokenType: "bearer",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ["files:read", "files:write"],
    providerAccountId: "acct-1",
    ...overrides,
  };
}

type Backend = {
  name: string;
  open(): Promise<{ store: ConnectionStore; raw?: (query: string) => Promise<any[]>; dispose(): Promise<void> }>;
};

function databaseBackend(name: string, dialect: Dialect, url: string): Backend {
  return {
    name,
    async open() {
      const sql = new SQL(url);
      const table = `gemi_oauth_connections_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const store = new DatabaseConnectionStore({ sql, dialect }, () => encrypter, { table });
      await store.createTable();
      await store.createTable(); // idempotent
      const quoted = dialect === "mysql" ? `\`${table}\`` : `"${table}"`;
      return {
        store,
        raw: (query: string) => sql.unsafe(query.replaceAll("$table", quoted)) as Promise<any[]>,
        async dispose() {
          await sql.unsafe(`DROP TABLE IF EXISTS ${quoted}`);
          await sql.close();
        },
      };
    },
  };
}

const backends: Backend[] = [
  {
    name: "memory",
    async open() {
      return { store: new MemoryConnectionStore(), async dispose() {} };
    },
  },
  databaseBackend("sqlite", "sqlite", "sqlite://:memory:"),
];
if (process.env.TEST_POSTGRES_URL) backends.push(databaseBackend("postgres", "postgres", process.env.TEST_POSTGRES_URL));
if (process.env.TEST_MYSQL_URL) backends.push(databaseBackend("mysql", "mysql", process.env.TEST_MYSQL_URL));

describe.each(backends)("connection store ($name)", (backend) => {
  let store: ConnectionStore;
  let raw: ((query: string) => Promise<any[]>) | undefined;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    encrypter = new Encrypter({ keys: { k1 } });
    ({ store, raw, dispose } = await backend.open());
  });
  afterAll(async () => {
    await dispose?.();
  });

  test("saves and finds a connection, tokens and all", async () => {
    const saved = await store.save("u1", "figma", tokens());
    expect(saved).toMatchObject({
      userId: "u1",
      provider: "figma",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenType: "bearer",
      scopes: ["files:read", "files:write"],
      providerAccountId: "acct-1",
      needsReconnect: false,
      revision: 1,
    });
    const found = await store.find("u1", "figma");
    expect(found).toEqual(saved);
    expect(found?.expiresAt?.getTime()).toBe(saved.expiresAt?.getTime());
    expect(await store.find("u1", "github")).toBeNull();
    expect(await store.find("u2", "figma")).toBeNull();
  });

  test("a second save replaces the connection and clears needsReconnect", async () => {
    const first = await store.find("u1", "figma");
    await store.markNeedsReconnect(first!.id);
    expect((await store.find("u1", "figma"))?.needsReconnect).toBe(true);

    const second = await store.save("u1", "figma", tokens({ accessToken: "access-2", refreshToken: null }));
    expect(second.id).toBe(first!.id);
    expect(second.accessToken).toBe("access-2");
    expect(second.refreshToken).toBeNull();
    expect(second.needsReconnect).toBe(false);
    expect(second.revision).toBeGreaterThan(first!.revision);
  });

  test("lists one user's connections", async () => {
    await store.save("u1", "github", tokens({ accessToken: "gh" }));
    await store.save("u2", "figma", tokens({ accessToken: "other" }));
    const list = await store.list("u1");
    expect(list.map((row) => row.provider).sort()).toEqual(["figma", "github"]);
  });

  test("updateTokens is a compare-and-swap on the revision", async () => {
    const current = (await store.find("u1", "github"))!;
    const updated = await store.updateTokens(current.id, current.revision, tokens({ accessToken: "gh-2", providerAccountId: null }));
    expect(updated?.accessToken).toBe("gh-2");
    expect(updated?.revision).toBe(current.revision + 1);
    if (backend.name !== "memory") expect(updated?.providerAccountId).toBe("acct-1");

    // The stale revision loses.
    expect(await store.updateTokens(current.id, current.revision, tokens({ accessToken: "gh-lost" }))).toBeNull();
    expect((await store.find("u1", "github"))?.accessToken).toBe("gh-2");
  });

  test("deletes a connection", async () => {
    const row = (await store.find("u2", "figma"))!;
    await store.delete(row.id);
    expect(await store.find("u2", "figma")).toBeNull();
  });

  test.runIf(backend.name !== "memory")("keeps tokens encrypted at rest", async () => {
    const rows = await raw!(`SELECT access_token, refresh_token FROM $table`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.access_token)).toMatch(/^v1:k1:/);
      expect(String(row.access_token)).not.toContain("access");
      if (row.refresh_token !== null) expect(String(row.refresh_token)).toMatch(/^v1:k1:/);
    }
  });

  test.runIf(backend.name !== "memory")("rotateEncryption re-encrypts tokens under an older key", async () => {
    encrypter = new Encrypter({ keys: { k1, k2 }, current: "k2" });
    const db = store as DatabaseConnectionStore;
    const dry = await db.rotateEncryption({ dryRun: true });
    expect(dry.rotated).toBe(dry.scanned);
    expect((await raw!(`SELECT access_token FROM $table`)).every((r) => String(r.access_token).startsWith("v1:k1:"))).toBe(true);

    const report = await db.rotateEncryption();
    expect(report.rotated).toBe(report.scanned);
    expect((await raw!(`SELECT access_token FROM $table`)).every((r) => String(r.access_token).startsWith("v1:k2:"))).toBe(true);
    expect((await db.rotateEncryption()).rotated).toBe(0);

    // Readable with only the new key.
    encrypter = new Encrypter({ keys: { k2 } });
    expect((await store.find("u1", "figma"))?.accessToken).toBe("access-2");
  });
});

describe("DatabaseConnectionStore", () => {
  test("refuses a table name that is not a plain identifier", () => {
    expect(
      () => new DatabaseConnectionStore({ sql: {} as SQL, dialect: "sqlite" }, () => encrypter, { table: "x; drop" }),
    ).toThrow(/plain identifier/);
  });
});
