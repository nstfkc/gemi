import { DEFAULT_ASSET_BASE, assetUrl } from "../config/assetBase";
import { ISLAND_ENTRY_QUERY } from "../internal/islandRuntime";

/** The subset of a Vite manifest entry this module reads. */
export interface ViteManifestChunk {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
}

export type ViteManifest = Record<string, ViteManifestChunk>;

/** Vite's manifest key for the module that boots hydration. */
export const CLIENT_ENTRY_KEY = "app/client.tsx";

/**
 * How the shell boots hydration in production: `module` is imported from the
 * bootstrap script, `preload` is every chunk that import pulls in — see
 * `clientEntry` in `ViewRouteDispatcher` for why the entry does not go through
 * React's `bootstrapModules`.
 *
 * `undefined` when the manifest has no client entry, which means a `dist/`
 * interrupted between the server and client build passes. Degrading beats
 * throwing here: this runs at boot, so a deref would take down API routes,
 * static assets and health checks over what is only a document concern, and
 * the dispatcher already renders a shell that simply does not hydrate.
 *
 * `assetBase` is the base the client build recorded — see `readBuiltAssetBase`.
 */
export function createClientEntry(
  manifest: ViteManifest,
  assetBase: string = DEFAULT_ASSET_BASE,
): { module: string; preload: string[] } | undefined {
  const file = manifest[CLIENT_ENTRY_KEY]?.file;
  if (!file) {
    return undefined;
  }
  return {
    module: assetUrl(file, assetBase),
    preload: collectModulePreloads(manifest, CLIENT_ENTRY_KEY, assetBase),
  };
}

/**
 * Every chunk URL that importing `entryKey` pulls in, itself first.
 *
 * The browser can only discover these one parse at a time — it learns about a
 * chunk's static imports after the chunk has arrived and been parsed — so a
 * `layout -> view -> child component` graph costs one round trip per level.
 * Handing the whole list to the shell as `modulepreload` hints turns that
 * chain into one parallel fetch (#352).
 *
 * `dynamicImports` are deliberately left out: those are the pieces the app
 * asked to load lazily, and preloading them would download code the current
 * route may never render.
 */
export function collectModulePreloads(
  manifest: ViteManifest,
  entryKey: string,
  assetBase: string = DEFAULT_ASSET_BASE,
): string[] {
  const urls: string[] = [];
  // Chunk graphs are cyclic often enough (two chunks importing each other
  // through a shared module) that walking them without a visited set hangs.
  const visited = new Set<string>();

  const walk = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk?.file) return;
    urls.push(assetUrl(chunk.file, assetBase));
    for (const imported of chunk.imports ?? []) {
      walk(imported);
    }
  };

  walk(entryKey);

  return urls;
}

/**
 * Every CSS file the static import closure of `entryKey` carries, in import
 * order and without repeats. Vite lists a chunk's CSS on that chunk only, not
 * on the entries that import it, so a page with no client router to load the
 * rest (a static view) has to walk the graph for it.
 */
export function collectCss(manifest: ViteManifest, entryKey: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();

  const walk = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key] as ViteManifestChunk & { css?: string[] };
    if (!chunk) return;
    for (const imported of chunk.imports ?? []) {
      walk(imported);
    }
    for (const file of chunk.css ?? []) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  };

  walk(entryKey);
  return files;
}

/**
 * Where a static page's islands load from: each island module's entry
 * (`<key>?gemi-island`, the module plus the hydrate function), with the
 * chunks importing it pulls in, itself first. React and `react-dom/client`
 * are among those. `undefined` for a module the client build has no island
 * entry for.
 */
export function createIslandResolver(
  manifest: ViteManifest,
  assetBase: string = DEFAULT_ASSET_BASE,
): (moduleKey: string) => { src: string; preload: string[] } | undefined {
  const cache = new Map<string, { src: string; preload: string[] } | undefined>();
  return (moduleKey) => {
    if (!cache.has(moduleKey)) {
      const key = `${moduleKey}${ISLAND_ENTRY_QUERY}`;
      const file = manifest[key]?.file;
      cache.set(
        moduleKey,
        file
          ? { src: assetUrl(file, assetBase), preload: collectModulePreloads(manifest, key, assetBase) }
          : undefined,
      );
    }
    return cache.get(moduleKey);
  };
}
