import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  bundleStats,
  markdownReport,
  overBudget,
  textReport,
  unusedBudgets,
  type BuildStats,
  type StatsConfig,
} from "./bundleStats";
import type { RouteTableEntry } from "./routeTable";

export interface RunStatsOptions {
  rootDir: string;
  /** `stats` from `gemi.config.ts`. */
  config?: StatsConfig;
  /** Write the stats as JSON here. */
  json?: string;
  /** Another build's JSON to compare with; a missing file is no comparison. */
  base?: string;
  /** Write the Markdown table here. */
  markdown?: string;
  /** `false` skips the route table and reports per view. */
  routes?: boolean;
  /** `bun --preload` args for the app's own preload (see `bin/gemi.ts`). */
  preloadArgs?: string[];
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Reads the client build in `<rootDir>/dist/client`, prints the initial JS per
 * route, writes the requested files and checks the budgets. Returns the exit
 * code: 1 when a route is over its budget or there is no build to read.
 */
export async function runStats(options: RunStatsOptions): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const clientDir = path.join(options.rootDir, "dist", "client");
  if (!existsSync(path.join(clientDir, ".vite/manifest.json"))) {
    error(`No client build in ${clientDir}. Run \`gemi build\` first.`);
    return 1;
  }

  let routes: RouteTableEntry[] | null = null;
  if (options.routes !== false) {
    const table = await loadRouteTable(options.rootDir, options.preloadArgs ?? []);
    if ("routes" in table) routes = table.routes;
    else
      error(
        `Could not read the route table, so this reports per view and can't tell static ` +
          `views apart (pass --no-routes to skip it):\n${table.message}`,
      );
  }

  const stats = bundleStats({ clientDir, routes });
  const budgets = options.config?.budgets;

  log(textReport(stats, budgets));

  if (options.json) {
    writeFileSync(options.json, `${JSON.stringify(stats, null, 2)}\n`);
  }
  if (options.markdown) {
    const base: BuildStats | null =
      options.base && existsSync(options.base)
        ? JSON.parse(readFileSync(options.base, "utf8"))
        : null;
    writeFileSync(options.markdown, `${markdownReport(stats, base, budgets)}\n`);
  }

  for (const key of unusedBudgets(stats, budgets)) {
    error(`warning: the budget for "${key}" matches no route or view.`);
  }
  const problems = overBudget(stats, budgets);
  if (problems.length) {
    error(`\nOver budget (stats.budgets in gemi.config.ts):\n${problems.join("\n")}`);
    return 1;
  }
  return 0;
}

export type RouteTableResult =
  | { ok: true; routes: RouteTableEntry[] }
  | { ok: false; message: string };

/**
 * The app's route table, read in a child process (`gemi/stats/route-table`)
 * that imports the Kernel and runs only its synchronous `boot()`, with the same
 * preloads as `gemi start`. A child, because the app's code has to load under
 * the app's own gemi with the request transform registered, and because it
 * must not leave anything running in the build process.
 */
export async function loadRouteTable(
  rootDir: string,
  preloadArgs: string[],
  options: { timeoutMs?: number } = {},
): Promise<RouteTableResult> {
  let entry: string;
  try {
    entry = Bun.resolveSync("gemi/stats/route-table", rootDir);
  } catch {
    return { ok: false, message: `gemi/stats/route-table does not resolve from ${rootDir}.` };
  }
  const dir = mkdtempSync(path.join(tmpdir(), "gemi-stats-"));
  const out = path.join(dir, "routes.json");
  try {
    const child = Bun.spawn({
      cmd: ["bun", "--preload", "gemi/bun/preload", ...preloadArgs, entry, out],
      cwd: rootDir,
      // Nothing scheduled or claimed, even by an app that starts work at import.
      env: { ...process.env, GEMI_NO_SCHEDULE: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    if (code !== 0 || !existsSync(out)) {
      return {
        ok: false,
        message: stderr.trim() || `the route table process exited with ${code}.`,
      };
    }
    return { ok: true, routes: JSON.parse(readFileSync(out, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
