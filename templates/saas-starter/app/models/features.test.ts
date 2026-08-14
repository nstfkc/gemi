import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { FeatureRouter } from "gemi/http";
import { register } from "gemi/orm";
import {
  DatabaseFeatureFlagSource,
  FeatureManager,
  featuresConfigDefaults,
} from "gemi/services";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL, applyMigrations } from "./scratch";
import { FeatureFlagModel } from "./generated";

/**
 * The feature flag chain against a real database: a row goes in, and the value a
 * page would render comes out.
 *
 * `packages/gemi` covers evaluation, bucketing and normalization as pure
 * functions. What needs a database is the part those cannot reach — that the
 * `Json` columns round-trip through the ORM on both dialects, and that the
 * source's `where: { archivedAt: null }` matches the schema the migration
 * actually created.
 */
class AppFeatures extends FeatureRouter {
  features = {
    "new-checkout": this.boolean(false),
    "pricing-page": this.variant(["a", "b", "control"], "control"),
    "seat-limit": this.number(5),
  };
}

function manager() {
  return new FeatureManager(
    {
      ...featuresConfigDefaults(),
      router: AppFeatures,
      source: new DatabaseFeatureFlagSource("FeatureFlag"),
      ttl: 0,
    } as never,
    () => {},
  );
}

describe.each([
  ["sqlite", undefined],
  ["postgres", POSTGRES_URL],
])("feature flags on %s", (dialect, url) => {
  const enabled = dialect === "sqlite" || Boolean(url);

  describe.skipIf(!enabled)("", () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-features-"));
        const path = join(workspace, "features.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);

      register("FeatureFlag", FeatureFlagModel);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await raw`delete from "FeatureFlag"`;
    });

    async function seed(row: Record<string, unknown>) {
      await FeatureFlagModel.asSystem(() =>
        FeatureFlagModel.create({
          // `seed` is named per key rather than left to `@default(cuid())` so
          // the bucketing assertions below are reproducible run to run.
          data: { seed: `seed-${row.key}`, updatedAt: new Date(), ...row } as never,
        }),
      );
    }

    test("an empty table serves every declared default", async () => {
      const features = manager();

      expect(await features.value("pricing-page")).toBe("control");
      expect(await features.enabled("new-checkout")).toBe(false);
      expect(await features.value("seat-limit")).toBe(5);
    });

    test("a row turns a flag on", async () => {
      await seed({ key: "new-checkout", enabled: true, defaultValue: true });

      expect(await manager().enabled("new-checkout")).toBe(true);
    });

    test("enabled false is the kill switch", async () => {
      await seed({
        key: "new-checkout",
        enabled: false,
        rules: [{ id: "r1", value: true }],
      });

      expect(await manager().enabled("new-checkout")).toBe(false);
    });

    test("Json rule columns round-trip", async () => {
      await seed({
        key: "pricing-page",
        enabled: true,
        defaultValue: "control",
        rules: [
          {
            id: "r1",
            conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
            value: "a",
          },
        ],
      });

      const features = manager();

      expect(await features.for({ attributes: { plan: "pro" } }).value("pricing-page")).toBe("a");
      expect(await features.for({ attributes: { plan: "free" } }).value("pricing-page")).toBe(
        "control",
      );
    });

    test("weighted variants round-trip and split the audience", async () => {
      await seed({
        key: "pricing-page",
        enabled: true,
        defaultValue: "control",
        rules: [
          {
            id: "r1",
            variants: [
              { value: "a", weight: 50 },
              { value: "b", weight: 50 },
            ],
          },
        ],
      });

      const features = manager();
      const seen = new Set<unknown>();
      for (let i = 0; i < 100; i++) {
        seen.add(await features.for({ subjectId: `user-${i}` }).value("pricing-page"));
      }

      expect(seen).toEqual(new Set(["a", "b"]));
    });

    test("archived rows are not loaded", async () => {
      await seed({
        key: "new-checkout",
        enabled: true,
        defaultValue: true,
        archivedAt: new Date(),
      });

      // Falls back to the declared default, as though the row were absent.
      expect(await manager().enabled("new-checkout")).toBe(false);
    });

    test("a row for an undeclared key is ignored rather than fatal", async () => {
      await seed({ key: "not-declared", enabled: true, defaultValue: true });
      await seed({ key: "new-checkout", enabled: true, defaultValue: true });

      const features = manager();

      expect(await features.enabled("new-checkout")).toBe(true);
      expect(await features.explain("not-declared")).toMatchObject({ reason: "unknown" });
    });

    test("a malformed rules column degrades instead of throwing", async () => {
      // Writing raw, because the ORM would reject this shape.
      await seed({ key: "new-checkout", enabled: true, defaultValue: true });
      await raw`update "FeatureFlag" set "rules" = '"not an array"' where "key" = 'new-checkout'`;

      const features = manager();

      // The flag still resolves — from `defaultValue`, with the rules ignored.
      expect(await features.enabled("new-checkout")).toBe(true);
    });

    test("the client payload carries values only", async () => {
      await seed({
        key: "new-checkout",
        enabled: true,
        defaultValue: true,
        rules: [{ id: "secret-rule", value: true }],
      });

      const serialized = JSON.stringify(await manager().forClient());

      for (const leak of ["secret-rule", "seed-new-checkout", "reason", "ruleId", "rules"]) {
        expect(serialized, `payload leaked ${leak}`).not.toContain(leak);
      }
    });
  });
});
