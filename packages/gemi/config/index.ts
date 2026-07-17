import type { PluginOption } from "vite";
import type { BunPlugin } from "bun";

// Vite configuration contributed by the app. `plugins` are appended to gemi's
// own Vite plugins; every other key is a standard Vite `UserConfig` field and is
// merged (by Vite) on top of gemi's base config for the client + SSR view
// builds. See `gemi/vite`.
export interface GemiViteConfig {
  plugins?: PluginOption[];
  [key: string]: unknown;
}

// Bun configuration contributed by the app. `plugins` are applied both at build
// time (the server `Bun.build`) and at runtime (registered via `--preload` for
// `dev`/`start`), alongside gemi's built-in custom-request plugin.
export interface GemiBunConfig {
  plugins?: BunPlugin[];
}

export interface GemiConfig {
  vite?: GemiViteConfig;
  bun?: GemiBunConfig;
}

// Identity helper that gives `gemi.config.ts` full type-checking and editor
// autocomplete. Usage:
//
//   import { defineConfig } from "gemi/config";
//   export default defineConfig({ vite: { plugins: [] }, bun: { plugins: [] } });
export function defineConfig(config: GemiConfig): GemiConfig {
  return config;
}
