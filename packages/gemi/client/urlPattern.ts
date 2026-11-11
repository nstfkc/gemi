/**
 * The router's `URLPattern` (#1162): the browser's own where it has one, and
 * `urlpattern-polyfill` loaded on demand where it has not.
 *
 * The polyfill is about 18 KB minified (6 KB gzip), and was in every route's
 * initial JavaScript although current Chrome, Edge, Firefox and Safari ship
 * `URLPattern`. `init()` now waits for `loadURLPattern()` before it hydrates,
 * which is a no-op on those browsers and one extra request on the others. The
 * server render and `gemi/testing` import the polyfill statically, as a
 * fallback for a runtime without it.
 */

type URLPatternCtor = new (init: { pathname: string }) => {
  test(input: { pathname: string }): boolean;
  exec(input: { pathname: string }): { pathname: { groups: Record<string, string | undefined> } } | null;
};

/** Resolves once `globalThis.URLPattern` exists; `undefined` when it already does. */
export function loadURLPattern(): Promise<void> | undefined {
  if (typeof (globalThis as { URLPattern?: unknown }).URLPattern === "function") return undefined;
  // The polyfill's entry sets `globalThis.URLPattern` when it is missing.
  return import("urlpattern-polyfill").then(() => undefined);
}

export function urlPattern(pathname: string): InstanceType<URLPatternCtor> {
  const URLPattern = (globalThis as { URLPattern?: URLPatternCtor }).URLPattern;
  if (!URLPattern) {
    throw new Error(
      "gemi: URLPattern is not available. The client router loads the polyfill in init() before it hydrates; code that renders the router some other way has to `await loadURLPattern()` first.",
    );
  }
  return new URLPattern({ pathname });
}
