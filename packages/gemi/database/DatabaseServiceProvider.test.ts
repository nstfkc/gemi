import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Application } from "../foundation/Application";
import { DatabaseManager } from "./DatabaseManager";
import { DatabaseServiceProvider } from "./DatabaseServiceProvider";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gemi-db-provider-"));
});

afterEach(() => {
  Application.setInstance(undefined);
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

function application() {
  const app = new Application();
  app.config.merge({ database: { url: `sqlite://${join(workspace, "t.db")}` } });
  app.registerMany([DatabaseServiceProvider]);
  return app;
}

// The pool a `gemi dev` reload used to leave open, ten connections at a time
// (#652): the replaced application is shut down, and this is what closes its
// pool when it is.
describe("DatabaseServiceProvider.shutdown", () => {
  test("closes the pool the application opened", async () => {
    const app = application();
    const database = app.make(DatabaseManager);
    await database.ready;
    const close = vi.spyOn(database, "close");

    expect(await app.shutdown({ timeoutMs: 1_000 })).toEqual({ failed: [], timedOut: [] });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("opens no pool just to close it", async () => {
    const app = application();
    const close = vi.spyOn(DatabaseManager.prototype, "close");

    expect(await app.shutdown({ timeoutMs: 1_000 })).toEqual({ failed: [], timedOut: [] });
    expect(app.resolved(DatabaseManager)).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
