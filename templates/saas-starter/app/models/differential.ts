import { SQL } from "bun";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, type ExecOptions } from "gemi/orm";
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

/**
 * Fields that legitimately differ between two runs of the same write, because
 * the value is minted rather than supplied: a `@default(cuid())`, a
 * `@default(now())`, an `@updatedAt`.
 *
 * They are not skipped — they are replaced by a *descriptor* of the value, so
 * a cuid that is the wrong length or has the wrong prefix still fails. That is
 * exactly the divergence the plan warns about: "a cuid that is shaped
 * differently from Prisma's will show up as a diff in column length or prefix".
 */
const VOLATILE = ["publicId", "createdAt", "updatedAt"];

export interface WriteComparison {
  /** Models whose full contents are compared afterwards. Defaults to the one written. */
  tables?: string[];
  /** Fields compared by shape rather than by value. Defaults to {@link VOLATILE}. */
  volatile?: string[];
}

export interface Differential {
  prisma: PrismaClient;
  /** Runs both clients and asserts the results are deep-equal. */
  expectSame(
    model: string,
    operation: string,
    args?: unknown,
    options?: ExecOptions,
  ): Promise<unknown>;
  /**
   * The same, for an operation that *mutates*.
   *
   * A write cannot be run through both clients against one database — the
   * second would see the first one's effects. So each client gets the seeded
   * state fresh, and both the returned value and the resulting table contents
   * are compared. Comparing the rows afterwards is the half that matters:
   * `updateMany` returns only a count, and a `create` that wrote the right
   * payload to the wrong columns returns something perfectly plausible.
   */
  expectSameWrite(
    model: string,
    operation: string,
    args?: unknown,
    options?: WriteComparison,
  ): Promise<void>;
  /** Restores the seeded state, dropping everything either client wrote. */
  reset(): Promise<void>;
  /**
   * Statements the gemi ORM has executed since the last reset. The point of
   * counting is the relation planner: one query per *node* in an include tree
   * and not one per row is a property no result comparison can see, and an
   * accidental N+1 is otherwise invisible until it is in production.
   */
  queries(): number;
  resetQueries(): void;
  dispose(): Promise<void>;
}

export const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

/**
 * Redaction is the one policy capability that makes gemi's result *deliberately*
 * differ from Prisma's, so every comparison in this harness runs with policies
 * suspended.
 *
 * The alternative — comparing a redacted payload against Prisma's — would fail
 * for a correct implementation, and the obvious fix for that (teaching the
 * harness which fields to ignore) is worse: it would also mask a redaction that
 * removed the *wrong* field, which is the bug worth catching. So the contract
 * is the one the plan asks for: the differential asserts equality against the
 * pre-redaction payload, and redaction itself is tested where it can be
 * asserted directly, in `policies.test.ts`.
 *
 * This matters even though the template declares no policies today: the moment
 * an application adds one, every comparison here would start failing for a
 * reason that has nothing to do with the compiler.
 */
const unpoliced = <T>(fn: () => Promise<T>): Promise<T> => Model.asSystem(fn);

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
function normalize(value: unknown, volatile?: Set<string>): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  // The constructor name is part of the comparison, not decoration. `Buffer`
  // is a `Uint8Array` subclass, so a divergence between the two survives
  // `ArrayBuffer.isView`, the generated type, and any element-wise comparison —
  // and spreading to an array, which is what this line used to do, erased the
  // one thing that distinguishes them. `.toString("hex")` returns `"0102ff"`
  // from one and `"1,2,255"` from the other, so it is a real divergence that
  // this harness could not see. See the `Bytes` case in `PostgresDialect`.
  if (ArrayBuffer.isView(value)) {
    return `bytes:${value.constructor.name}:${[...(value as any)].join(",")}`;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, volatile));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      out[key] =
        volatile?.has(key) === true
          ? descriptor(member)
          : normalize(member, volatile);
    }
    return out;
  }
  return value;
}

/**
 * What a generated value looks like, without what it is. Keeps the comparison
 * meaningful for `@default(cuid())` and `@default(now())` — a string of the
 * wrong length or with the wrong first character still fails.
 */
function descriptor(value: unknown): string {
  if (value === null || value === undefined) return "absent";
  if (value instanceof Date) return "date";
  if (typeof value === "string") {
    return `string(len=${value.length},head=${value.slice(0, 1)})`;
  }
  return typeof value;
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
  await assertPrismaSpeaks(prisma, options.url ? "postgresql" : "sqlite");

  // Children before parents: the schema's foreign keys are enforced on both
  // dialects, and a scratch database is only scratch for this suite.
  const TABLES = [
    "Membership",
    "SocialAccount",
    "Session",
    "PasswordResetToken",
    "MagicLinkToken",
    "Account",
    "User",
    "OrganizationInvitation",
    "Organization",
  ];

  /**
   * Empties every table **and restarts the identity sequences**.
   *
   * The restart is not tidiness. A write comparison runs the same operation
   * twice from the same seeded state, and an autoincrement sequence survives a
   * `DELETE` on both dialects — so without it the second run's rows get higher
   * ids than the first's and every single comparison fails on `id` alone. It
   * is also the difference between "the same state" and "the same rows".
   */
  const clearAll = async () => {
    if (options.url) {
      // One statement, and `RESTART IDENTITY` is part of it.
      await prisma.$executeRawUnsafe(
        `TRUNCATE ${TABLES.map((table) => `"${table}"`).join(", ")} ` +
          `RESTART IDENTITY CASCADE`,
      );
      return;
    }

    await prisma.membership.deleteMany({});
    await prisma.socialAccount.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.passwordResetToken.deleteMany({});
    await prisma.magicLinkToken.deleteMany({});
    await prisma.account.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.organizationInvitation.deleteMany({});
    await prisma.organization.deleteMany({});

    // SQLite keeps the high-water mark for an AUTOINCREMENT column in this
    // table, and clearing it is the only way to make ids start from 1 again.
    // It does not exist until the first AUTOINCREMENT insert, hence the guard.
    await prisma
      .$executeRawUnsafe(`DELETE FROM sqlite_sequence`)
      .catch(() => undefined);
  };

  if (options.url) await clearAll();

  await options.seed(prisma);

  const previous = Application.getInstance();
  const app = new Application();
  const database = new DatabaseManager({
    url: url.startsWith("file:") ? `sqlite://${url.slice(5)}` : url,
  });

  // What the container hands `$exec` is a counting stand-in rather than the
  // manager itself.
  //
  // **A Proxy, not a hand-written object.** This used to be `{ unsafe }` alone,
  // on the reasoning that `$exec` reads exactly `sql.unsafe` and `dialect` — "a
  // test seam the runtime does not know about cannot drift". It drifted the
  // first time `$exec` needed a second method: the read-then-write paths
  // (`delete` with an include over a cascade, a chunked `createMany`, an
  // `upsert` whose create omits the conflict key) open a transaction, and the
  // stub failed with `pool.begin is not a function`.
  //
  // A stub that lists what the runtime uses today is a promise about what it
  // will use tomorrow. Delegating everything and intercepting one method cannot
  // fall behind — which is the conclusion `bench/run.ts` reached independently,
  // after the same error.
  let executed = 0;
  const counting = new Proxy(database.sql, {
    get(target, property, receiver) {
      if (property === "unsafe") {
        return (text: string, values: unknown[]) => {
          executed++;
          return target.unsafe(text, values);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  // And the manager is a Proxy for exactly the reason above, one level up.
  // This was `{ dialect, url, sql }` — a hand-written object listing what
  // `$exec` read at the time — and it drifted the moment `$exec` read one more
  // thing: `config`, for the slow-transaction threshold, which failed with
  // `undefined is not an object (evaluating 'db.config.slowTransactionThreshold')`.
  // The same lesson as `counting`, so the same shape: delegate everything to
  // the real manager, override only `sql`.
  app.instance(
    DatabaseManager,
    new Proxy(database, {
      get(target, property, receiver) {
        if (property === "sql") return counting;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  Application.setInstance(app);

  return {
    prisma,

    queries: () => executed,
    resetQueries: () => {
      executed = 0;
    },

    /**
     * `execOptions` exists so the same matrix can run under both relation
     * strategies — iteration 9's acceptance criterion 2, which asks for the
     * *full* nested matrix against the lateral strategy rather than a subset.
     *
     * Threaded through the public API rather than through a test-only hook, so
     * what the matrix exercises is exactly what an application naming a strategy
     * gets.
     */
    async expectSame(model, operation, args, execOptions) {
      clearPlanCache();

      const gemiModel = options.models[model];
      if (!gemiModel) throw new Error(`No gemi model registered for ${model}.`);

      const label = `${model}.${operation}(${JSON.stringify(args ?? {})})`;

      const [fromPrisma, fromGemi] = await Promise.all([
        settle(() => prismaDelegate(prisma, model)[operation](args)),
        settle(() =>
          unpoliced(() => (gemiModel as any)[operation](args, execOptions)),
        ),
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

    async reset() {
      await clearAll();
      await options.seed(prisma);
    },

    async expectSameWrite(model, operation, args, comparison = {}) {
      const volatile = new Set(comparison.volatile ?? VOLATILE);
      const tables = comparison.tables ?? [model];
      const label = `${model}.${operation}(${JSON.stringify(args ?? {})})`;

      // Sequential, not concurrent: a write run through both clients against
      // one database would have the second see the first one's effects. Each
      // gets the seeded state fresh, and the two are compared afterwards.
      await this.reset();
      const fromPrisma = await settle(() =>
        prismaDelegate(prisma, model)[operation](args),
      );
      const afterPrisma = await readTables(prisma, tables, options.models);

      await this.reset();
      clearPlanCache();
      const gemiModel = options.models[model];
      if (!gemiModel) throw new Error(`No gemi model registered for ${model}.`);
      const fromGemi = await settle(() =>
        unpoliced(() => (gemiModel as any)[operation](args)),
      );
      const afterGemi = await readTables(prisma, tables, options.models);

      if (fromPrisma.threw || fromGemi.threw) {
        // The `kind` is compared too, not just the fact of throwing: without it
        // a gemi compile-time refusal reads as agreement with a Prisma unique
        // violation. See `failureKind`.
        expect(
          { threw: fromGemi.threw, kind: fromGemi.kind, at: label },
          `${label}: prisma ${fromPrisma.threw ? "threw" : "returned"} but ` +
            `gemi ${fromGemi.threw ? "threw" : "returned"}` +
            (fromGemi.threw ? ` — ${fromGemi.error}` : "") +
            (fromPrisma.threw ? ` — ${fromPrisma.error}` : ""),
        ).toEqual({
          threw: fromPrisma.threw,
          kind: fromPrisma.kind,
          at: label,
        });
      } else {
        expect(
          normalize(fromGemi.value, volatile),
          `${label}: returned value`,
        ).toEqual(normalize(fromPrisma.value, volatile));
      }

      // The half that catches a write which returned something plausible and
      // stored something else.
      expect(
        normalize(afterGemi, volatile),
        `${label}: resulting rows`,
      ).toEqual(normalize(afterPrisma, volatile));
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
export async function applyMigrations(path: string): Promise<void> {
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

/**
 * The gemi side of the harness is dialect-agnostic — `DatabaseManager` reads the
 * dialect off the URL — but the *Prisma* side is not: a generated client carries
 * its schema's `datasource` provider, and refuses any other protocol outright.
 * So covering Postgres is a two-step workflow, and the error Prisma raises on
 * its own does not say so:
 *
 *   1. flip `datasource db { provider }` in prisma/schema.prisma to postgresql
 *   2. `prisma db push` against the scratch database, then `prisma generate`
 *      (the gemi artifacts are dialect-agnostic and do not change — that is
 *      worth confirming with `git status` while you are here)
 *   3. TZ=UTC TEST_POSTGRES_URL=postgres://... vitest run --no-file-parallelism
 *   4. flip back and regenerate
 *
 * `--no-file-parallelism` is not optional on Postgres. Every suite points at
 * the one database the env var names, and the write suites truncate it between
 * cases — so run in parallel, one file empties the tables another is reading
 * and the failures land in whichever suite lost the race. On SQLite each suite
 * builds its own file in a temp directory, so the flag is unnecessary there.
 *
 * The SQLite suite cannot run in the same process while the client is built for
 * Postgres, which is why the two dialects are two runs rather than one.
 *
 * TZ=UTC is not incidental: Bun's Postgres driver decodes a zoneless
 * `timestamp` as local time when a statement binds no parameters and as UTC
 * when it binds one, so on a machine that is not UTC the two protocols disagree
 * with each other and with Prisma. See the note in orm/dialect/postgres.ts.
 */
async function assertPrismaSpeaks(
  prisma: PrismaClient,
  provider: "sqlite" | "postgresql",
): Promise<void> {
  try {
    await prisma.$queryRaw`select 1`;
  } catch (error: any) {
    if (!/must start with the protocol/.test(String(error?.message))) throw error;
    throw new Error(
      `This suite needs @prisma/client generated for the '${provider}' ` +
        `provider, and it is not. Set datasource db { provider = ` +
        `"${provider}" } in prisma/schema.prisma and re-run ` +
        `\`prisma generate\`. Only one dialect's suite can run at a time, ` +
        `which is why the other one is failing rather than skipping.` +
        (provider === "postgresql"
          ? ` Run it as: TZ=UTC TEST_POSTGRES_URL=postgres://... vitest`
          : ` Unset TEST_POSTGRES_URL to run only this one.`),
    );
  }
}

/**
 * Every row of the named models, read through Prisma so that both sides of a
 * write comparison are observed by the *same* client. Reading gemi's result
 * with gemi would hide a decode bug that exactly cancels an encode bug.
 */
async function readTables(
  prisma: PrismaClient,
  models: readonly string[],
  /** The gemi model classes, for the primary key of each. */
  registry: ModelMap,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const model of models) {
    // Ordered by the model's **primary key**, not by `id`. Hardcoding `id`
    // assumed every model has one — true of this schema until a model with a
    // compound `@@id` arrived, where Prisma answers
    // `Unknown argument 'id'` and the comparison never runs.
    //
    // A stable order still matters: the two clients write from the same seeded
    // state, so an unordered read could differ by storage order alone and
    // report a divergence that is not one.
    const schema = (registry[model] as unknown as { $schema?: { primaryKey?: string[] } })
      ?.$schema;
    const key = schema?.primaryKey?.length ? schema.primaryKey : ["id"];

    out[model] = await prismaDelegate(prisma, model).findMany({
      orderBy: key.map((field) => ({ [field]: "asc" })),
    });
  }
  return out;
}

async function settle(run: () => Promise<unknown>) {
  try {
    return { threw: false, value: await run(), error: "", kind: "" };
  } catch (error: any) {
    return {
      threw: true,
      value: null,
      error: String(error?.message ?? error),
      kind: failureKind(error),
    };
  }
}

/**
 * A coarse class for a thrown error, comparable across the two clients.
 *
 * Comparing only the *fact* of throwing lets a gemi error thrown for an
 * unrelated reason — a compile-time refusal, say — pass as agreement with a
 * Prisma unique violation. Comparing messages would couple every case to
 * Prisma's wording. The classes below are the ones the two clients genuinely
 * both have, and the ones a write can be wrong about:
 *
 *   Prisma P2002 / gemi UniqueConstraintError  -> "unique"
 *   Prisma P2025 / gemi RecordNotFoundError    -> "notFound"
 *
 * Everything else is "other", where agreeing that it failed is all the harness
 * can honestly claim; the dedicated tests below the table assert the type.
 */
function failureKind(error: any): string {
  const name = String(error?.name ?? "");
  const code = String(error?.code ?? "");

  if (name === "UniqueConstraintError" || code === "P2002") return "unique";
  if (name === "RecordNotFoundError" || code === "P2025") return "notFound";
  return "other";
}
