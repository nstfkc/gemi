import { SQL } from "bun";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { clearPlanCache } from "gemi/orm";
import { expect } from "vitest";

/**
 * The safety net for every later iteration: run the same query through Prisma
 * and through the gemi ORM, against the same database, and deep-equal the
 * results.
 *
 * Asserting SQL text only proves the compiler does what we told it to. This
 * proves it does what *Prisma* does — which is the actual contract, and the
 * only practical way to find the small shape divergences (null vs undefined,
 * key presence, numeric types, date decoding) that otherwise surface in
 * production.
 *
 * Postgres runs too when `TEST_POSTGRES_URL` is set. The skip is deliberately
 * loud: a silently skipped dialect reads as a passing one.
 */

export interface Differential {
  prisma: PrismaClient;
  /** Runs both clients and asserts the results are deep-equal. */
  expectSame(
    model: string,
    operation: string,
    args?: unknown,
  ): Promise<unknown>;
  dispose(): Promise<void>;
}

export const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

/** Every model class the generated registry knows, keyed by Prisma's own name. */
type ModelMap = Record<string, { [op: string]: (args?: any) => Promise<any> }>;

function prismaDelegate(client: PrismaClient, model: string) {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const delegate = (client as any)[key];
  if (!delegate) throw new Error(`Prisma has no delegate for ${model}.`);
  return delegate;
}

/**
 * Prisma returns `Decimal` and `BigInt` instances that do not structurally
 * compare, and `undefined` where a `select` omitted a key. Normalising both
 * sides the same way keeps the comparison about *our* divergences rather than
 * about the serializer.
 */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (ArrayBuffer.isView(value)) return `bytes:${[...(value as any)].join(",")}`;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export async function createDifferential(options: {
  models: ModelMap;
  /** Applied to both clients before any comparison runs. */
  seed: (prisma: PrismaClient) => Promise<void>;
  url?: string;
}): Promise<Differential> {
  const workspace = mkdtempSync(join(tmpdir(), "gemi-orm-diff-"));
  const sqlitePath = join(workspace, "diff.db");
  const url = options.url ?? `file:${sqlitePath}`;

  // SQLite gets a brand-new file with the committed migrations replayed into
  // it. Deliberately not `prisma db push --force-reset`: that command is
  // destructive by design, and a test has no business running it — this way
  // there is never a database that could be harmed, only one that is created.
  if (!options.url) {
    await applyMigrations(sqlitePath);
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  // Postgres runs against whatever `TEST_POSTGRES_URL` names, so the harness
  // clears only the table it seeds and nothing else. The env var's contract is
  // that it points at a scratch database with the schema already applied.
  if (options.url) {
    await prisma.socialAccount.deleteMany({});
    await prisma.user.deleteMany({});
  }

  await options.seed(prisma);

  const previous = Application.getInstance();
  const app = new Application();
  const database = new DatabaseManager({
    url: url.startsWith("file:") ? `sqlite://${url.slice(5)}` : url,
  });
  app.instance(DatabaseManager, database);
  Application.setInstance(app);

  return {
    prisma,

    async expectSame(model, operation, args) {
      clearPlanCache();

      const gemiModel = options.models[model];
      if (!gemiModel) throw new Error(`No gemi model registered for ${model}.`);

      const label = `${model}.${operation}(${JSON.stringify(args ?? {})})`;

      const [fromPrisma, fromGemi] = await Promise.all([
        settle(() => prismaDelegate(prisma, model)[operation](args)),
        settle(() => (gemiModel as any)[operation](args)),
      ]);

      // Both throwing is agreement — Prisma's `*OrThrow` and ours raise
      // different error types, and the contract is the fact of failing.
      if (fromPrisma.threw || fromGemi.threw) {
        expect(
          { threw: fromGemi.threw, at: label },
          `${label}: prisma ${fromPrisma.threw ? "threw" : "returned"} but ` +
            `gemi ${fromGemi.threw ? "threw" : "returned"}` +
            (fromGemi.threw ? ` — ${fromGemi.error}` : "") +
            (fromPrisma.threw ? ` — ${fromPrisma.error}` : ""),
        ).toEqual({ threw: fromPrisma.threw, at: label });
        return null;
      }

      expect(normalize(fromGemi.value), label).toEqual(
        normalize(fromPrisma.value),
      );
      return fromGemi.value;
    },

    async dispose() {
      await prisma.$disconnect();
      await database.close();
      Application.setInstance(previous);
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/**
 * Replays the committed migrations into a fresh SQLite file, in name order —
 * which is Prisma's own ordering, since it prefixes every directory with a
 * timestamp. Statements are split on `;` at end of line, which is enough for
 * the DDL Prisma emits and involves no SQL parsing.
 */
async function applyMigrations(path: string): Promise<void> {
  const root = join(import.meta.dirname, "../../prisma/migrations");
  const sql = new SQL(`sqlite://${path}`);

  try {
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const directory of directories) {
      const file = join(root, directory, "migration.sql");
      const source = readFileSync(file, "utf8");
      for (const statement of source.split(/;\s*$/m)) {
        if (statement.trim() === "") continue;
        await sql.unsafe(statement);
      }
    }
  } finally {
    await sql.close();
  }
}

async function settle(run: () => Promise<unknown>) {
  try {
    return { threw: false, value: await run(), error: "" };
  } catch (error: any) {
    return { threw: true, value: null, error: String(error?.message ?? error) };
  }
}
