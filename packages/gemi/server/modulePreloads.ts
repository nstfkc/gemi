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
 */
export function createClientEntry(
  manifest: ViteManifest,
): { module: string; preload: string[] } | undefined {
  const file = manifest[CLIENT_ENTRY_KEY]?.file;
  if (!file) {
    return undefined;
  }
  return {
    module: `/${file}`,
    preload: collectModulePreloads(manifest, CLIENT_ENTRY_KEY),
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
export function collectModulePreloads(manifest: ViteManifest, entryKey: string): string[] {
  const urls: string[] = [];
  // Chunk graphs are cyclic often enough (two chunks importing each other
  // through a shared module) that walking them without a visited set hangs.
  const visited = new Set<string>();

  const walk = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk?.file) return;
    urls.push(`/${chunk.file}`);
    for (const imported of chunk.imports ?? []) {
      walk(imported);
    }
  };

  walk(entryKey);

  return urls;
}
