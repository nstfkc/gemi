import type { SQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import type { Encrypter } from "../../services/encryption/Encrypter";
import type { OAuthTokenSet } from "./OAuthConnectionProvider";

/** One stored connection, tokens decrypted. Lives only inside the framework. */
export interface ConnectionRecord {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
  expiresAt: Date | null;
  needsReconnect: boolean;
  /** Bumped on every token change: the compare-and-swap that serialises refreshes. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Where connections are kept. `DatabaseConnectionStore` in an app, `MemoryConnectionStore` in tests. */
export interface ConnectionStore {
  find(userId: string, provider: string): Promise<ConnectionRecord | null>;
  list(userId: string): Promise<ConnectionRecord[]>;
  /** Stores a fresh grant, replacing any connection the user had to this provider. */
  save(userId: string, provider: string, tokens: OAuthTokenSet): Promise<ConnectionRecord>;
  /**
   * Replaces the tokens of the connection at `revision`, or resolves `null`
   * when it has moved on (another request refreshed it first) or is gone.
   */
  updateTokens(id: string, revision: number, tokens: OAuthTokenSet): Promise<ConnectionRecord | null>;
  markNeedsReconnect(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryConnectionStore implements ConnectionStore {
  private readonly rows = new Map<string, ConnectionRecord>();

  async find(userId: string, provider: string) {
    for (const row of this.rows.values()) {
      if (row.userId === userId && row.provider === provider) return { ...row };
    }
    return null;
  }

  async list(userId: string) {
    return [...this.rows.values()].filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }

  async save(userId: string, provider: string, tokens: OAuthTokenSet) {
    const existing = await this.find(userId, provider);
    const now = new Date();
    const row: ConnectionRecord = {
      id: existing?.id ?? Bun.randomUUIDv7(),
      userId,
      provider,
      ...fromTokens(tokens),
      needsReconnect: false,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async updateTokens(id: string, revision: number, tokens: OAuthTokenSet) {
    const row = this.rows.get(id);
    if (!row || row.revision !== revision) return null;
    const next = { ...row, ...fromTokens(tokens), needsReconnect: false, revision: revision + 1, updatedAt: new Date() };
    this.rows.set(id, next);
    return { ...next };
  }

  async markNeedsReconnect(id: string) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, needsReconnect: true, updatedAt: new Date() });
  }

  async delete(id: string) {
    this.rows.delete(id);
  }
}

export interface DatabaseConnectionStoreOptions {
  /** Default `gemi_oauth_connections`. A plain identifier: it is spliced into every statement. */
  table?: string;
}

/**
 * Connections in a table of the app's database, tokens encrypted with the
 * app's `Encrypter` (the keys in `app/config/encryption.ts`). Raw SQL, like
 * the queue's and the locks' tables, for SQLite, Postgres and MySQL 8 /
 * MariaDB: the table is not an ORM model, so no ORM read can return a token.
 */
export class DatabaseConnectionStore implements ConnectionStore {
  readonly table: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect">,
    private readonly encrypter: () => Encrypter,
    options: DatabaseConnectionStoreOptions = {},
  ) {
    const table = options.table ?? "gemi_oauth_connections";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`The connections table name "${table}" is not a plain identifier.`);
    }
    this.table = table;
    this.sql = connection.sql;
    this.dialect = connection.dialect;
  }

  /** Creates the table if it does not exist: the DDL Prisma makes for the model in the docs. */
  async createTable(): Promise<void> {
    for (const statement of createConnectionTableStatements(this.dialect, this.table)) {
      await this.sql.unsafe(statement);
    }
  }

  async find(userId: string, provider: string) {
    const q = this.sql;
    const rows = (await q`
      SELECT * FROM ${this.name(q)} WHERE user_id = ${userId} AND provider = ${provider}
    `) as RawRow[];
    return rows[0] ? this.decode(rows[0]) : null;
  }

  async list(userId: string) {
    const q = this.sql;
    const rows = (await q`
      SELECT * FROM ${this.name(q)} WHERE user_id = ${userId} ORDER BY provider
    `) as RawRow[];
    return rows.map((row) => this.decode(row));
  }

  async save(userId: string, provider: string, tokens: OAuthTokenSet) {
    const q = this.sql;
    const values = this.encode(tokens);
    const now = Date.now();

    const update = async () =>
      affected(
        await q`
          UPDATE ${this.name(q)}
          SET provider_account_id = ${values.providerAccountId}, scopes = ${values.scopes},
              access_token = ${values.accessToken}, refresh_token = ${values.refreshToken},
              token_type = ${values.tokenType}, expires_at = ${values.expiresAt},
              needs_reconnect = 0, revision = revision + 1, updated_at = ${now}
          WHERE user_id = ${userId} AND provider = ${provider}
        `,
      );

    if ((await update()) === 0) {
      try {
        await q`
          INSERT INTO ${this.name(q)} (id, user_id, provider, provider_account_id, scopes,
            access_token, refresh_token, token_type, expires_at, needs_reconnect, revision,
            created_at, updated_at)
          VALUES (${Bun.randomUUIDv7()}, ${userId}, ${provider}, ${values.providerAccountId},
            ${values.scopes}, ${values.accessToken}, ${values.refreshToken}, ${values.tokenType},
            ${values.expiresAt}, 0, 1, ${now}, ${now})
        `;
      } catch (error) {
        // A concurrent callback for the same user and provider inserted first.
        if ((await update()) === 0) throw error;
      }
    }

    const saved = await this.find(userId, provider);
    if (!saved) throw new Error("The OAuth connection vanished while it was being saved.");
    return saved;
  }

  async updateTokens(id: string, revision: number, tokens: OAuthTokenSet) {
    const q = this.sql;
    const values = this.encode(tokens);
    const result = await q`
      UPDATE ${this.name(q)}
      SET provider_account_id = COALESCE(${values.providerAccountId}, provider_account_id),
          scopes = ${values.scopes}, access_token = ${values.accessToken},
          refresh_token = ${values.refreshToken}, token_type = ${values.tokenType},
          expires_at = ${values.expiresAt}, needs_reconnect = 0, revision = revision + 1,
          updated_at = ${Date.now()}
      WHERE id = ${id} AND revision = ${revision}
    `;
    if (affected(result) === 0) return null;
    const rows = (await q`SELECT * FROM ${this.name(q)} WHERE id = ${id}`) as RawRow[];
    return rows[0] ? this.decode(rows[0]) : null;
  }

  async markNeedsReconnect(id: string) {
    const q = this.sql;
    await q`UPDATE ${this.name(q)} SET needs_reconnect = 1, updated_at = ${Date.now()} WHERE id = ${id}`;
  }

  async delete(id: string) {
    const q = this.sql;
    await q`DELETE FROM ${this.name(q)} WHERE id = ${id}`;
  }

  /**
   * Re-encrypts every token still under an older key. Run by
   * `gemi run encryption:rotate`; a token refreshed in the meantime is
   * already current and is skipped by the revision check.
   */
  async rotateEncryption(options: { dryRun?: boolean } = {}): Promise<{ scanned: number; rotated: number }> {
    const q = this.sql;
    const encrypter = this.encrypter();
    const rows = (await q`
      SELECT id, access_token, refresh_token, revision FROM ${this.name(q)} ORDER BY id
    `) as RawRow[];
    let rotated = 0;
    for (const row of rows) {
      const stale = (value: string | null) => typeof value === "string" && encrypter.needsReencryption(value);
      if (!stale(row.access_token) && !stale(row.refresh_token)) continue;
      rotated += 1;
      if (options.dryRun) continue;
      const reseal = (value: string | null) => (value === null ? null : encrypter.encrypt(encrypter.decrypt(value)));
      await q`
        UPDATE ${this.name(q)}
        SET access_token = ${reseal(row.access_token)}, refresh_token = ${reseal(row.refresh_token)},
            revision = revision + 1
        WHERE id = ${row.id} AND revision = ${Number(row.revision)}
      `;
    }
    return { scanned: rows.length, rotated };
  }

  private encode(tokens: OAuthTokenSet) {
    const encrypter = this.encrypter();
    return {
      providerAccountId: tokens.providerAccountId,
      scopes: tokens.scopes.join(" "),
      accessToken: encrypter.encrypt(tokens.accessToken),
      refreshToken: tokens.refreshToken === null ? null : encrypter.encrypt(tokens.refreshToken),
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt === null ? null : tokens.expiresAt.getTime(),
    };
  }

  private decode(row: RawRow): ConnectionRecord {
    const encrypter = this.encrypter();
    return {
      id: String(row.id),
      userId: String(row.user_id),
      provider: String(row.provider),
      providerAccountId: row.provider_account_id === null ? null : String(row.provider_account_id),
      scopes: String(row.scopes ?? "").split(" ").filter(Boolean),
      accessToken: encrypter.decrypt(String(row.access_token)),
      refreshToken: row.refresh_token === null ? null : encrypter.decrypt(String(row.refresh_token)),
      tokenType: row.token_type === null ? null : String(row.token_type),
      expiresAt: row.expires_at === null ? null : new Date(Number(row.expires_at)),
      needsReconnect: Number(row.needs_reconnect) === 1,
      revision: Number(row.revision),
      createdAt: new Date(Number(row.created_at)),
      updatedAt: new Date(Number(row.updated_at)),
    };
  }

  private get mysql() {
    return this.dialect === "mysql" || this.dialect === "mariadb";
  }

  private name(q: SQL) {
    return q.unsafe(this.mysql ? `\`${this.table}\`` : `"${this.table}"`);
  }
}

interface RawRow {
  id: unknown;
  user_id: unknown;
  provider: unknown;
  provider_account_id: unknown;
  scopes: unknown;
  access_token: string;
  refresh_token: string | null;
  token_type: unknown;
  expires_at: unknown;
  needs_reconnect: unknown;
  revision: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function fromTokens(tokens: OAuthTokenSet) {
  return {
    providerAccountId: tokens.providerAccountId,
    scopes: [...tokens.scopes],
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt,
  };
}

function affected(result: unknown): number {
  const counts = result as { count?: number | null; affectedRows?: number | null };
  return Math.max(Number(counts.count ?? 0), Number(counts.affectedRows ?? 0));
}

/** The connections table, as Prisma generates it for the model in the docs, with `IF NOT EXISTS`. */
export function createConnectionTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`user_id\` VARCHAR(191) NOT NULL,
    \`provider\` VARCHAR(191) NOT NULL,
    \`provider_account_id\` VARCHAR(191) NULL,
    \`scopes\` TEXT NOT NULL,
    \`access_token\` TEXT NOT NULL,
    \`refresh_token\` TEXT NULL,
    \`token_type\` VARCHAR(191) NULL,
    \`expires_at\` BIGINT NULL,
    \`needs_reconnect\` INTEGER NOT NULL DEFAULT 0,
    \`revision\` BIGINT NOT NULL DEFAULT 0,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,

    UNIQUE INDEX \`${table}_user_id_provider_key\`(\`user_id\`, \`provider\`),
    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ];
  }
  const key = dialect === "sqlite" ? `"id" TEXT NOT NULL PRIMARY KEY,` : `"id" TEXT NOT NULL,`;
  const constraint =
    dialect === "sqlite" ? "" : `,\n\n    CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")`;
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (
    ${key}
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT,
    "scopes" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "token_type" TEXT,
    "expires_at" BIGINT,
    "needs_reconnect" INTEGER NOT NULL DEFAULT 0,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL${constraint}
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_user_id_provider_key" ON "${table}"("user_id", "provider")`,
  ];
}
