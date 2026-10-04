import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import MagicString from "magic-string";
import type { Plugin } from "vite";

/**
 * `() => import("./x.island")` — the loader `island()` takes. The specifier
 * must name a `*.island` module; the extension is optional, as in any import.
 */
const ISLAND_LOADER = /\(\s*\)\s*=>\s*import\(\s*(["'])([^"'\n]+?\.island(?:\.[cm]?[jt]sx?)?)\1\s*\)/g;

/**
 * Symlinks resolved, so the key is the same path the manifest is keyed on
 * however the project directory was reached (`/var` vs `/private/var` on
 * macOS, a linked workspace).
 */
function realPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Tells the server which built file an island's loader imports.
 *
 * `island("nav-menu", NavMenuView, () => import("./navMenu.island"))` is
 * rewritten so the loader carries the module's build key — its path from the
 * project root, the key the client manifest uses:
 *
 * ```js
 * Object.assign(() => import("./navMenu.island"), { gemiIsland: "app/views/site/navMenu.island.ts" })
 * ```
 *
 * The server renders, never calls the loader, and maps the key to a URL. In
 * the SSR graph the import itself is replaced too, so an island's browser code
 * is not bundled into the server build.
 */
export function gemiIslandPlugin(): Plugin {
  let root = process.cwd();

  return {
    name: "gemi-plugin-islands",
    enforce: "pre",
    configResolved(config) {
      root = realPath(config.root);
    },
    async transform(code, id, options) {
      if (id.includes("/node_modules/") || id.startsWith("\0")) return null;
      if (!/\.[cm]?[jt]sx?$/.test(id.split("?")[0])) return null;
      if (!code.includes(".island")) return null;

      const ssr = Boolean(options?.ssr) || this.environment?.config?.consumer === "server";
      const s = new MagicString(code);
      let changed = false;

      for (const match of code.matchAll(ISLAND_LOADER)) {
        const [whole, quote, specifier] = match;
        const resolved = await this.resolve(specifier, id);
        if (!resolved || resolved.external) continue;
        const file = realPath(resolved.id.split("?")[0]);
        const key = relative(root, file).split(sep).join("/");
        if (key.startsWith("..")) continue;

        const loader = ssr
          ? `() => Promise.reject(new Error("Island modules load in the browser."))`
          : `() => import(${quote}${specifier}${quote})`;
        s.overwrite(
          match.index!,
          match.index! + whole.length,
          `Object.assign(${loader}, { gemiIsland: ${JSON.stringify(key)} })`,
        );
        changed = true;
      }

      if (!changed) return null;
      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    },
  };
}
