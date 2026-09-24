import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

// A file of its own: the module registry is per file, and any other test that
// had already called `DB.schema()` would have loaded the module this counts.
test("DB.schema() loads the introspection module on first use, not with the facade", async () => {
  let loads = 0;
  vi.doMock("./introspect", async (original) => {
    loads++;
    return original();
  });

  const { DB } = await import("../facades");
  const { Application } = await import("../foundation/Application");
  const { DatabaseManager } = await import("./DatabaseManager");
  // The `gemi/database` barrel too: it re-exports the introspection types, and
  // every app reaches it on the boot path through `defineDatabaseConfig`.
  await import("./index");
  expect(loads).toBe(0);

  const dir = mkdtempSync(join(tmpdir(), "gemi-introspect-lazy-"));
  const database = new DatabaseManager({ url: `sqlite://${join(dir, "lazy.db")}` });
  const previous = Application.getInstance();
  const application = new Application();
  application.instance(DatabaseManager, database as never);
  Application.setInstance(application);
  try {
    expect((await DB.schema()).dialect).toBe("sqlite");
    expect(loads).toBe(1);
  } finally {
    await database.close();
    if (previous) Application.setInstance(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
