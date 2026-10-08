/** What `onStaticNavigate` and the `gemi:page-load` event report. */
export interface StaticPageLoad {
  /** The page's URL, `#hash` included. */
  url: string;
  /** Its `document.title`. */
  title: string;
  /** `true` for the page the browser loaded, `false` after a client navigation. */
  initial: boolean;
}

/** The state the navigation runtime keeps on `window` (see `internal/staticNavigation`). */
type RuntimeState = { p?: StaticPageLoad } | undefined;

/**
 * Calls `callback` for every page a static view's navigation runtime shows
 * (`.static({ navigation })`): right away for the current page, then after
 * every client-side navigation. Returns a function that stops it.
 *
 * Meant for analytics and the like from an island:
 *
 * ```tsx
 * useEffect(() => onStaticNavigate(({ url }) => track(url)), []);
 * ```
 *
 * Without the runtime (a hydrated page, a static page without `navigation`,
 * the server), it does nothing. The same notice is the `gemi:page-load` event
 * on `document`, for code that is not an island.
 */
export function onStaticNavigate(callback: (page: StaticPageLoad) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const listener = (event: Event) => callback((event as CustomEvent<StaticPageLoad>).detail);
  document.addEventListener("gemi:page-load", listener);
  const current = (window as unknown as { __gemi_nav?: RuntimeState }).__gemi_nav?.p;
  if (current) callback(current);
  return () => document.removeEventListener("gemi:page-load", listener);
}
