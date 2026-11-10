import { Action } from "history";

/**
 * Where the window was scrolled on each history entry, so back/forward returns
 * to it (#1215).
 *
 * Kept by history entry, not by URL: two entries with the same URL are two
 * places in the tab's history, and an entry is restored as often as it is
 * returned to. The browser's own restoration is switched off
 * (`history.scrollRestoration = "manual"`): on a back/forward it scrolls while
 * the previous page is still on screen, before the router has rendered the
 * entry it restores. The positions are kept in `sessionStorage` when the page
 * is left, so a reload, or coming back to the tab's earlier pages from another
 * site, restores them too.
 */

const STORAGE_KEY = "gemi:scroll";
/** Entries kept: the oldest go first. */
const LIMIT = 100;

let positions: Map<string, number> | null = null;
/** The entry whose page is on screen: set when a navigation commits. */
let onScreen: string | null = null;

function stored() {
  if (positions) return positions;
  positions = new Map();
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(saved)) positions = new Map(saved);
  } catch {
    // Storage blocked or unreadable: positions last as long as the page.
  }
  return positions;
}

/**
 * The history entry `location` is: the `history` package's key, or the URL for
 * an entry it has not keyed (`"default"`): the one a page loaded on, or one a
 * same-page `#hash` link added, which is why the hash is part of it.
 */
export function entryKey(location: {
  key?: string;
  pathname: string;
  search: string;
  hash: string;
}) {
  return location.key && location.key !== "default"
    ? location.key
    : `${location.pathname}${location.search}${location.hash}`;
}

/** The entry the window is on right now (before the router has a location). */
export function currentEntryKey() {
  return entryKey({
    key: window.history.state?.key,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
}

/** Records the scroll position of the page on screen, before the router leaves it. */
export function saveScroll() {
  if (onScreen === null) return;
  const saved = stored();
  saved.delete(onScreen);
  saved.set(onScreen, window.scrollY);
  if (saved.size > LIMIT) saved.delete(saved.keys().next().value!);
}

/**
 * Switches the browser's restoration off and keeps the positions across a
 * reload. Returns the cleanup.
 */
export function manageScroll() {
  window.history.scrollRestoration = "manual";
  const persist = () => {
    saveScroll();
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...stored()]));
    } catch {
      // Storage full or blocked: a reload starts at the top.
    }
  };
  window.addEventListener("pagehide", persist);
  return () => window.removeEventListener("pagehide", persist);
}

function loadedBy() {
  const [navigation] = (performance.getEntriesByType?.("navigation") ??
    []) as PerformanceNavigationTiming[];
  return navigation?.type;
}

/**
 * Scrolls for a navigation that has just committed, once per navigation:
 * - a push or replace goes to the top, or to the `#hash` element when there is one;
 * - back/forward goes back to where the entry was left (the hash, or the top,
 *   for an entry without a position), whether or not a shallow navigation made
 *   it: a filtered list (`searchParams.push()`) is returned to from a detail
 *   page with a full navigation, and the browser no longer restores it;
 * - a shallow push or replace stays where it is: the page on screen did not
 *   change (nor does a back/forward to a shallow entry nothing was saved for);
 * - the page a document loaded on is restored only on a reload or a
 *   back/forward to it; otherwise the browser has placed it (at its `#hash`).
 */
export function restoreScroll(navigation: {
  key: string;
  action: Action | null;
  hash: string;
  shallow: boolean;
}) {
  onScreen = navigation.key;
  const saved = stored().get(navigation.key);
  if (navigation.action === null) {
    const type = loadedBy();
    if (saved !== undefined && (type === "reload" || type === "back_forward")) {
      window.scrollTo(0, saved);
    }
    return;
  }
  if (navigation.action === Action.Pop && saved !== undefined) {
    window.scrollTo(0, saved);
    return;
  }
  if (navigation.shallow) return;
  if (navigation.hash.length > 1) {
    let id = navigation.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Not percent-encoded: the id as written.
    }
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView();
      return;
    }
  }
  window.scrollTo(0, 0);
}
