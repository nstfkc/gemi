import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { runStats } from "./run";

const root = mkdtempSync(join(tmpdir(), "gemi-run-stats-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const client = join(root, "dist", "client");
mkdirSync(join(client, ".vite"), { recursive: true });
mkdirSync(join(client, "assets"), { recursive: true });
writeFileSync(join(client, "assets/client-AAAAAAAA.js"), "a".repeat(3000));
writeFileSync(join(client, "assets/Home-BBBBBBBB.js"), "b".repeat(500));
writeFileSync(
  join(client, ".vite/manifest.json"),
  JSON.stringify({
    "app/client.tsx": { file: "assets/client-AAAAAAAA.js", isEntry: true },
    "app/views/Home.tsx": { file: "assets/Home-BBBBBBBB.js", isEntry: true },
  }),
);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
}

describe("runStats", () => {
  test("fails without a build", async () => {
    const io = capture();
    const empty = mkdtempSync(join(tmpdir(), "gemi-run-stats-empty-"));
    try {
      expect(await runStats({ rootDir: empty, ...io })).toBe(1);
      expect(io.err.join("\n")).toContain("Run `gemi build` first");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("prints, writes the JSON and Markdown, and passes within budget", async () => {
    const io = capture();
    const json = join(root, "stats.json");
    const markdown = join(root, "stats.md");
    const code = await runStats({
      rootDir: root,
      routes: false,
      json,
      markdown,
      base: join(root, "missing-base.json"),
      config: { budgets: { unit: "raw", default: 4 } },
      ...io,
    });
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("Initial JavaScript per view:");
    const stats = JSON.parse(readFileSync(json, "utf8"));
    expect(stats.by).toBe("views");
    expect(stats.routes.Home.raw).toBe(3500);
    expect(existsSync(markdown)).toBe(true);
  });

  test("fails when a route is over its budget", async () => {
    const io = capture();
    const code = await runStats({
      rootDir: root,
      routes: false,
      config: { budgets: { unit: "raw", routes: { Home: 3 } } },
      ...io,
    });
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("Home: 3.4 KB raw is over its budget of 3 KB");
  });

  test("falls back to per view when the route table can't be read", async () => {
    const io = capture();
    // No app/kernel here: the child process fails, and the stats still print.
    expect(await runStats({ rootDir: root, ...io })).toBe(0);
    expect(io.err.join("\n")).toContain("Could not read the route table");
    expect(io.out.join("\n")).toContain("Initial JavaScript per view:");
  });
});
