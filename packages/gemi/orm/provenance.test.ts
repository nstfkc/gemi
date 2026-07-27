import { describe, expect, test } from "vitest";

import { organization, user } from "./fixtures";
import {
  changedFields,
  isTracked,
  provenanceOf,
  resnapshot,
  track,
} from "./provenance";

/**
 * Provenance, tested as the pure functions it is — no database, no query.
 *
 * The end-to-end behaviour (`save` writing only changed columns, policies and
 * `@updatedAt` applying) is in the template suite where there is a real `$exec`.
 * What belongs here is the bookkeeping: what gets snapshotted, what counts as
 * changed, and the identity semantics that make a spread row unsaveable.
 */

describe("what gets snapshotted", () => {
  test("only the fields actually present on the row", () => {
    // A partial select: the row has two of the model's fields.
    const row = { id: 1, email: "a@b.c" };
    track(row, user, []);

    expect(provenanceOf(row)?.snapshot).toEqual({ id: 1, email: "a@b.c" });
  });

  test("the primary key is captured separately, at fetch time", () => {
    const row = { id: 7, email: "a@b.c" };
    track(row, user, []);

    // Captured rather than read at save time, so mutating `id` cannot move the
    // row a save targets — it would otherwise update a different record.
    row.id = 9;
    expect(provenanceOf(row)?.key).toEqual({ id: 7 });
  });

  test("relation keys are excluded", () => {
    const row = { id: 1, email: "a@b.c", accounts: [] as unknown[] };
    track(row, user, ["accounts"]);

    // An attached child array in the snapshot would make every save look dirty,
    // since the relation loader replaces it.
    expect(provenanceOf(row)?.snapshot).toEqual({ id: 1, email: "a@b.c" });
  });

  test("keys that are not fields are ignored", () => {
    const row = { id: 1, notAField: true };
    track(row, user, []);
    expect(provenanceOf(row)?.snapshot).toEqual({ id: 1 });
  });

  test("the model name is recorded", () => {
    const row = { id: 1 };
    track(row, organization, []);
    expect(provenanceOf(row)?.model).toBe("Organization");
  });
});

describe("what counts as changed", () => {
  test("an untouched row has no changes", () => {
    const row = { id: 1, email: "a@b.c", name: "A" };
    track(row, user, []);
    expect(changedFields(row)).toEqual({});
  });

  test("only the mutated field", () => {
    const row: any = { id: 1, email: "a@b.c", name: "A" };
    track(row, user, []);
    row.name = "B";

    expect(changedFields(row)).toEqual({ name: "B" });
  });

  test("setting a field back to its fetched value is not a change", () => {
    const row: any = { id: 1, name: "A" };
    track(row, user, []);
    row.name = "B";
    row.name = "A";

    expect(changedFields(row)).toEqual({});
  });

  test("null and undefined are distinguished from a value", () => {
    const row: any = { id: 1, name: "A", deletedAt: null };
    track(row, user, []);
    row.name = null;

    expect(changedFields(row)).toEqual({ name: null });
  });

  /**
   * `!==` is wrong for a `Date`: two objects for the same instant are different
   * references. Without this every save of a row carrying a timestamp would
   * rewrite that timestamp — and on a model with `@updatedAt` that means every
   * save of an otherwise-unchanged row issues a statement.
   */
  test("a Date is compared by instant, not by reference", () => {
    const row: any = { id: 1, createdAt: new Date("2024-01-01T00:00:00Z") };
    track(row, user, []);

    row.createdAt = new Date("2024-01-01T00:00:00Z");
    expect(changedFields(row)).toEqual({});

    row.createdAt = new Date("2024-06-01T00:00:00Z");
    expect(changedFields(row)).toHaveProperty("createdAt");
  });

  test("a field the row never fetched is never written", () => {
    // `password` was not selected, so it is not in the snapshot. Assigning it
    // cannot produce an update for it — writing a column the caller never read
    // is how a partial select silently reverts data.
    const row: any = { id: 1, email: "a@b.c" };
    track(row, user, []);
    row.password = "hunter2";

    expect(changedFields(row)).toEqual({});
  });

  test("an untracked object reports no changes rather than throwing", () => {
    // `save` is the layer that raises; the diff itself is a query, and a query
    // about an unknown object has an answer.
    expect(changedFields({ id: 1 })).toEqual({});
  });
});

describe("identity semantics", () => {
  /**
   * The first thing anyone will hit, so it is pinned rather than only
   * documented. Provenance is keyed on the object, so any copy is a new object
   * with none — and `save` must fail loudly there rather than guessing, because
   * the guess would be "write every column".
   */
  test("a spread copy carries no provenance", () => {
    const row = { id: 1, email: "a@b.c" };
    track(row, user, []);

    expect(isTracked(row)).toBe(true);
    expect(isTracked({ ...row })).toBe(false);
  });

  test("a JSON round trip carries no provenance", () => {
    const row = { id: 1, email: "a@b.c" };
    track(row, user, []);
    expect(isTracked(JSON.parse(JSON.stringify(row)))).toBe(false);
  });

  test("a primitive or null is not tracked and does not throw", () => {
    expect(isTracked(null)).toBe(false);
    expect(isTracked(undefined)).toBe(false);
    expect(isTracked(42)).toBe(false);
    expect(isTracked("row")).toBe(false);
  });

  test("two rows tracked separately do not share a snapshot", () => {
    const a: any = { id: 1, name: "A" };
    const b: any = { id: 2, name: "B" };
    track(a, user, []);
    track(b, user, []);

    a.name = "changed";
    expect(changedFields(a)).toEqual({ name: "changed" });
    expect(changedFields(b)).toEqual({});
  });
});

describe("resnapshot", () => {
  test("a second save of the same row is a no-op", () => {
    const row: any = { id: 1, name: "A" };
    track(row, user, []);
    row.name = "B";

    const changed = changedFields(row);
    expect(changed).toEqual({ name: "B" });

    resnapshot(row, changed);
    expect(changedFields(row)).toEqual({});
  });

  test("only the written fields are resnapshotted", () => {
    const row: any = { id: 1, name: "A", locale: "en-US" };
    track(row, user, []);
    row.name = "B";
    row.locale = "en-GB";

    // Pretend only `name` was written.
    resnapshot(row, { name: "B" });

    expect(changedFields(row)).toEqual({ locale: "en-GB" });
  });

  test("resnapshotting an untracked object is a no-op, not a throw", () => {
    expect(() => resnapshot({ id: 1 }, { name: "B" })).not.toThrow();
  });
});
