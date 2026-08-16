import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { register } from "gemi/orm";
import {
  DatabaseFeatureFlagSource,
  defineFeature,
  FeatureManager,
  featuresConfigDefaults,
} from "gemi/services";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL, applyMigrations } from "./scratch";
import { FeatureFlagModel } from "./generated";

/**
 * The feature chain against a real database: a row goes in, and the answer a
 * page would render comes out.
 *
 * `packages/gemi` covers evaluation and bucketing as pure functions. What needs
 * a database is the part those cannot reach — that the columns round-trip
 * through the ORM on both dialects, and that the source's query matches the
 * schema the migration actually created.
 */
const AppFeatures = {
  "new-checkout": defineFeature(),
  "pricing-redesign": defineFeature({ rollout: 50 }),
  "internal-tools": defineFeature({ serverOnly: true }),
};

function manager() {
  return new FeatureManager(
    {
      ...featuresConfigDefaults(),
      features: AppFeatures,
      source: new DatabaseFeatureFlagSource("FeatureFlag"),
      ttl: 0,
    } as never,
    () => {},
  );
}

describe.each([
  ["sqlite", undefined],
  ["postgres", POSTGRES_URL],
])("features on %s", (dialect, url) => {
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

    async function seed(key: string, active: boolean) {
      await FeatureFlagModel.asSystem(() =>
        FeatureFlagModel.create({
          data: { key, active, updatedAt: new Date() } as never,
        }),
      );
    }

    test("an empty table leaves every feature off", async () => {
      const features = manager();

      expect(await features.enabled("new-checkout")).toBe(false);
      expect(await features.enabled("pricing-redesign")).toBe(false);
    });

    test("a row switches a feature on", async () => {
      await seed("new-checkout", true);

      expect(await manager().enabled("new-checkout")).toBe(true);
    });

    test("active false is the kill switch", async () => {
      await seed("new-checkout", false);

      expect(await manager().enabled("new-checkout")).toBe(false);
    });

    test("the boolean column round-trips on this dialect", async () => {
      await seed("new-checkout", true);
      await seed("pricing-redesign", false);

      const features = manager();

      expect(await features.explain("new-checkout")).toMatchObject({ value: true });
      expect(await features.explain("pricing-redesign")).toMatchObject({
        reason: "inactive",
      });
    });

    test("a switched-on rollout splits the audience deterministically", async () => {
      await seed("pricing-redesign", true);
      const features = manager();

      const first = new Map<string, boolean>();
      for (let i = 0; i < 100; i++) {
        const id = `user-${i}`;
        first.set(id, await features.for({ subjectId: id }).enabled("pricing-redesign"));
      }

      // Both sides are represented...
      expect(new Set(first.values())).toEqual(new Set([true, false]));

      // ...and the assignment does not move on a re-read.
      for (const [id, value] of first) {
        expect(await features.for({ subjectId: id }).enabled("pricing-redesign")).toBe(value);
      }
    });

    test("a row for an undeclared key is ignored rather than fatal", async () => {
      await seed("not-declared", true);
      await seed("new-checkout", true);

      const features = manager();

      expect(await features.enabled("new-checkout")).toBe(true);
      expect(await features.explain("not-declared")).toMatchObject({ reason: "undeclared" });
    });

    test("the client payload carries booleans only", async () => {
      await seed("new-checkout", true);
      await seed("internal-tools", true);

      const payload = await manager().forClient();

      expect(payload).not.toHaveProperty("internal-tools");
      for (const value of Object.values(payload)) {
        expect(typeof value).toBe("boolean");
      }
      expect(JSON.stringify(payload)).not.toMatch(/reason|publicId|updatedAt/);
    });
  });
});
