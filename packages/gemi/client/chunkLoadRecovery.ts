/**
 * Recovery from a chunk that will not load — almost always a document from an
 * earlier release asking for a chunk the server it reached no longer has
 * (#548). The page cannot continue with the module it wanted, and a full load
 * of the URL it was heading to gets it the current release's document.
 *
 * One reload, guarded: a reload that lands on the same failure (a chunk that is
 * genuinely missing, a proxy that keeps refusing it) must not become a loop. A
 * `sessionStorage` marker with a timestamp survives the reload it guards, so a
 * second failure inside the cooldown is left to the route's error boundary.
 *
 * No DOM or React import at module scope: the server's reload stub
 * (`server/staticAssetMiss.ts`) embeds the same guard as a script.
 */

/** The `sessionStorage` key the guard lives under, shared with the reload stub. */
export const CHUNK_RELOAD_MARKER = "gemi:chunk-reload";

/** How long after one recovery reload another is refused. */
export const DEFAULT_CHUNK_RELOAD_COOLDOWN_MS = 30_000;

/**
 * Where the failure surfaced: a route's view chunk during a client-side
 * navigation or hydration, a `vite:preloadError` (a lazy `import()` in app
 * code, through Vite's preload helper), or an app calling
 * `recoverFromChunkLoadError` from its own error boundary.
 */
export type ChunkLoadErrorSource = "navigation" | "hydration" | "preload" | "app";

/**
 * Why gemi will not reload, or `null` when it will:
 * - `cooldown`: it already reloaded for a chunk failure within `cooldownMs`.
 * - `offline`: `navigator.onLine` is false — a reload would only fail harder.
 * - `storage`: `sessionStorage` cannot be read or written, so the guard cannot
 *   survive the reload and the loop it prevents could not be ruled out.
 */
export type ChunkReloadBlock = "cooldown" | "offline" | "storage" | null;

export interface ChunkLoadErrorContext {
  error: unknown;
  /** The URL the reload goes to: the page being navigated to. */
  url: string;
  source: ChunkLoadErrorSource;
  /** Why gemi will not reload, or `null` when it is about to. */
  blocked: ChunkReloadBlock;
}

export interface ChunkLoadRecoveryOptions {
  /** Default 30 000 ms. */
  cooldownMs?: number;
  /**
   * Called for every chunk load failure gemi sees, before it reloads — the
   * place to report it, or to veto the reload (unsaved input, a page that
   * would rather show its own "a new version is available" prompt). Return
   * `false` to skip the reload; anything else lets gemi proceed. It is called
   * when the reload is blocked too, with `blocked` saying why.
   */
  onChunkLoadError?: (context: ChunkLoadErrorContext) => boolean | void;
}

let enabled = true;
let options: ChunkLoadRecoveryOptions = {};
let reloading = false;

/**
 * Sets how gemi recovers from a failed chunk. `false` turns recovery off: the
 * failure goes to the route's error boundary as it did before. `init` calls
 * this with its `chunkLoadRecovery` option.
 */
export function configureChunkLoadRecovery(next: ChunkLoadRecoveryOptions | false | undefined) {
  enabled = next !== false;
  options = next || {};
}

/** For tests: back to the defaults, with no reload in flight. */
export function __resetChunkLoadRecovery() {
  enabled = true;
  options = {};
  reloading = false;
}

/**
 * Whether `error` is a module that failed to load rather than one that loaded
 * and threw. Each engine words it differently:
 *
 * - Chromium: `Failed to fetch dynamically imported module: <url>`
 * - Firefox: `error loading dynamically imported module: <url>`
 * - Safari: `Importing a module script failed.`, and on iOS 16
 *   `Importing module '<specifier>' is not found.` (folio#2117)
 * - Vite's preload helper: `Unable to preload CSS for <url>`
 *
 * A view that throws while evaluating is not one of these, and reloading
 * would only hide it.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") {
    return true;
  }
  if (typeof message !== "string") {
    return false;
  }
  return CHUNK_LOAD_MESSAGES.some((pattern) => pattern.test(message));
}

const CHUNK_LOAD_MESSAGES = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /importing module .* is not found/i,
  /unable to preload css/i,
  /failed to load module script/i,
];

/**
 * Reloads the page onto `url` once for a chunk that failed to load, unless the
 * guard or the app's `onChunkLoadError` says not to. Returns whether a reload
 * was started.
 *
 * Errors that are not chunk failures are ignored (`false`), so an app's error
 * boundary can pass everything it catches here.
 */
export function recoverFromChunkLoadError(
  error: unknown,
  { source = "app", url }: { source?: ChunkLoadErrorSource; url?: string } = {},
): boolean {
  if (typeof window === "undefined" || !enabled || !isChunkLoadError(error)) {
    return false;
  }
  if (reloading) {
    // A route with several views fails once per view; the first one reloads.
    return true;
  }
  const target = url ?? window.location.href;
  const cooldownMs = options.cooldownMs ?? DEFAULT_CHUNK_RELOAD_COOLDOWN_MS;
  const blocked = reloadBlock(cooldownMs);

  if (options.onChunkLoadError?.({ error, url: target, source, blocked }) === false) {
    return false;
  }
  if (blocked !== null || !markReload(target)) {
    return false;
  }

  reloading = true;
  if (target === window.location.href) {
    window.location.reload();
  } else {
    window.location.assign(target);
  }
  return true;
}

function reloadBlock(cooldownMs: number): ChunkReloadBlock {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(CHUNK_RELOAD_MARKER);
  } catch {
    return "storage";
  }
  const at = parseMarker(raw);
  return at !== null && Date.now() - at < cooldownMs ? "cooldown" : null;
}

function parseMarker(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  try {
    const at = JSON.parse(raw)?.at;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
}

function markReload(url: string): boolean {
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_MARKER, JSON.stringify({ url, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The same guard as a classic script body, for the module the server sends in
 * place of a chunk it does not have. It reloads once per cooldown; inside the
 * cooldown (or with no storage) it throws an error `isChunkLoadError`
 * recognises, so the importing page's own recovery and error boundary see the
 * failure instead of a module that silently has no exports.
 */
export function chunkReloadStubScript(
  pathname: string,
  cooldownMs: number = DEFAULT_CHUNK_RELOAD_COOLDOWN_MS,
): string {
  const key = JSON.stringify(CHUNK_RELOAD_MARKER);
  const error = JSON.stringify(`Failed to fetch dynamically imported module: ${pathname}`);
  return (
    `var r=!1;try{var s=window.sessionStorage,m=JSON.parse(s.getItem(${key})||"null");` +
    `if(navigator.onLine!==!1&&!(m&&Date.now()-m.at<${cooldownMs})){` +
    `s.setItem(${key},JSON.stringify({url:window.location.href,at:Date.now()}));r=!0}}catch(e){}` +
    `if(r)window.location.reload();else throw new Error(${error});export {}`
  );
}
