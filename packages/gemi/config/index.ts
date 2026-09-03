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

// The value to pass as `@vitejs/plugin-react`'s `compiler` option, with an
// environment switch in front of it:
//
//   import react from "@vitejs/plugin-react";
//   import { defineConfig, reactCompiler } from "gemi/config";
//   export default defineConfig({ vite: { plugins: [react({ compiler: reactCompiler() })] } });
//
// `GEMI_REACT_COMPILER=off` turns the React Compiler off; any other value (or
// none) leaves it on. Case-insensitive, and the same shape as `GEMI_COMPRESSION`
// — a named opt-out rather than a boolean, because `=0`, `=false` and `=no` all
// read as "off" to a human and only one of them can be the one that works.
//
// It lives here rather than as a `process.env` read in each app's
// `gemi.config.ts` so the flag means the same thing in every gemi project, and
// so bisecting a compiler-shaped bug is one variable rather than one edit:
//
//   GEMI_REACT_COMPILER=off bun dev      # is it the compiler?
//
// The variable is read where `gemi.config.ts` is loaded — inside the Vite
// process that `dev` and `build` spawn — so it is inherited from the shell and
// also picked up from `.env`, which Bun loads before the config imports.
//
// Pass compiler options through it to keep the switch and the options together;
// `false` is returned in their place when the environment opts out.
export function reactCompiler(): boolean;
export function reactCompiler<T extends object>(options: T): T | false;
export function reactCompiler(options?: object): boolean | object {
  const enabled = (process.env.GEMI_REACT_COMPILER ?? "auto").toLowerCase() !== "off";
  if (!enabled) return false;
  return options ?? true;
}
