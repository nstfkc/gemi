import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the browser fetches the client build from — the prefix every URL gemi
 * builds out of a Vite manifest entry starts with. `/` unless the app sets one,
 * which is the root-relative `/assets/...` every gemi app has always served.
 */
export const DEFAULT_ASSET_BASE = "/";

/**
 * The file the client build records its base in, relative to `dist/client`.
 * Next to Vite's own `manifest.json`, and like it outside anything the static
 * handler serves.
 */
export const ASSET_BASE_RECORD = ".vite/gemi.json";

/**
 * The base as a URL prefix: trimmed, `/` when empty, and always ending in `/`
 * so `${base}${file}` never needs to know which way round the caller wrote it.
 *
 * Only an absolute URL (`https://cdn.example.com/r42/`) or an absolute path
 * (`/static/`) is accepted. Vite also takes a relative base (`./`, `""`), which
 * resolves each chunk against the module that imports it — but the document
 * has no importing module: a relative `<link rel="modulepreload">` in the SSR
 * head resolves against the page's own URL, so `/users/7` would ask for
 * `/users/assets/...`. Refused here rather than served broken.
 */
export function normalizeAssetBase(value: string | undefined): string {
  const base = value?.trim() ?? "";
  if (base === "") {
    return DEFAULT_ASSET_BASE;
  }
  if (!base.startsWith("/") && !/^[a-z][a-z\d+.-]*:\/\//i.test(base)) {
    throw new Error(
      `Asset base ${JSON.stringify(value)} is neither an absolute URL nor a path starting with "/". ` +
        `The server-rendered document links the build's chunks by this prefix, and a relative one would ` +
        `resolve against each page's URL instead of the build's.`,
    );
  }
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * The asset base the build should use, from `GEMI_ASSET_BASE` or the
 * `assetBase` field of `gemi.config.ts`, in that order. `undefined` when
 * neither is set, which leaves Vite's own default in place.
 *
 * The variable wins because the thing it usually carries — a release id in the
 * path — is known to the CI job running the build, not to a file checked in
 * beside the code.
 */
export function resolveAssetBase(
  configured: string | undefined,
  env: string | undefined = process.env.GEMI_ASSET_BASE,
): string | undefined {
  const value = env?.trim() ? env : configured;
  return value?.trim() ? normalizeAssetBase(value) : undefined;
}

/** A manifest entry's `file` (`assets/client-abc.js`) as a URL under `base`. */
export function assetUrl(file: string, base: string = DEFAULT_ASSET_BASE): string {
  return `${base}${file}`;
}

/**
 * The base the client build in `clientDir` was built with, as the build
 * recorded it.
 *
 * Read from the build output rather than from `GEMI_ASSET_BASE` at boot: the
 * base is baked into the bundle — Vite writes it into every preload helper and
 * CSS `url()` — so the only value the document can safely use is the one the
 * bundle already has. An environment read here could differ from the build's
 * (a variable set on the CI job and not on the container is the ordinary case),
 * and the document would then link chunks the bundle does not import.
 *
 * `/` when there is no record, which is a build from before the record existed
 * and therefore one built without a base.
 */
export async function readBuiltAssetBase(clientDir: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(join(clientDir, ASSET_BASE_RECORD), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return DEFAULT_ASSET_BASE;
    }
    throw error;
  }
  return normalizeAssetBase(JSON.parse(raw).assetBase);
}
