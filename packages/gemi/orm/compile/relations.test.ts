import { afterEach, describe, expect, test, vi } from "vitest";

import { SqliteDialect } from "../dialect/sqlite";
import {
  RelationDepthExceededError,
  UnknownFieldError,
  UnknownRelationError,
  UnregisteredRelationTargetError,
  UnsupportedQueryError,
} from "../errors";
import { account, organization, post, tag, user } from "../fixtures";
import { clearRegistry, get, register } from "../registry";
import type { ModelSchema } from "../schema";
import { attachRelations } from "./plan-relations";
import { compileRead } from "./read";

const sqlite = new SqliteDialect();

// The batched strategy's own queries are `$exec` calls on the related model's
// class, and `$exec` is where the database is. So the whole planner — planning,
// batching, stitching, key hiding — is testable with no database at all, by
// registering model classes whose `$exec` reads an array. Which is also the
// assertion iteration 6 depends on: if a relation were loaded through a private
// helper instead, none of this would be reachable.
type Row = Record<string, unknown>;

function fake(schema: ModelSchema, table: Row[]) {
  return class {
    static $schema = schema;
    static $exec = vi.fn(async (_op: string, args: any) =>
      table.filter((row) => matches(row, args?.where)).map((row) => project(row, args?.select)),
    );
  };
}

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key === "AND") {
      if (!(value as any[]).every((part) => matches(row, part))) return false;
      continue;
    }
    if (value !== null && typeof value === "object" && "in" in (value as any)) {
      const wanted = (value as any).in.map(compare);
      if (!wanted.includes(compare(row[key]))) return false;
      continue;
    }
    if (compare(row[key]) !== compare(value)) return false;
  }
  return true;
}

/**
 * A real database compares a `Bytes` column by value; `Array.includes` compares
 * two `Uint8Array`s by reference. Without this the stand-in would find nothing
 * for a bytes key and the test would pass or fail for the wrong reason.
 */
function compare(value: unknown): unknown {
  return ArrayBuffer.isView(value)
    ? `bytes:${[...(value as Uint8Array)].join(",")}`
    : value;
}

function project(row: Row, select: any): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted === true) out[key] = row[key];
  }
  return out;
}

const ACCOUNTS: Row[] = [
  { id: 10, publicId: "a10", organizationId: 1, organizationRole: 0, userId: 1, createdAt: null, updatedAt: null, deletedAt: null },
  { id: 11, publicId: "a11", organizationId: 1, organizationRole: 2, userId: 1, createdAt: null, updatedAt: null, deletedAt: null },
  { id: 12, publicId: "a12", organizationId: null, organizationRole: 2, userId: 2, createdAt: null, updatedAt: null, deletedAt: null },
];

const ORGANIZATIONS: Row[] = [
  { id: 1, publicId: "o1", name: "Acme", logoUrl: null, description: null },
];

// Driver rows, keyed by *column* name — what `plan.shape` is handed.
const USER_ROWS: Row[] = [
  { id: 1, publicId: "p1", name: "Ada", email: "ada@x.dev", emailVerifiedAt: null, verificationToken: null, locale: null, globalRole: 0, password: null, organizationId: 1, createdAt: 0, updatedAt: 0, deletedAt: null },
  { id: 2, publicId: "p2", name: "Grace", email: null, emailVerifiedAt: null, verificationToken: null, locale: null, globalRole: 2, password: null, organizationId: null, createdAt: 0, updatedAt: 0, deletedAt: null },
  { id: 3, publicId: "p3", name: "Nobody", email: null, emailVerifiedAt: null, verificationToken: null, locale: null, globalRole: 2, password: null, organizationId: 1, createdAt: 0, updatedAt: 0, deletedAt: null },
];

function registerAll() {
  const models = {
    Account: fake(account, ACCOUNTS),
    Organization: fake(organization, ORGANIZATIONS),
    User: fake(user, []),
  };
  for (const [name, model] of Object.entries(models)) register(name, model);
  return models;
}

/**
 * The executor `Model.$exec` would have handed in, built from the same registry
 * so that spying on a fake model's `$exec` still observes the relation query.
 * `query` is only reached by the implicit m-n join hop.
 */
function executor(pairs: Row[] = []) {
  return {
    exec: (model: string, op: string, args: unknown) =>
      registryGet(model).$exec(op, args),
    query: vi.fn(async (_text: string, _values: unknown[]) => pairs),
  };
}

function registryGet(name: string) {
  return get<{ $exec: (op: string, args: unknown) => Promise<unknown> }>(name);
}

/** Compile, shape driver rows, load relations — the whole read path but the SQL. */
async function read(args: any, rows: Row[] = USER_ROWS) {
  const plan = compileRead(user, "findMany", args, sqlite);
  const shaped = plan.shape(rows);
  await attachRelations(plan.relations!, plan.hidden, shaped, args, executor());
  return shaped as Row[];
}

function compile(args: any, op: any = "findMany") {
  return compileRead(user, op, args, sqlite);
}

afterEach(() => {
  clearRegistry();
  vi.restoreAllMocks();
});

describe("planning", () => {
  test("an include adds no SQL of its own", () => {
    registerAll();
    const plan = compile({ include: { accounts: true } });

    // The root query is exactly the query it would have been without the
    // include. That is the batched strategy: relations cost queries, not joins.
    expect(plan.text).toBe(compile({}).text);
    expect(plan.relations).toHaveLength(1);
    expect(plan.relations![0]).toMatchObject({
      as: "accounts",
      kind: "many",
      parentField: "id",
      strategy: "batched",
    });
  });

  test("the owning side keys on its foreign key, the other side on the id", () => {
    registerAll();
    expect(compile({ include: { organization: true } }).relations![0]).toMatchObject({
      as: "organization",
      kind: "one",
      parentField: "organizationId",
    });
    expect(compile({ include: { accounts: true } }).relations![0].parentField).toBe(
      "id",
    );
  });

  test("a select that omits the join key still fetches it, hidden", () => {
    registerAll();
    const plan = compile({ select: { name: true, accounts: true } });
    expect(plan.text).toBe('select "id", "name" from "User"');
    expect(plan.hidden).toEqual(["id"]);
  });

  test("a select that names the key hides nothing", () => {
    registerAll();
    const plan = compile({ select: { id: true, accounts: true } });
    expect(plan.text).toBe('select "id" from "User"');
    expect(plan.hidden).toBeUndefined();
  });

  test("a select of nothing but relations is legal", () => {
    registerAll();
    const plan = compile({ select: { accounts: true } });
    expect(plan.text).toBe('select "id" from "User"');
    expect(plan.hidden).toEqual(["id"]);
  });

  test("a to-one select hides the foreign key it keyed on", () => {
    registerAll();
    const plan = compile({ select: { name: true, organization: true } });
    expect(plan.text).toBe('select "name", "organizationId" from "User"');
    expect(plan.hidden).toEqual(["organizationId"]);
  });

  test("two relations sharing a key add one column between them", () => {
    registerAll();
    // Both of Organization's relations key on `Organization.id`, so the column
    // is added once and hidden once.
    const plan = compileRead(
      organization,
      "findMany",
      { select: { name: true, users: true, accounts: true } },
      sqlite,
    );
    expect(plan.text).toBe('select "id", "name" from "Organization"');
    expect(plan.hidden).toEqual(["id"]);
    expect(plan.relations).toHaveLength(2);
  });

  // Invariant 2: the text is a function of the argument *shape*. A relation's
  // own `where` is values, so two calls that differ only there are one plan.
  test("nested filter values do not change the SQL", () => {
    registerAll();
    const a = compile({ include: { accounts: { where: { userId: 1 } } } });
    const b = compile({ include: { accounts: { where: { userId: 9999 } } } });
    expect(a.text).toBe(b.text);
  });

  test("count refuses include rather than ignoring it", () => {
    registerAll();
    expect(() => compile({ include: { accounts: true } }, "count")).toThrow(
      "gemi ORM does not support 'include' yet (User.count).",
    );
  });
});

describe("batched loading", () => {
  test("to-many: children arrive grouped, and an empty one is []", async () => {
    registerAll();
    const rows = await read({ include: { accounts: true } });

    expect(rows[0].accounts).toHaveLength(2);
    expect((rows[0].accounts as Row[]).map((row) => row.id)).toEqual([10, 11]);
    expect(rows[1].accounts).toHaveLength(1);
    // Not `null`, not a missing key. Prisma returns `[]`, and the differential
    // harness compares key presence.
    expect(rows[2].accounts).toEqual([]);
    expect("accounts" in rows[2]).toBe(true);
  });

  test("to-one: a match is the object, no match is null", async () => {
    registerAll();
    const rows = await read({ include: { organization: true } });

    expect(rows[0].organization).toMatchObject({ id: 1, name: "Acme" });
    // A null foreign key: `null`, not `undefined` and not an absent key.
    expect(rows[1].organization).toBeNull();
    expect("organization" in rows[1]).toBe(true);
  });

  test("a null foreign key is never sent to the database", async () => {
    const models = registerAll();
    await read({ include: { organization: true } });

    expect(models.Organization.$exec).toHaveBeenCalledWith("findMany", {
      where: { id: { in: [1] } },
    });
  });

  test("one query per relation node, whatever the number of parents", async () => {
    const models = registerAll();
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...USER_ROWS[0],
      id: index + 1,
    }));

    await read({ include: { accounts: true, organization: true } }, many);

    // Two nodes, two queries — not 200. This is the assertion that catches an
    // accidental N+1 later; the count is a property of the *tree*, not of N.
    expect(models.Account.$exec).toHaveBeenCalledTimes(1);
    expect(models.Organization.$exec).toHaveBeenCalledTimes(1);
  });

  test("the relation query is $exec on the related model's own class", async () => {
    const models = registerAll();
    await read({ include: { accounts: true } });

    // Iteration 6 hangs policies on `$exec`, so "the nested read went through
    // the child's own choke point" is the property that makes them apply to
    // nested reads at all. Asserted by observation, not by reading the code.
    expect(models.Account.$exec).toHaveBeenCalledTimes(1);
    expect(models.Account.$exec).toHaveBeenCalledWith("findMany", {
      where: { userId: { in: [1, 2, 3] } },
    });
    expect(models.User.$exec).not.toHaveBeenCalled();
  });

  test("a relation-level where is ANDed with the key filter", async () => {
    const models = registerAll();
    const rows = await read({
      include: { accounts: { where: { organizationRole: 0 } } },
    });

    expect(models.Account.$exec).toHaveBeenCalledWith("findMany", {
      where: {
        AND: [{ organizationRole: 0 }, { userId: { in: [1, 2, 3] } }],
      },
    });
    expect((rows[0].accounts as Row[]).map((row) => row.id)).toEqual([10]);
    expect(rows[1].accounts).toEqual([]);
  });

  test("orderBy and include pass through to the child query", async () => {
    const models = registerAll();
    await read({
      include: {
        accounts: { orderBy: { id: "desc" }, include: { organization: true } },
      },
    });

    expect(models.Account.$exec).toHaveBeenCalledWith("findMany", {
      where: { userId: { in: [1, 2, 3] } },
      orderBy: { id: "desc" },
      include: { organization: true },
    });
  });

  test("a nested select fetches the stitch key and then drops it", async () => {
    const models = registerAll();
    const rows = await read({
      include: { accounts: { select: { publicId: true } } },
    });

    expect(models.Account.$exec).toHaveBeenCalledWith("findMany", {
      where: { userId: { in: [1, 2, 3] } },
      select: { publicId: true, userId: true },
    });
    // The caller asked for one key and gets exactly one key.
    expect(rows[0].accounts).toEqual([
      { publicId: "a10" },
      { publicId: "a11" },
    ]);
  });

  test("a nested select that names the key keeps it", async () => {
    registerAll();
    const rows = await read({
      include: { accounts: { select: { userId: true } } },
    });
    expect(rows[0].accounts).toEqual([{ userId: 1 }, { userId: 1 }]);
  });

  test("the parent's hidden key is gone from the result", async () => {
    registerAll();
    const rows = await read({ select: { name: true, accounts: true } });

    expect(Object.keys(rows[0]).sort()).toEqual(["accounts", "name"]);
    expect(rows[0].accounts).toHaveLength(2);
  });

  test("no parents means no relation query at all", async () => {
    const models = registerAll();
    await read({ include: { accounts: true } }, []);
    expect(models.Account.$exec).not.toHaveBeenCalled();
  });
});

describe("rejected arguments", () => {
  test("select and include together, at the root", () => {
    registerAll();
    expect(() =>
      compile({ select: { id: true }, include: { accounts: true } }),
    ).toThrow(/only one of them/);
  });

  test("select and include together, nested", () => {
    registerAll();
    expect(() =>
      compile({
        include: {
          accounts: { select: { id: true }, include: { user: true } },
        },
      }),
    ).toThrow(/accounts: select \+ include/);
  });

  test("an include naming something that is not a relation", () => {
    registerAll();
    expect(() => compile({ include: { email: true } })).toThrow(
      UnknownRelationError,
    );
    expect(() => compile({ include: { nope: true } })).toThrow(
      /Known relations: organization, accounts/,
    );
  });

  // The decision recorded in the PR: refused rather than silently applied
  // globally, which would return wrong rows.
  test.each(["take", "skip"])(
    "%s on a to-many relation is refused, not approximated",
    (argument) => {
      registerAll();
      expect(() =>
        compile({ include: { accounts: { [argument]: 5 } } }),
      ).toThrow(UnsupportedQueryError);
      expect(() =>
        compile({ include: { accounts: { [argument]: 5 } } }),
      ).toThrow(/per parent.*lateral join strategy/s);
    },
  );

  test("take on a to-one relation says Prisma does not accept it", () => {
    registerAll();
    expect(() => compile({ include: { organization: { take: 1 } } })).toThrow(
      /Prisma does not accept 'take' on a to-one relation/,
    );
  });

  // Verified against Prisma rather than reasoned about: it rejects `orderBy` on
  // a to-one include — `Unknown argument 'orderBy'`, listing `where?` as one of
  // the options it does take — and accepts `where`, which filters and leaves
  // the relation `null` when nothing matches. Both halves matter: gating
  // `where` too would refuse a query Prisma runs.
  test("orderBy is refused on a to-one and accepted on a to-many", () => {
    registerAll();
    expect(() =>
      compile({ include: { organization: { orderBy: { id: "asc" } } } }),
    ).toThrow(/does not accept 'orderBy' on a to-one relation/);
    expect(() =>
      compile({ include: { accounts: { orderBy: { id: "asc" } } } }),
    ).not.toThrow();
  });

  test("where is accepted on both kinds", () => {
    registerAll();
    expect(() =>
      compile({ include: { organization: { where: { name: "Acme" } } } }),
    ).not.toThrow();
    expect(() =>
      compile({ include: { accounts: { where: { organizationRole: 0 } } } }),
    ).not.toThrow();
  });

  // The depth walk exists because a guard that sees one level at a time catches
  // things a query too late. A misspelled column is one of those things.
  test("a misspelled field deep in the tree is caught at root compile", () => {
    registerAll();
    expect(() =>
      compile({
        include: {
          accounts: { include: { user: { select: { emial: true } } } },
        },
      }),
    ).toThrow(UnknownFieldError);
    expect(() =>
      compile({
        include: { accounts: { select: { organizationRole: true } } },
      }),
    ).not.toThrow();
  });

  test("an unknown relation argument is named precisely", () => {
    registerAll();
    expect(() => compile({ include: { accounts: { cursor: {} } } })).toThrow(
      "gemi ORM does not support 'accounts.cursor' yet (User.findMany).",
    );
  });

  test("a relation node that is neither true nor an object", () => {
    registerAll();
    expect(() => compile({ include: { accounts: 1 as never } })).toThrow(
      /Expected true or an object/,
    );
  });

  test("include: false leaves the relation out entirely", () => {
    registerAll();
    const plan = compile({ include: { accounts: false } });
    expect(plan.relations).toBeUndefined();
  });
});

describe("guards", () => {
  test("an unregistered target names the model and the fix", () => {
    register("Organization", fake(organization, ORGANIZATIONS));
    // `Account` deliberately not registered: what a stale
    // app/models/generated looks like from the runtime's side.
    expect(() => compile({ include: { accounts: true } })).toThrow(
      UnregisteredRelationTargetError,
    );
    expect(() => compile({ include: { accounts: true } })).toThrow(
      /re-run `prisma generate`.*Registered models: Organization/s,
    );
  });

  test("a cyclic include is legal as long as it is finite", () => {
    registerAll();
    expect(() =>
      compile({
        include: { accounts: { include: { user: { include: { accounts: true } } } } },
      }),
    ).not.toThrow();
  });

  test("an unbounded include tree is refused", () => {
    registerAll();

    // `user -> accounts -> user -> ...`: legal, finite, and unbounded only
    // because something generated it. Ten levels is the limit; eleven is a tree
    // nothing wrote by hand.
    const nest = (levels: number, onUser = true): any =>
      levels === 0
        ? true
        : {
            include: onUser
              ? { accounts: nest(levels - 1, false) }
              : { user: nest(levels - 1, true) },
          };

    expect(() => compile(nest(10))).not.toThrow();
    expect(() => compile(nest(11))).toThrow(RelationDepthExceededError);
    expect(() => compile(nest(11))).toThrow(/nests more than 10 relations deep/);
  });
});

// Both sides of a stitch are decoded from the same declared type, so the only
// question is whether that decoded shape compares by value. Anything that does
// not, and is not normalised, silently produces empty relations rather than
// wrong ones — the quietest failure in the file.
describe("join keys that are not plain scalars", () => {
  /** `Bytes` on both sides: distinct Uint8Arrays holding the same bytes. */
  function bytesPair() {
    const owner: ModelSchema = {
      name: "Blob",
      table: "Blob",
      fields: {
        id: { name: "id", column: "id", type: "Bytes", nullable: false, isId: true, isUpdatedAt: false },
      },
      primaryKey: ["id"],
      uniques: [],
      relations: {
        chunks: { name: "chunks", model: "Chunk", kind: "many", relationName: "BlobToChunk", from: [], to: [], nullable: false },
      },
    };
    const child: ModelSchema = {
      name: "Chunk",
      table: "Chunk",
      fields: {
        id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false },
        blobId: { name: "blobId", column: "blobId", type: "Bytes", nullable: false, isId: false, isUpdatedAt: false },
      },
      primaryKey: ["id"],
      uniques: [],
      relations: {
        blob: { name: "blob", model: "Blob", kind: "one", relationName: "BlobToChunk", from: ["blobId"], to: ["id"], nullable: false },
      },
    };
    return { owner, child };
  }

  test("a Bytes key stitches by value, not by reference", async () => {
    const { owner, child } = bytesPair();
    register("Blob", fake(owner, []));
    register("Chunk", fake(child, [
      // A *different* Uint8Array holding the same bytes as the parent's id,
      // which is what comes back from a second query.
      { id: 1, blobId: new Uint8Array([1, 2, 3]) },
    ]));

    const plan = compileRead(owner, "findMany", { include: { chunks: true } }, sqlite);
    const rows = plan.shape([{ id: new Uint8Array([1, 2, 3]) }]) as Row[];
    await attachRelations(plan.relations!, plan.hidden, rows, {}, executor());

    expect(rows[0].chunks).toHaveLength(1);
  });

  test("a Json key is refused at compile, naming the field", () => {
    const { owner, child } = bytesPair();
    const json = { ...owner, fields: { id: { ...owner.fields.id, type: "Json" as const } } };
    register("Blob", fake(json, []));
    register("Chunk", fake(child, []));

    expect(() =>
      compileRead(json, "findMany", { include: { chunks: true } }, sqlite),
    ).toThrow(/joins on 'id', a Json/);
  });
});

describe("implicit many-to-many", () => {
  test("plans a two-hop join through the _Relation table", () => {
    register("Post", fake(post, []));
    register("Tag", fake(tag, []));

    const plan = compileRead(post, "findMany", { include: { tags: true } }, sqlite);
    expect(plan.relations![0]).toMatchObject({
      as: "tags",
      kind: "many",
      // Both sides join on their own primary key; the join table holds the pair.
      parentField: "id",
    });
    expect(plan.text).toBe('select "id", "title" from "Post"');
  });

  // The join table has no model, so its hop is the executor's `query` rather
  // than an `$exec` — which is exactly what makes it observable here.
  test("reads the pairs, then the rows, and stitches through both", async () => {
    register("Post", fake(post, []));
    const tags = fake(tag, [
      { id: 1, label: "red" },
      { id: 2, label: "blue" },
    ]);
    register("Tag", tags);

    const plan = compileRead(post, "findMany", { include: { tags: true } }, sqlite);
    const rows = plan.shape([
      { id: 1, title: "first" },
      { id: 2, title: "second" },
      { id: 3, title: "untagged" },
    ]) as Row[];

    const run = executor([
      { A: 1, B: 1 },
      { A: 1, B: 2 },
      { A: 2, B: 2 },
    ]);
    await attachRelations(plan.relations!, plan.hidden, rows, {}, run);

    // Parent ids go into the `A` side and come back as `B`s...
    expect(run.query).toHaveBeenCalledTimes(1);
    expect(run.query.mock.calls[0][0]).toBe(
      `select "A", "B" from "_PostToTag" where "A" in (?, ?, ?)`,
    );
    expect(run.query.mock.calls[0][1]).toEqual([1, 2, 3]);

    // ...and only the tags those pairs name are fetched, once.
    expect(tags.$exec).toHaveBeenCalledTimes(1);
    expect(tags.$exec).toHaveBeenCalledWith("findMany", {
      where: { id: { in: [1, 2] } },
    });

    expect(rows.map((row) => (row.tags as Row[]).map((t) => t.label))).toEqual([
      ["red", "blue"],
      ["blue"],
      [],
    ]);
  });

  test("refuses a self-referential implicit m-n rather than guessing", () => {
    const self: ModelSchema = {
      ...post,
      relations: {
        related: {
          name: "related",
          model: "Post",
          kind: "many",
          relationName: "PostToPost",
          from: [],
          to: [],
          nullable: false,
          joinTable: { table: "_PostToPost", a: "Post", b: "Post" },
        },
      },
    };
    register("Post", fake(self, []));

    expect(() =>
      compileRead(self, "findMany", { include: { related: true } }, sqlite),
    ).toThrow(/self-referential implicit many-to-many/);
  });
});
