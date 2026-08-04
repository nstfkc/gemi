import { describe, expect, test } from "vitest";

import { UnsupportedQueryError } from "./errors";
import { user } from "./fixtures";
import { softDelete, softDeleteMany } from "./soft-deletes";

/**
 * The refusal `softDelete` raises when the caller passes a `data`.
 *
 * It reported the literal string `"soft delete"` as the model.
 * `UnsupportedQueryError` documents `model` as inspectable, and that is not a
 * model name — nothing can ever match it (#112). The real one was in hand: the
 * wrapped model carries `$schema`, which the structural parameter type was
 * hiding rather than the value being absent.
 *
 * `softDelete` had no test at all, which is how it stayed that way.
 */
describe("softDelete refuses a data argument", () => {
  // Stands in for a generated model: the write to delegate to, and `$schema`.
  const model = {
    calls: [] as unknown[],
    $schema: user,
    update(args: unknown) {
      this.calls.push(args);
      return Promise.resolve({ id: 1 });
    },
    updateMany(args: unknown) {
      this.calls.push(args);
      return Promise.resolve({ count: 1 });
    },
  };

  const caught = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return null;
    } catch (error) {
      return error as UnsupportedQueryError;
    }
  };

  test.each([
    ["delete", () => softDelete(model)({ where: { id: 1 }, data: { name: "x" } })],
    [
      "deleteMany",
      () => softDeleteMany(model)({ where: { id: 1 }, data: { name: "x" } }),
    ],
  ])("%s names the model it was built for", async (operation, run) => {
    const error = await caught(run);

    expect(error).toBeInstanceOf(UnsupportedQueryError);
    expect(error!.model).toBe("User");
    expect(error!.operation).toBe(operation);
    expect(error!.argument).toBe("data");
  });

  // The other half: it refuses instead of writing, rather than doing both.
  test("nothing is delegated when it refuses", async () => {
    model.calls.length = 0;
    await caught(() => softDelete(model)({ where: { id: 1 }, data: {} }));
    expect(model.calls).toEqual([]);
  });

  test("without a data it delegates, stamping the timestamp", async () => {
    model.calls.length = 0;
    await softDelete(model)({ where: { id: 1 } });

    expect(model.calls).toHaveLength(1);
    const args = model.calls[0] as { where: unknown; data: { deletedAt: Date } };
    expect(args.where).toEqual({ id: 1 });
    expect(args.data.deletedAt).toBeInstanceOf(Date);
  });

  test("the field is configurable, and the refusal is not", async () => {
    model.calls.length = 0;
    await softDelete(model, { field: "archivedAt" })({ where: { id: 1 } });

    const args = model.calls[0] as { data: Record<string, unknown> };
    expect(args.data.archivedAt).toBeInstanceOf(Date);

    const error = await caught(() =>
      softDelete(model, { field: "archivedAt" })({ data: {} }),
    );
    expect(error!.model).toBe("User");
  });
});
