import { watch, existsSync, readFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

declare global {
  // A single directory watcher, kept on globalThis so `bun --hot` reloads (which
  // re-run `Server.start`) don't stack duplicate watchers.
  var __gemiEnvWatcher: FSWatcher | undefined;
}

// Minimal `.env` parser: `KEY=VALUE` lines, `#` comments, an optional leading
// `export`, and surrounding single/double quotes stripped. Multi-line values and
// `${VAR}` interpolation are intentionally not handled (uncommon subset).
function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// The `.env` files Bun loads, in increasing precedence (later overrides earlier).
// `.env.local` is skipped for `NODE_ENV=test`, matching Bun/dotenv conventions.
export function envFiles(rootDir: string): string[] {
  const nodeEnv = process.env.NODE_ENV;
  const names = [".env"];
  if (nodeEnv) names.push(`.env.${nodeEnv}`);
  if (nodeEnv !== "test") {
    names.push(".env.local");
    if (nodeEnv) names.push(`.env.${nodeEnv}.local`);
  }
  return names.map((name) => join(rootDir, name));
}

// Re-read the env files and apply them to `process.env`. Only adds/updates keys
// (a value edit is the common case); a key removed from the file keeps its last
// value until the next full restart, so we never clobber the real OS environment.
function applyEnv(rootDir: string): string[] {
  const merged: Record<string, string> = {};
  for (const file of envFiles(rootDir)) {
    if (existsSync(file)) {
      Object.assign(merged, parseEnv(readFileSync(file, "utf8")));
    }
  }
  const changed: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
      changed.push(key);
    }
  }
  return changed;
}

// Watch the project's `.env` files and re-apply them to `process.env` on change,
// so edits take effect without restarting the dev server. Bun loads `.env` only
// at startup and does not reload it (even under `--hot`), so this fills that gap.
// Dev only — called from `Server.start()`'s dev branch, not in production.
// Idempotent: keeps a single watcher across `bun --hot` reloads.
//
// Note: this updates `process.env`, so config read at request time picks up the
// new value immediately; values a service reads once at boot (e.g. a client
// constructed from an env var) are cached and won't change until that code
// re-runs (a hot reload in dev, a restart in prod).
export function watchEnv(rootDir: string = process.cwd()) {
  if (globalThis.__gemiEnvWatcher) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  globalThis.__gemiEnvWatcher = watch(rootDir, (_event, filename) => {
    // Non-recursive: only direct children of `rootDir`. Filter to `.env*`.
    if (!filename || !String(filename).startsWith(".env")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const changed = applyEnv(rootDir);
        if (changed.length) {
          console.log(`[gemi] .env reloaded: ${changed.join(", ")}`);
        }
      } catch (error) {
        console.error("[gemi] failed to reload .env:", error);
      }
    }, 50);
  });
}
