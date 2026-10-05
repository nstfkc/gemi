import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import {
  ISLAND_ENTRY_QUERY,
  ISLAND_RUNTIME_ID,
  ISLAND_RUNTIME_SOURCE,
  RESOLVED_ISLAND_RUNTIME_ID,
  islandEntrySource,
} from "../internal/islandRuntime";

/**
 * `island(() => import("./Counter")`: the call `island()` is declared with.
 * The loader must be the first argument, written as an arrow with no
 * parameters returning one `import()` of a string literal.
 */
const ISLAND_CALL = /\bisland\s*\(\s*(\(\s*\)\s*=>\s*import\(\s*(["'])([^"'\n]+)\2\s*\))/g;

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
 * Islands: `island(() => import("./Counter"))` in `gemi/client`.
 *
 * Every such call is rewritten, in the client and the server graph alike, so
 * the loader carries the module's build key (its path from the project root,
 * the key the client manifest uses) and the module itself, imported
 * statically:
 *
 * ```js
 * import * as __gemi_island_0 from "./Counter";
 * island(Object.assign(() => Promise.resolve(__gemi_island_0),
 *   { gemiIsland: "app/views/site/Counter.tsx", gemiModule: __gemi_island_0 }))
 * ```
 *
 * The static import is what lets a hydrated view render the component in
 * place, and a static view render it on the server without waiting on a
 * dynamic import. The key is what a static page's loader is pointed at.
 *
 * In the client build, each island module also gets an entry of its own,
 * `Counter.tsx?gemi-island`: the module (as `m`) and the island runtime's
 * hydrate function `h` (from `virtual:gemi-island-runtime`, which imports
 * React and `react-dom/client`). That entry's import closure, React included,
 * is exactly what a static page loads for the island, and the manifest shows
 * it under the entry's key. The runtime is one chunk the islands share. In
 * dev, Vite serves the same modules from source.
 *
 * Also usable on its own, e.g. from `gemi/vitest` in an app's
 * `vitest.config.ts`, so tests render islands with the same keys as the build.
 */
export function gemiIslandPlugin(): Plugin {
  let root = process.cwd();
  let clientBuild = false;
  const emitted = new Set<string>();

  return {
    name: "gemi-plugin-islands",
    enforce: "pre",
    configResolved(config) {
      root = realPath(config.root);
      clientBuild = config.command === "build" && !config.build.ssr;
    },
    buildStart() {
      emitted.clear();
    },
    resolveId(id) {
      return id === ISLAND_RUNTIME_ID ? RESOLVED_ISLAND_RUNTIME_ID : null;
    },
    load(id) {
      if (id === RESOLVED_ISLAND_RUNTIME_ID) return ISLAND_RUNTIME_SOURCE;
      if (id.endsWith(ISLAND_ENTRY_QUERY)) {
        return islandEntrySource(id.slice(0, -ISLAND_ENTRY_QUERY.length));
      }
      return null;
    },
    async transform(code, id) {
      if (id.includes("/node_modules/") || id.startsWith("\0") || id.endsWith(ISLAND_ENTRY_QUERY)) {
        return null;
      }
      if (!/\.[cm]?[jt]sx?$/.test(id.split("?")[0])) return null;
      if (!code.includes("island")) return null;

      const environmentConsumer = this.environment?.config?.consumer;
      const emitEntries =
        clientBuild && (environmentConsumer === undefined || environmentConsumer === "client");
      const s = new MagicString(code);
      const imports: string[] = [];

      for (const match of code.matchAll(ISLAND_CALL)) {
        const [, loader, quote, specifier] = match;
        const resolved = await this.resolve(specifier, id);
        if (!resolved || resolved.external) continue;
        const file = realPath(resolved.id.split("?")[0]);
        const key = relative(root, file).split(sep).join("/");
        if (key.startsWith("..")) continue;

        const name = `__gemi_island_${imports.length}`;
        imports.push(`import * as ${name} from ${quote}${specifier}${quote};`);
        const start = match.index! + match[0].length - loader.length;
        s.overwrite(
          start,
          start + loader.length,
          `Object.assign(() => Promise.resolve(${name}), { gemiIsland: ${JSON.stringify(key)}, gemiModule: ${name} })`,
        );

        // The id as resolved, not its real path: the entry must import the
        // very module the views import, or a symlinked path would load twice.
        const moduleId = resolved.id.split("?")[0];
        if (emitEntries && !emitted.has(moduleId)) {
          emitted.add(moduleId);
          this.emitFile({
            type: "chunk",
            id: `${moduleId}${ISLAND_ENTRY_QUERY}`,
            preserveSignature: "strict",
          });
        }
      }

      if (imports.length === 0) return null;
      s.prepend(`${imports.join("\n")}\n`);
      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    },
  };
}
