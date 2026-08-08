import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "./prisma-client";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, type ExecOptions } from "gemi/orm";
import { expect } from "vitest";

import { applyMigrations } from "./scratch";

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
 *
 * **This module imports `@prisma/client`, so importing it is not free.** Only a
 * suite that actually compares against Prisma should reach for it; `POSTGRES_URL`
 * and `applyMigrations` moved to `./scratch`, which imports nothing but `bun`
 * and two node builtins, precisely so the other eleven suites in this directory
 * stop loading a query engine at collection time to read an environment
 * variable. `packages/gemi/orm/template-import-graph.test.ts` holds that line.
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

/** The generated `ModelSchema` behind a registered class, or nothing. */
type RegisteredSchema = {
  primaryKey?: string[];
  relations?: Record<string, { model: string }>;
};

function schemaOf(registry: ModelMap, model: string): RegisteredSchema | undefined {
  return (registry[model] as unknown as { $schema?: RegisteredSchema })?.$schema;
}

/**
 * Sorts the rows of every **relation** array in a payload, so the comparison is
 * of a set of children rather than of a storage order neither client promises.
 *
 * This is the rule `readTables` already applies to the after-state, arriving in
 * the half that compares what the call *returned*. It is not a nicety:
 *
 * Prisma loads an `include` with a second query and, measured against 6.19.2 on
 * Postgres by logging what it sends,
 *
 *     SELECT … FROM "public"."Account" WHERE "public"."Account"."userId" IN ($1) OFFSET $2
 *
 * there is no `ORDER BY` in it, and gemi's is unordered too. So the order is
 * whatever a sequential scan hands back, and on Postgres an `UPDATE` writes a
 * new tuple wherever there is room: usually at the end of the page, which puts
 * the updated child *last*, but at a reclaimed line pointer once the page has
 * been pruned, which puts it back where it was. Pruning is opportunistic, so
 * which of the two happens depends on how much churn the table has already seen
 * — and `expectSameWrite` runs the two clients one after the other, so they meet
 * the heap in different states.
 *
 * The failure that came from this is worth writing down because it reads as a
 * real divergence: "upsert updates the row when it is this parent's" reported
 * gemi returning the accounts as `[4, 3]` against Prisma's `[3, 4]`, with every
 * field of every row identical. It appeared only in the whole-suite run, not
 * when the file ran alone, and a second whole-suite run moved it to a different
 * case — which is the tell.
 *
 * Deliberately schema-guided rather than "sort any array of objects". A `Json`
 * column holds arrays whose order *is* the value (`metadata: []` in
 * `differential.test.ts`), and scalar lists (#300) are ordered by definition;
 * sorting either would erase a divergence this suite exists to catch. Only keys
 * the generated schema declares as relations are touched.
 *
 * Exported only so `writes.differential.test.ts` can assert it directly. The
 * flake it closes is unreproducible on demand, so leaving it to be covered by
 * the Postgres run would mean it is covered on the runs where it happens to
 * matter and nowhere else.
 *
 * Sorted by the serialised row rather than by the primary key, because a
 * `select` may not have asked for one. That makes the comparison a multiset
 * comparison: two different sets of children still fail, which is the assertion
 * worth keeping.
 *
 * **A node that asked for an `orderBy` keeps its order**, and that exception is
 * the whole reason `selection` is threaded through. The flake above is a
 * property of an *unordered* include — where neither client emits an `ORDER BY`,
 * so neither promises anything and the heap decides. An include that named an
 * `orderBy` is the opposite: the order is the answer, both clients emit the
 * sort, and comparing it positionally is exactly what this suite is for.
 * Sorting there would have made six existing cases unable to fail — a relation
 * strategy that stopped honouring a nested `orderBy` and returned children in
 * join-table order would compare equal, because both sides get re-sorted by the
 * same comparator first.
 */
export function stabilizeRelations(
  value: unknown,
  model: string,
  registry: ModelMap,
  /** The `include` / `select` subtree that produced `value`, when there is one. */
  selection?: unknown,
): unknown {
  if (Array.isArray(value)) {
    return value.map((row) => stabilizeRelations(row, model, registry, selection));
  }
  if (value === null || typeof value !== "object") return value;

  const relations = schemaOf(registry, model)?.relations;
  if (!relations) return value;

  const nodes = selectionNodes(selection);

  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const relation = relations[key];
    if (!relation) {
      out[key] = member;
      continue;
    }
    const node = nodes?.[key];
    const child = stabilizeRelations(member, relation.model, registry, node);
    out[key] =
      Array.isArray(child) && !askedForAnOrder(node)
        ? [...child].sort((a, b) =>
            JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
          )
        : child;
  }
  return out;
}

const askedForAnOrder = (node: unknown) =>
  node !== null &&
  typeof node === "object" &&
  (node as Record<string, unknown>).orderBy !== undefined;

/**
 * The relation keys one level down, from whichever of `include` / `select`
 * carried them. Both may appear on the same node, and a relation reached
 * through `select` is as ordered as one reached through `include`.
 */
function selectionNodes(
  selection: unknown,
): Record<string, unknown> | undefined {
  if (selection === null || typeof selection !== "object") return undefined;

  const merged: Record<string, unknown> = {};
  for (const which of ["include", "select"] as const) {
    const node = (selection as Record<string, unknown>)[which];
    if (node !== null && typeof node === "object") Object.assign(merged, node);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
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
 * `User.findMany({"where":…})` — the label every assertion below is reported
 * under, so a failure in a `test.each` says which case failed.
 *
 * `JSON.stringify` on its own is not enough and fails *loudly*: it throws
 * `TypeError: JSON.stringify cannot serialize BigInt`. That turned four
 * scalar-list cases into an error raised while building the message rather than
 * a comparison — the harness failing to describe the test instead of running
 * it, which reads at a glance like the case itself failing.
 *
 * Reachable before now only in principle: the template's one `BigInt` column is
 * never an *argument*, and `BigInt[]` is the first thing that put one inside a
 * `where` and a `data`.
 */
function describeCall(model: string, operation: string, args: unknown): string {
  const text = JSON.stringify(args ?? {}, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
  return `${model}.${operation}(${text})`;
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
  /**
   * A Prisma client to compare against, instead of the one this module imports.
   *
   * **For a schema that is not `prisma/schema.prisma`**, which today means
   * `prisma/postgres-only.prisma` and its scalar lists (#300). That schema has
   * to be separate — a `String[]` is a validation error on SQLite, so it cannot
   * share a file whose provider is flipped between dialects — and a separate
   * schema generates a separate client, which `@prisma/client` does not name.
   *
   * Injecting it rather than importing a second client here is what keeps this
   * module loadable during a SQLite run: the scalar-list client only exists
   * after `prisma generate --schema prisma/postgres-only.prisma`, and eleven
   * other suites import this file.
   *
   * Postgres only, and required to come with `url` and `tables` — there is no
   * SQLite fallback for a schema SQLite cannot express.
   */
  client?: PrismaClient;
  /** Tables to truncate between cases, children before parents. */
  tables?: string[];
}): Promise<Differential> {
  const workspace = mkdtempSync(join(tmpdir(), "gemi-orm-diff-"));
  const sqlitePath = join(workspace, "diff.db");
  const url = options.url ?? `file:${sqlitePath}`;

  // Both, not just `url`. Omitting `tables` was the worse of the two and the
  // one that failed *quietly*: the default list below names the main schema's
  // tables, so a second-schema harness without its own would issue a `TRUNCATE`
  // for tables that do not exist in the database it is pointed at — clearing
  // nothing it meant to clear, and reporting it as a truncation error rather
  // than as the missing argument it is.
  if (options.client) {
    const missing = [
      !options.url && "url",
      !options.tables && "tables",
    ].filter(Boolean);

    if (missing.length > 0) {
      throw new Error(
        `createDifferential({ client }) is for a second Postgres schema, so it ` +
          `needs ${missing.join(" and ")}: the \`url\` of the database that ` +
          `schema was pushed to, and the \`tables\` to clear between cases — ` +
          `the defaults name the main schema's, which are not in that ` +
          `database. There is no SQLite path for it.`,
      );
    }
  }

  // SQLite gets a brand-new file with the committed migrations replayed into
  // it. Deliberately not `prisma db push --force-reset`: that command is
  // destructive by design, and a test has no business running it — this way
  // there is never a database that could be harmed, only one that is created.
  if (!options.url) {
    await applyMigrations(sqlitePath);
  }

  // An injected client is already constructed and already pointed at its own
  // database; re-constructing it here would need its class, which is the thing
  // this module deliberately does not import.
  const prisma =
    options.client ?? new PrismaClient({ datasources: { db: { url } } });

  // Postgres runs against whatever `TEST_POSTGRES_URL` names, so the harness
  // clears only the table it seeds and nothing else. The env var's contract is
  // that it points at a scratch database with the schema already applied.
  await assertPrismaSpeaks(prisma, options.url ? "postgresql" : "sqlite");

  // Children before parents: the schema's foreign keys are enforced on both
  // dialects, and a scratch database is only scratch for this suite.
  const TABLES = options.tables ?? [
    "_PostToTag",
    "Post",
    "Tag",
    "Membership",
    "SocialAccount",
    "Session",
    "PasswordResetToken",
    "MagicLinkToken",
    "Account",
    // `Profile` is the to-one whose foreign key is on the *child* (#354), so it
    // is a child of `User` and has to be cleared first — the same rule the
    // comment below states, and the third model in this suite's history to
    // need it said out loud.
    "Profile",
    "User",
    "OrganizationInvitation",
    "Organization",
    // The composite-relation pair (#67). Adding a model to the schema without
    // adding it here is a *silent* omission on SQLite, where every run gets a
    // fresh temp database, and a loud one on Postgres, where the second run's
    // seed collides with the first's rows — which is exactly how this was
    // found, and the second time in this suite's history.
    "LedgerEntry",
    "Ledger",
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

    await prisma.post.deleteMany({});
    await prisma.tag.deleteMany({});
    await prisma.membership.deleteMany({});
    await prisma.socialAccount.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.passwordResetToken.deleteMany({});
    await prisma.magicLinkToken.deleteMany({});
    await prisma.account.deleteMany({});
    // Before `user`, for the same reason as in `TABLES`: `Profile.userId` is a
    // foreign key into `User`. Its `ON DELETE SET NULL` means the wrong order
    // would not raise here — it would leave a detached `Profile` row behind on
    // the dialect that enforces the key and none on the one that does not,
    // which is the shape of divergence this harness exists to catch and would
    // instead be manufacturing.
    await prisma.profile.deleteMany({});
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
        // Bound to the **proxy**. `$exec` resolves its connection by name and
        // the manager answers the default one with `this` — bound to the
        // target, that is the unwrapped manager, and the statements it runs are
        // never seen here. The delegation above is only as generic as this
        // line lets it be.
        return typeof value === "function" ? value.bind(receiver) : value;
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

      const label = describeCall(model, operation, args);

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
      const label = describeCall(model, operation, args);

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
        // `stabilizeRelations` on both sides, for the reason written on it: an
        // `include` is unordered in both clients, and a write moves the row it
        // touched within the Postgres heap.
        //
        // Only here, not in `expectSame` above. A read leaves the heap alone, so
        // the two clients there see the same physical order and comparing it
        // positionally still holds — and that comparison is worth keeping,
        // because a relation strategy that returned children in a different
        // order from Prisma's would be a real difference to an application even
        // though no `ORDER BY` promises otherwise. It is only a *write* that
        // makes the order move under the comparison.
        // `args` is threaded in so a node carrying an `orderBy` keeps its order:
        // the flake is a property of an include that promised nothing, and one
        // that named a sort is the case this suite most wants to compare.
        const comparable = (value: unknown) =>
          stabilizeRelations(
            normalize(value, volatile),
            model,
            options.models,
            args,
          );

        expect(comparable(fromGemi.value), `${label}: returned value`).toEqual(
          comparable(fromPrisma.value),
        );
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
    const schema = schemaOf(registry, model);
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
