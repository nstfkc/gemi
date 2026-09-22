import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { ASSET_BASE_RECORD, DEFAULT_ASSET_BASE, normalizeAssetBase } from "../config/assetBase";

/**
 * Applies the app's asset base to the build and records the base the build
 * actually used, for `httpProd` to link the document's chunks with.
 *
 * What is recorded is Vite's resolved `base`, not `assetBase`: a `vite.base`
 * set in `gemi.config.ts` reaches Vite too, and the bundle is built with
 * whichever won the config merge. Recording the input instead would let the
 * document and the bundle disagree again the moment both are set.
 *
 * Build only. In dev the chunks come from Vite's dev server on the same
 * origin, and a CDN base there would point the page at files nobody uploaded.
 */
export function gemiAssetBasePlugin(assetBase: string | undefined): Plugin {
  let resolved: ResolvedConfig | undefined;

  return {
    name: "gemi-plugin-asset-base",
    config: (_config, env) =>
      env.command === "build" && assetBase ? { base: assetBase } : undefined,
    configResolved(config) {
      resolved = config;
    },
    async writeBundle(options) {
      // One record, from the client build: it is the bundle the browser runs.
      // The SSR build is handed the same base by the hook above, so an asset
      // URL a view renders on the server matches the one it hydrates with.
      if (!resolved || resolved.command !== "build" || resolved.build.ssr || !options.dir) {
        return;
      }
      const file = join(options.dir, ASSET_BASE_RECORD);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ assetBase: documentBase(resolved.base) })}\n`);
    },
  };
}

/**
 * The prefix the document should use for a bundle built with `base`.
 *
 * A relative Vite base (`./`, `""`) only reaches Vite through a raw
 * `vite.base`, and it makes the bundle resolve every chunk against the module
 * importing it — i.e. against wherever the document loaded the entry from. So
 * the document keeps its root-relative URLs and the bundle follows it, which is
 * what such an app has been getting all along.
 */
function documentBase(base: string): string {
  return base.startsWith("/") || /^[a-z][a-z\d+.-]*:\/\//i.test(base)
    ? normalizeAssetBase(base)
    : DEFAULT_ASSET_BASE;
}
