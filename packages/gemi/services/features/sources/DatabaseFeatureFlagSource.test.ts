import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../../orm/registry";
import { DatabaseFeatureFlagSource } from "./DatabaseFeatureFlagSource";
import { FeatureModelMissingError } from "./FeatureFlagSource";

/**
 * The write path against a stand-in model. What it pins is the call the source
 * makes — an upsert keyed on `key`, under `asSystem`, with `updatedBy` only when
 * the model has the column. That the call round-trips through a real table is
 * `templates/saas-starter/app/models/features.test.ts`.
 */
function fakeModel(fields: Record<string, { type: string }>) {
  const calls: { args: any; system: boolean }[] = [];
  let system = false;
  const model = {
    $schema: { name: "Flags", fields },
    asSystem: async (fn: () => Promise<unknown>) => {
      system = true;
      try {
        return await fn();
      } finally {
        system = false;
      }
    },
    upsert: vi.fn(async (args: any) => {
      calls.push({ args, system });
      return {};
    }),
  };
  return { model, calls };
}

const baseFields = { key: { type: "String" }, active: { type: "Boolean" } };

describe("DatabaseFeatureFlagSource.write", () => {
  afterEach(() => registry.clearRegistry());

  test("upserts by key under asSystem, so a never-switched feature gets a row", async () => {
    const { model, calls } = fakeModel(baseFields);
    registry.register("Flags", model);

    const result = await new DatabaseFeatureFlagSource("Flags").write("new-checkout", true, {
      actor: null,
    });

    expect(calls).toEqual([
      {
        system: true,
        args: {
          where: { key: "new-checkout" },
          create: { key: "new-checkout", active: true },
          update: { active: true },
        },
      },
    ]);
    expect(result).toEqual({ actorRecorded: false });
  });

  test("leaves the actor out on a table without `updatedBy`, and says so", async () => {
    const { model, calls } = fakeModel(baseFields);
    registry.register("Flags", model);

    const result = await new DatabaseFeatureFlagSource("Flags").write("new-checkout", false, {
      actor: "usr_1",
    });

    expect(calls[0].args.update).toEqual({ active: false });
    expect(result).toEqual({ actorRecorded: false });
  });

  test("writes `updatedBy` when the model has it — null included, so a stale name is cleared", async () => {
    const { model, calls } = fakeModel({ ...baseFields, updatedBy: { type: "String" } });
    registry.register("Flags", model);
    const source = new DatabaseFeatureFlagSource("Flags");

    expect(await source.write("new-checkout", true, { actor: "usr_1" })).toEqual({
      actorRecorded: true,
    });
    await source.write("new-checkout", false, { actor: null });

    expect(calls[0].args).toEqual({
      where: { key: "new-checkout" },
      create: { key: "new-checkout", active: true, updatedBy: "usr_1" },
      update: { active: true, updatedBy: "usr_1" },
    });
    expect(calls[1].args.update).toEqual({ active: false, updatedBy: null });
  });

  test("throws FeatureModelMissingError when the model was never registered", async () => {
    await expect(
      new DatabaseFeatureFlagSource("Flags").write("new-checkout", true, { actor: null }),
    ).rejects.toBeInstanceOf(FeatureModelMissingError);
  });
});
