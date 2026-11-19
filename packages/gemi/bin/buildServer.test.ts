import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

import { buildServerEntries, serverEntrypoints } from "./buildServer";

/**
 * The server half of `gemi build` (#1318): `dist/server/bootstrap.mjs` is what
 * a `worker = true` job's thread imports in production when the app has an
 * `app/bootstrap.ts`, and no build emitted it.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function app(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "gemi-build-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

test("emits bootstrap.mjs beside server.mjs when the app has app/bootstrap.ts", async () => {
  const root = app({
    "app/server.ts": `import { boot } from "./boot"; boot("server");`,
    "app/bootstrap.ts": `import { boot } from "./boot"; export const app = boot("bootstrap");`,
    "app/boot.ts": `export function boot(name: string) { return { name }; }`,
  });
  expect(serverEntrypoints(root)).toEqual(["./app/server.ts", "./app/bootstrap.ts"]);

  const result = await buildServerEntries(root, []);
  expect(result.success, result.logs.join("\n")).toBe(true);
  expect(existsSync(join(root, "dist/server/server.mjs"))).toBe(true);
  expect(existsSync(join(root, "dist/server/bootstrap.mjs"))).toBe(true);
  const { app: built } = await import(join(root, "dist/server/bootstrap.mjs"));
  expect(built).toEqual({ name: "bootstrap" });
});

test("emits server.mjs alone for an app without a bootstrap", async () => {
  const root = app({ "app/server.ts": `console.log("server");` });
  expect(serverEntrypoints(root)).toEqual(["./app/server.ts"]);

  const result = await buildServerEntries(root, []);
  expect(result.success, result.logs.join("\n")).toBe(true);
  expect(existsSync(join(root, "dist/server/server.mjs"))).toBe(true);
  expect(existsSync(join(root, "dist/server/bootstrap.mjs"))).toBe(false);
});
