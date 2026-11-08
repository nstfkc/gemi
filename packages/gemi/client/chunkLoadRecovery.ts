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
 * Where `sessionStorage` cannot be used, the marker lives in `window.name`
 * instead (#1186); see `chunkReloadGuard`.
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
 * - `storage`: neither `sessionStorage` nor the `window.name` fallback can
 *   hold the guard, so it cannot survive the reload and the loop it prevents
 *   could not be ruled out.
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
  tidyWindowName();
}

/** For tests: back to the defaults, with no reload in flight. */
export function __resetChunkLoadRecovery() {
  enabled = true;
  options = {};
  pendingLoad = null;
  clearTimeout(tidyTimer);
  tidyTimer = undefined;
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
  const verdict = chunkReloadGuard(CHUNK_RELOAD_MARKER, url, cooldownMs(), false);
  return verdict === "ok" ? null : verdict;
}

// A marker from the future (the clock was set back since it was written) is
// stale rather than a cooldown that lasts until the clock catches up.
function withinCooldown(elapsed: number, cooldownMs: number): boolean {
  return elapsed >= 0 && elapsed < cooldownMs;
}

function markReload(url: string): boolean {
  if (chunkReloadGuard(CHUNK_RELOAD_MARKER, url, cooldownMs(), true) !== "ok") return false;
  // The load may yet be cancelled ("Stay" on a `beforeunload` prompt), and
  // then this page has to take the `window.name` marker down itself.
  tidyWindowName();
  return true;
}

let tidyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Takes gemi's marker out of `window.name` (back to `""`) once it guards
 * nothing (#1188): the page may want the name for itself, under the same
 * "only while it is empty" rule gemi follows. Now when nothing in it is live,
 * otherwise once the newest entry's cooldown has passed, checked again then
 * since a reload may have been recorded in the meantime. Only a name that
 * holds gemi's marker is ever cleared; see `chunkReloadGuard`'s `"tidy"`.
 */
function tidyWindowName() {
  clearTimeout(tidyTimer);
  tidyTimer = undefined;
  if (typeof window === "undefined") return;
  let delay: number;
  try {
    if (chunkReloadGuard(CHUNK_RELOAD_MARKER, window.location.href, cooldownMs(), "tidy") !== "cooldown") {
      return;
    }
    const held = JSON.parse(window.name.slice(CHUNK_RELOAD_MARKER.length + 1));
    // An entry from the future (clock set back) is not live and holds nothing back.
    const now = Date.now();
    const latest = Math.max(
      ...Object.values(held.m).filter((at): at is number => typeof at === "number" && at <= now),
    );
    delay = latest + cooldownMs() - now;
  } catch {
    return;
  }
  if (!Number.isFinite(delay)) return;
  tidyTimer = setTimeout(tidyWindowName, Math.max(0, delay) + 1);
}

/**
 * The cross-document guard, shared by the client and the server's reload stub
 * (which embeds this function's source, so it uses nothing but globals and its
 * arguments). With `claim` false it only reads: `"cooldown"` when a reload
 * onto `url` was recorded inside `cooldownMs`, `"storage"` when no marker can
 * be read at all, otherwise `"ok"`. With `claim` true it also records the
 * reload, and answers `"ok"` only once the record was written and read back
 * unchanged; a caller navigates on nothing less. With `"tidy"` it only looks
 * at `window.name`: a gemi marker with no live entry for this origin (expired,
 * from the future, another origin's, or one that does not parse) is cleared
 * to `""` and `"ok"` answered; `"cooldown"` while an entry is still live.
 *
 * Two places can hold the marker:
 *
 * - `sessionStorage[key]`: `{ [url]: at }`, the format earlier releases read
 *   and write, so a page from one and a stub from another share the guard.
 * - `window.name`, when `sessionStorage` throws or will not take the write
 *   (#1186). It survives a load in the same tab, but it is shared state: the
 *   page may use it, and another origin the tab goes to can read it. So it is
 *   used only while it is empty or already holds gemi's marker — a value of
 *   anyone else's is left exactly as it is, and the guard then fails closed —
 *   and it holds no URL: `key + ":" + { o: hash(origin), m: { [hash(origin +
 *   pathname)]: at } }`. A marker written by another origin (`o` differs) or
 *   one that does not parse holds no reloads and is replaced on the next
 *   write. Two paths whose hashes collide share one cooldown, which only ever
 *   refuses a reload.
 *
 * A reload recorded in either place counts. Entries past the cooldown — and
 * from the future, after the clock was set back — are dropped as a new one is
 * written, so the marker holds only the reloads it still guards.
 */
export function chunkReloadGuard(
  key: string,
  url: string,
  cooldownMs: number,
  claim: boolean | "tidy",
): "ok" | "cooldown" | "storage" {
  const now = Date.now();
  const fresh = function (at: unknown) {
    return typeof at === "number" && now - at >= 0 && now - at < cooldownMs;
  };
  const parse = function (raw: string | null): Record<string, unknown> {
    try {
      const value = raw ? JSON.parse(raw) : null;
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  const live = function (marker: Record<string, unknown>) {
    const kept: Record<string, number> = {};
    for (const k in marker) if (fresh(marker[k])) kept[k] = marker[k] as number;
    return kept;
  };
  // FNV-1a, 32 bits, base 36: a short tag, not a secret.
  const hash = function (text: string) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  };

  let storage: Storage | null = null;
  let stored: Record<string, unknown> = {};
  try {
    storage = window.sessionStorage;
    stored = parse(storage.getItem(key));
  } catch {
    storage = null;
  }

  const prefix = key + ":";
  let origin = "";
  let page = "";
  try {
    const target = new URL(url, window.location.href);
    origin = hash(new URL(window.location.href).origin);
    page = hash(target.origin + target.pathname);
  } catch {}
  // `null`: `window.name` is not ours to use (or there is no page to key on).
  let named: Record<string, unknown> | null = null;
  try {
    const name = window.name;
    if (!page) {
      named = null;
    } else if (name === "") {
      named = {};
    } else if (name.indexOf(prefix) === 0) {
      const held = parse(name.slice(prefix.length));
      const entries = held.m;
      named =
        held.o === origin && entries && typeof entries === "object" && !Array.isArray(entries)
          ? (entries as Record<string, unknown>)
          : {};
    }
  } catch {
    named = null;
  }

  if (claim === "tidy") {
    try {
      const current = window.name;
      if (named === null || current.indexOf(prefix) !== 0) return "ok";
      for (const k in named) if (fresh(named[k])) return "cooldown";
      window.name = "";
    } catch {}
    return "ok";
  }
  if (fresh(stored[url]) || (named && fresh(named[page]))) return "cooldown";
  if (!storage && !named) return "storage";
  if (!claim) return "ok";

  if (storage) {
    try {
      const nextStored = live(stored);
      nextStored[url] = now;
      const serialised = JSON.stringify(nextStored);
      storage.setItem(key, serialised);
      if (storage.getItem(key) === serialised) return "ok";
    } catch {}
  }
  if (named) {
    try {
      const nextNamed = live(named);
      nextNamed[page] = now;
      const value = prefix + JSON.stringify({ o: origin, m: nextNamed });
      window.name = value;
      if (window.name === value) return "ok";
    } catch {}
  }
  return "storage";
}

/**
 * The same guard as a classic script body, for the module the server sends in
 * place of a chunk it does not have. It reloads once per URL per cooldown;
 * inside the cooldown (or with no marker that would survive the reload) it
 * throws an error `isChunkLoadError` recognises, so the importing page's own
 * recovery and error boundary see the failure instead of a module that
 * silently has no exports. It runs `chunkReloadGuard` itself, so it and the
 * page's client share one marker and one reload between them.
 */
export function chunkReloadStubScript(
  pathname: string,
  cooldownMs: number = DEFAULT_CHUNK_RELOAD_COOLDOWN_MS,
): string {
  const key = JSON.stringify(CHUNK_RELOAD_MARKER);
  const error = JSON.stringify(`Failed to fetch dynamically imported module: ${pathname}`);
  return (
    `var g=${chunkReloadGuard.toString()};var r=!1;` +
    `try{r=navigator.onLine!==!1&&g(${key},window.location.href,${Number(cooldownMs)},!0)==="ok"}catch(e){}` +
    `if(r)window.location.reload();else throw new Error(${error});export {}`
  );
}
