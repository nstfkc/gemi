/**
 * Recovery from a chunk that will not load — almost always a document from an
 * earlier release asking for a chunk the server it reached no longer has
 * (#548). The page cannot continue with the module it wanted, and a full load
 * of the URL it was heading to gets it the current release's document.
 *
 * One reload per page, guarded: a reload that lands on the same failure (a
 * chunk that is genuinely missing, a proxy that keeps refusing it) must not
 * become a loop. A `sessionStorage` marker records when each URL was reloaded
 * onto and survives the reload it guards, so a second failure for the same URL
 * inside the cooldown is left to the route's error boundary. Per URL rather
 * than per tab (#1056): while two releases serve at once every navigation can
 * miss, and a tab-wide cooldown sent the second one to the error boundary.
 *
 * The same guard covers a navigation whose data came from another build
 * (`recoverFromBuildMismatch`).
 *
 * No DOM or React import at module scope: the server's reload stub
 * (`server/staticAssetMiss.ts`) embeds the same guard as a script.
 */

/** The `sessionStorage` key the guard lives under, shared with the reload stub. */
export const CHUNK_RELOAD_MARKER = "gemi:chunk-reload";

/**
 * The response header carrying the client build id on a `.json` navigation
 * (#1056). The document carries its own as `buildId`; they differ when the
 * request reached a server running another release.
 */
export const BUILD_HEADER = "x-gemi-build";

/** How long after a recovery reload onto a URL another one onto it is refused. */
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
 * - `cooldown`: it already reloaded onto this URL within `cooldownMs`.
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

export interface BuildMismatchContext {
  /** The URL the full page load goes to: the page being navigated to. */
  url: string;
  /** The build the page was loaded with. */
  clientBuild: string;
  /** The build that answered the navigation. */
  serverBuild: string;
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
  /**
   * Called when a client-side navigation's data came from another build (a
   * deploy in progress, two releases behind one load balancer), before gemi
   * loads the page in full. Return `false` to skip that and render the data
   * anyway. Called when the load is blocked too, with `blocked` saying why.
   */
  onBuildMismatch?: (context: BuildMismatchContext) => boolean | void;
}

let enabled = true;
let options: ChunkLoadRecoveryOptions = {};
/**
 * The full load gemi started and the page is still waiting on: further
 * failures of the same navigation (a route with several views fails once per
 * view) report it as under way instead of starting another.
 *
 * Not a latch for the life of the page: the load can be cancelled — "Stay" on
 * a `beforeunload` prompt (a dirty editor), a handler that stops it — and the
 * page then keeps running with no load coming. It holds only for the
 * navigation that started it (`navigationStarted` clears it) and for the
 * cooldown, so a later failure is judged on its own: another URL loads in
 * full, the same URL inside the cooldown is refused (the data renders, the
 * view's error boundary shows), and after the cooldown it loads again.
 */
let pendingLoad: { url: string; at: number } | null = null;

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
  pendingLoad = null;
}

/**
 * The router calls this as each client-side navigation starts. A full load
 * still pending from an earlier one was cancelled (the page would be gone
 * otherwise), so it no longer speaks for this navigation's failures.
 */
export function navigationStarted() {
  pendingLoad = null;
}

/** Whether a full load onto `url` is already under way. */
function loadPending(url: string): boolean {
  return (
    pendingLoad !== null &&
    pendingLoad.url === url &&
    withinCooldown(Date.now() - pendingLoad.at, cooldownMs())
  );
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
  const target = url ?? window.location.href;
  if (loadPending(target)) {
    // A route with several views fails once per view; the first one reloads.
    return true;
  }
  const blocked = reloadBlock(target);

  if (options.onChunkLoadError?.({ error, url: target, source, blocked }) === false) {
    return false;
  }
  return loadInFull(target, blocked);
}

/**
 * Loads `url` in full because the navigation to it got its data from another
 * build (#1056): the views this page runs were not written for that data, and
 * rendering it anyway is how a deploy turned into "Something went wrong". The
 * full load gets a document and views of one build. Same guard as a chunk
 * failure, once per URL per cooldown; a navigation refused here renders the
 * data as before. Returns whether the page load was started.
 */
export function recoverFromBuildMismatch({
  url,
  clientBuild,
  serverBuild,
}: {
  url: string;
  clientBuild: string;
  serverBuild: string;
}): boolean {
  if (typeof window === "undefined" || !enabled) {
    return false;
  }
  if (loadPending(url)) {
    return true;
  }
  const blocked = reloadBlock(url);
  if (options.onBuildMismatch?.({ url, clientBuild, serverBuild, blocked }) === false) {
    return false;
  }
  return loadInFull(url, blocked);
}

/**
 * The build that answered a `.json` navigation, when it is not `clientBuild`;
 * otherwise `null`. Unknown on either side (dev, a test double, a server from
 * before the header) is not a mismatch.
 */
export function otherBuild(response: Response, clientBuild: string | undefined): string | null {
  const served = response.headers?.get?.(BUILD_HEADER);
  return clientBuild && served && served !== clientBuild ? served : null;
}

function loadInFull(target: string, blocked: ChunkReloadBlock): boolean {
  if (blocked !== null || !markReload(target)) {
    return false;
  }

  pendingLoad = { url: target, at: Date.now() };
  if (target === window.location.href) {
    window.location.reload();
  } else {
    window.location.assign(target);
  }
  return true;
}

function cooldownMs() {
  return options.cooldownMs ?? DEFAULT_CHUNK_RELOAD_COOLDOWN_MS;
}

function reloadBlock(url: string): ChunkReloadBlock {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(CHUNK_RELOAD_MARKER);
  } catch {
    return "storage";
  }
  const at = parseMarker(raw)[url];
  return at !== undefined && withinCooldown(Date.now() - at, cooldownMs()) ? "cooldown" : null;
}

// A marker from the future (the clock was set back since it was written) is
// stale rather than a cooldown that lasts until the clock catches up.
function withinCooldown(elapsed: number, cooldownMs: number): boolean {
  return elapsed >= 0 && elapsed < cooldownMs;
}

/**
 * The marker: when each URL was last reloaded onto, `{ [url]: at }`. Anything
 * else in it (a marker written by an earlier gemi as `{ url, at }`) is ignored.
 */
function parseMarker(raw: string | null): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  const marker: Record<string, number> = {};
  if (parsed && typeof parsed === "object") {
    for (const [url, at] of Object.entries(parsed)) {
      if (typeof at === "number") marker[url] = at;
    }
  }
  return marker;
}

// Entries past the cooldown are dropped as a new one is written, so the marker
// holds only the reloads it still guards.
function markReload(url: string): boolean {
  try {
    const now = Date.now();
    const marker: Record<string, number> = {};
    for (const [other, at] of Object.entries(
      parseMarker(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)),
    )) {
      if (withinCooldown(now - at, cooldownMs())) marker[other] = at;
    }
    marker[url] = now;
    window.sessionStorage.setItem(CHUNK_RELOAD_MARKER, JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

/**
 * The same guard as a classic script body, for the module the server sends in
 * place of a chunk it does not have. It reloads once per URL per cooldown;
 * inside the cooldown (or with no storage) it throws an error `isChunkLoadError`
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
    `var r=!1;try{var s=window.sessionStorage,u=window.location.href,m=JSON.parse(s.getItem(${key})||"{}");` +
    `if(!m||typeof m!=="object")m={};var d=Date.now()-m[u];` +
    `if(navigator.onLine!==!1&&!(d>=0&&d<${cooldownMs})){` +
    `m[u]=Date.now();s.setItem(${key},JSON.stringify(m));r=!0}}catch(e){}` +
    `if(r)window.location.reload();else throw new Error(${error});export {}`
  );
}
