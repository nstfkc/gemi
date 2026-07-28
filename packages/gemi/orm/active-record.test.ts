import { describe, expect, test } from "vitest";

import { ActiveRecordModel } from "./active-record";
import { SqliteDialect } from "./dialect";
import { buildRowShaper } from "./shape";
import { user } from "./fixtures";
import type { QueryPlan } from "./plan";

/**
 * Iteration 8, acceptance criterion 7: `ActiveRecordModel` works **purely** by
 * overriding `$shape`, with no changes to any operation.
 *
 * The criterion says that if it cannot, that is a finding to report rather than a
 * workaround to write. It can — and this file is the evidence, tested against
 * `$shape` directly rather than through a query, because the claim is about the
 * seam and not about the database.
 */

const sqlite = new SqliteDialect();

/** A plan whose `shape` is the real shaper, so decoding is exercised too. */
function planFor(rows: unknown[], single: boolean): QueryPlan {
  const shaper = buildRowShaper(Object.values(user.fields), sqlite);
  return {
    text: "",
    bind: () => [],
    shape: (input: unknown[]) => {
      const shaped = shaper(input);
      return single ? (shaped[0] ?? null) : shaped;
    },
  };
}

class Entity extends ActiveRecordModel {
  static $schema = user;

  get displayName(): string {
    return (this as any).name ?? (this as any).email ?? "anonymous";
  }
}

describe("ActiveRecordModel", () => {
  test("a list operation yields instances", () => {
    const result = Entity.$shape(planFor([{ id: 1, name: "A" }], false), [
      { id: 1, name: "A" },
    ]) as any[];

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Entity);
    expect(result[0].displayName).toBe("A");
  });

  test("a single-row operation yields one instance", () => {
    const result = Entity.$shape(planFor([{ id: 1, name: "A" }], true), [
      { id: 1, name: "A" },
    ]) as any;

    expect(result).toBeInstanceOf(Entity);
    expect(result.id).toBe(1);
  });

  /**
   * The cases that must fall *through* untouched. Hydrating either would be the
   * kind of per-operation special case this override exists to show is
   * unnecessary — `$shape` sees rows or it sees something that is not a row, and
   * it does not need to know which of the twelve operations produced it.
   */
  test("a no-match single-row operation stays null", () => {
    expect(Entity.$shape(planFor([], true), [])).toBeNull();
  });

  test("a counting operation stays a count", () => {
    const plan: QueryPlan = {
      text: "",
      bind: () => [],
      shape: (rows) => ({ count: rows.length }),
    };
    expect(Entity.$shape(plan, [{ id: 1 }, { id: 2 }])).toEqual({ count: 2 });
  });

  test("a scalar result stays scalar", () => {
    const plan: QueryPlan = { text: "", bind: () => [], shape: () => 7 };
    expect(Entity.$shape(plan, [])).toBe(7);
  });

  // The shaper still does the work — decoding, column-to-field mapping, relation
  // placeholders. The override only decides what the data is carried in, which is
  // why it needs no knowledge of any of that.
  test("decoding still happens", () => {
    const result = Entity.$shape(
      planFor([{ id: 1, createdAt: 1_700_000_000_000 }], true),
      [{ id: 1, createdAt: 1_700_000_000_000 }],
    ) as any;

    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.getTime()).toBe(1_700_000_000_000);
  });

  test("instances are tracked, so save works on a queried row", () => {
    const result = Entity.$shape(planFor([{ id: 1, name: "A" }], true), [
      { id: 1, name: "A" },
    ]) as any;

    // Reuses `Model.wrap`, so there is one definition of "a row became an
    // instance" rather than two that can drift.
    expect(typeof result.save).toBe("function");
  });

  /**
   * The cost, asserted rather than only warned about: hydration here is
   * unconditional, so a partial row produces an instance whose methods can read
   * fields the query never fetched. `wrap` refuses that at compile time; this
   * tier cannot, which is why it ships as a documented example rather than a
   * supported one.
   */
  test("a partial row still hydrates, which is the tier's known cost", () => {
    const narrow = buildRowShaper([user.fields.id], sqlite);
    const plan: QueryPlan = {
      text: "",
      bind: () => [],
      shape: (rows) => narrow(rows)[0] ?? null,
    };

    const result = Entity.$shape(plan, [{ id: 1 }]) as any;

    expect(result).toBeInstanceOf(Entity);
    // `name` and `email` were never fetched, so a method reading them gets the
    // fallback rather than data — silently, which is the whole objection.
    expect(result.displayName).toBe("anonymous");
  });
});
