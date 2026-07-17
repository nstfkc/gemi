import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GemiConfig } from "./index";

const CONFIG_FILES = ["gemi.config.ts", "gemi.config.js", "gemi.config.mjs"];

// Load the app's `gemi.config.*` from `rootDir`. Runs under Bun in every
// context that needs it — the CLI, the `--preload` runtime, and the gemi Vite
// plugin (the build runs Vite via `bun --bun`, dev via `bun --hot`) — so a
// TypeScript config imports directly with no extra transpilation step. Returns
// an empty config when no file is present, so config is entirely optional.
export async function loadGemiConfig(
  rootDir: string = process.cwd(),
): Promise<GemiConfig> {
  for (const name of CONFIG_FILES) {
    const path = join(rootDir, name);
    if (existsSync(path)) {
      const mod = await import(path);
      return (mod.default ?? mod) as GemiConfig;
    }
  }
  return {};
}
