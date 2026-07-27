import { beforeEach, describe, expect, test } from "vitest";

import { createBindContext } from "./compile/fragment";
import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { account, organization, user } from "./fixtures";
import * as registry from "./registry";
import {
  clearPlanCache,
  getOrCompile,
  planCacheStats,
  planKey,
  type Operation,
} from "./plan";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

beforeEach(() => {
  clearPlanCache();
  registry.clearRegistry();
  registry.register("User", class { static $schema = user });
  registry.register("Account", class { static $schema = account });
  registry.register("Organization", class { static $schema = organization });
});

/**
 * A plan-cache collision does not fail — it silently runs the wrong SQL for the
 * arguments it was handed. On a *read* that means wrong rows; on a write it
 * means wrong rows written, which does not come back.
 *
 * The write-specific hazard is the field set: `create({ data: { email } })` and
 * `create({ data: { email, name } })` are different column lists, and sharing a
 * plan between them would bind two values into a three-column insert — or write
 * a value into the wrong column.
 */
const DISTINCT: [string, Operation, unknown][] = [
  // --- create: the field set is the column list ------------------------
  ["create email", "create", { data: { email: "x" } }],
  ["create name", "create", { data: { name: "x" } }],
  ["create both", "create", { data: { email: "x", name: "y" } }],
  ["create three", "create", { data: { email: "x", name: "y", locale: "z" } }],
  // A null is still a bound value, but an *absent* key is a missing column.
  ["create explicit null", "create", { data: { email: null } }],
  ["create nothing", "create", { data: {} }],
  // The selection changes the returning list.
  ["create select id", "create", { data: { email: "x" }, select: { id: true } }],
  ["create select email", "create", {
    data: { email: "x" }, select: { email: true },
  }],
  ["create include", "create", {
    data: { email: "x" }, include: { accounts: true },
  }],

  // --- createMany: the row count is part of the text -------------------
  ["createMany 1", "createMany", { data: [{ email: "x" }] }],
  ["createMany 2", "createMany", { data: [{ email: "x" }, { email: "y" }] }],
  ["createMany 3", "createMany", {
    data: [{ email: "x" }, { email: "y" }, { email: "z" }],
  }],
  ["createMany 0", "createMany", { data: [] }],
  // Same count, different union of keys.
  ["createMany 2 wider", "createMany", {
    data: [{ email: "x", name: "a" }, { email: "y" }],
  }],

  // --- update: the set clause and the where are both structural --------
  ["update name", "update", { where: { id: 1 }, data: { name: "x" } }],
  ["update email", "update", { where: { id: 1 }, data: { email: "x" } }],
  ["update both", "update", {
    where: { id: 1 }, data: { name: "x", email: "y" },
  }],
  ["update increment", "update", {
    where: { id: 1 }, data: { globalRole: { increment: 1 } },
  }],
  ["update decrement", "update", {
    where: { id: 1 }, data: { globalRole: { decrement: 1 } },
  }],
  ["update multiply", "update", {
    where: { id: 1 }, data: { globalRole: { multiply: 1 } },
  }],
  ["update divide", "update", {
    where: { id: 1 }, data: { globalRole: { divide: 1 } },
  }],
  ["update set", "update", {
    where: { id: 1 }, data: { globalRole: { set: 1 } },
  }],
  ["update by publicId", "update", {
    where: { publicId: "x" }, data: { name: "y" },
  }],

  ["updateMany", "updateMany", { where: { name: "x" }, data: { name: "y" } }],
  ["updateMany other where", "updateMany", {
    where: { email: "x" }, data: { name: "y" },
  }],
  ["updateMany no where", "updateMany", { data: { name: "y" } }],

  // --- delete ----------------------------------------------------------
  ["delete by id", "delete", { where: { id: 1 } }],
  ["delete by publicId", "delete", { where: { publicId: "x" } }],
  ["delete select", "delete", { where: { id: 1 }, select: { id: true } }],
  ["deleteMany", "deleteMany", { where: { name: "x" } }],
  ["deleteMany other", "deleteMany", { where: { email: "x" } }],
  ["deleteMany all", "deleteMany", {}],

  // --- upsert ----------------------------------------------------------
  ["upsert by email", "upsert", {
    where: { email: "x" }, create: { email: "x" }, update: { name: "y" },
  }],
  ["upsert by email wider create", "upsert", {
    where: { email: "x" },
    create: { email: "x", name: "n" },
    update: { name: "y" },
  }],
  ["upsert by email wider update", "upsert", {
    where: { email: "x" },
    create: { email: "x" },
    update: { name: "y", locale: "z" },
  }],
  ["upsert by publicId", "upsert", {
    where: { publicId: "x" }, create: { publicId: "x" }, update: { name: "y" },
  }],

  // --- nested writes are structural too --------------------------------
  ["create connect by key", "create", {
    data: { email: "x", organization: { connect: { id: 1 } } },
  }],
  // A different unique means a lookup step instead of a bound column: same
  // model, same relation, genuinely different plan.
  ["create connect by other unique", "create", {
    data: { email: "x", organization: { connect: { publicId: "p" } } },
  }],
  ["create nested create", "create", {
    data: { email: "x", organization: { create: { name: "n" } } },
  }],
  ["create nested child create", "create", {
    data: { email: "x", accounts: { create: { organizationRole: 1 } } },
  }],
];

describe("plan cache discrimination — writes", () => {
  test("every shape in the table gets its own key", () => {
    const keys = new Map<string, string>();
    for (const [label, op, args] of DISTINCT) {
      const key = planKey(sqlite, "User", op, args);
      const clash = keys.get(key);
      expect(clash, `"${label}" collides with "${clash}"`).toBeUndefined();
      keys.set(key, label);
    }
    expect(keys.size).toBe(DISTINCT.length);
  });

  // The key is only half of it: two shapes hashing apart but compiling to the
  // same plan would mean the extra entries buy nothing, while two shapes
  // hashing together and compiling differently is the dangerous direction.
  //
  // A plan is the text, what it binds, *and* the work hanging off it — several
  // of these emit identical SQL and differ only in which argument each
  // parameter reads, or in the relations and nested steps attached. An
  // `include` on a write is the clearest case: same insert, same parameters,
  // plus a second query the caller very much asked for.
  test("every shape in the table produces its own plan", () => {
    const plans = new Map<string, string>();

    for (const [label, op, args] of DISTINCT) {
      const plan = getOrCompile(user, op, args, sqlite);
      // Bound with a fixed context so the generated defaults — a cuid per call,
      // a fresh `now` — do not make every plan trivially unique.
      const context = { now: new Date(0), resolved: {} };
      const bound = plan
        .bind(args, context)
        .map((value) =>
          typeof value === "string" && /^c[a-z0-9]{24}$/.test(value)
            ? "<cuid>"
            : value,
        );
      const attached = JSON.stringify({
        relations: plan.relations?.map((relation) => relation.as) ?? [],
        before:
          plan.before?.map((step) => `${step.relation}:${step.operation}`) ?? [],
        after:
          plan.after?.map((step) => `${step.relation}:${step.operation}`) ?? [],
        hidden: plan.hidden ?? [],
        // How the result is read back. `create` with `select: { id: true }` and
        // `createMany` of one row compile to byte-identical SQL binding
        // identical parameters, and differ only here — one returns the row,
        // the other a count. They cannot collide, because the operation is part
        // of the cache key, but the identity has to say so rather than assume.
        empty: plan.shape([]),
      });
      const identity = `${plan.text} ${JSON.stringify(bound)} ${attached}`;

      const clash = plans.get(identity);
      expect(
        clash,
        `"${label}" is indistinguishable from "${clash}":\n  ${identity}`,
      ).toBeUndefined();
      plans.set(identity, label);
    }
  });

  // The property that makes the cache worth having: values vary freely, the
  // plan does not.
  test("a create with the same field set is one plan whatever the values", () => {
    for (const email of ["a@x", "b@x", "c@x", "d@x"]) {
      getOrCompile(user, "create", { data: { email } }, sqlite);
    }
    expect(planCacheStats().compiles).toBe(1);
    expect(planCacheStats().hits).toBe(3);
  });

  test("the same write on two dialects is two plans", () => {
    const args = { data: { email: "x" } };
    expect(planKey(sqlite, "User", "create", args)).not.toBe(
      planKey(postgres, "User", "create", args),
    );
  });

  // Two operations that compile to different statements must not be able to
  // share an entry just because their argument trees look alike.
  test("operation is part of the key", () => {
    const args = { where: { id: 1 }, data: { name: "x" } };
    expect(planKey(sqlite, "User", "update", args)).not.toBe(
      planKey(sqlite, "User", "updateMany", args),
    );
  });

  test("model is part of the key", () => {
    const args = { data: { publicId: "x" } };
    expect(planKey(sqlite, "User", "create", args)).not.toBe(
      planKey(sqlite, "Account", "create", args),
    );
  });

  // A plan outlives the call that compiled it, so anything minted per call has
  // to be read from the bind context rather than captured at compile time.
  test("a cached plan mints a fresh cuid and timestamp on every call", () => {
    const args = { data: { email: "x" } };

    const first = getOrCompile(user, "create", args, sqlite).bind(
      args,
      createBindContext(),
    );
    const second = getOrCompile(user, "create", args, sqlite).bind(
      args,
      createBindContext(),
    );

    expect(planCacheStats().compiles).toBe(1);
    // publicId is the first column, and it must differ between the two calls.
    expect(first[0]).not.toBe(second[0]);
    expect(String(first[0])).toMatch(/^c[a-z0-9]{24}$/);
    expect(String(second[0])).toMatch(/^c[a-z0-9]{24}$/);
  });
});
