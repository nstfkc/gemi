import type { Action, History, Listener, Location, To } from "history";

/**
 * The part of `history`'s `createBrowserHistory` (v5) the client router uses,
 * without the package (#1162): `push`, `replace`, `listen`, `go`, and the
 * current `location` and `action`.
 *
 * It keeps the package's `window.history.state` shape, `{ usr, key, idx }`,
 * because scroll restoration keys positions by `key`, and an entry pushed by
 * a page from before this change must still be read the same way. Blocking
 * (`block`) is not used by gemi and not supported.
 */
export function createBrowserHistory(): History {
  const globalHistory = window.history;
  const listeners = new Set<Listener>();

  const read = (): [number | undefined, Location] => {
    const { pathname, search, hash } = window.location;
    const state = globalHistory.state || {};
    return [
      state.idx,
      { pathname, search, hash, state: state.usr ?? null, key: state.key || "default" },
    ];
  };

  let action = "POP" as Action;
  let [index, location] = read();
  if (index == null) {
    index = 0;
    globalHistory.replaceState({ ...globalHistory.state, idx: index }, "");
  }

  const apply = (next: Action) => {
    action = next;
    [index, location] = read();
    for (const listener of [...listeners]) listener({ action, location });
  };

  window.addEventListener("popstate", () => apply("POP" as Action));

  const createHref = (to: To) =>
    typeof to === "string" ? to : `${to.pathname ?? ""}${to.search ?? ""}${to.hash ?? ""}`;
  const entry = (state: unknown, idx: number) => ({
    usr: state ?? null,
    key: Math.random().toString(36).slice(2, 10),
    idx,
  });

  return {
    get action() {
      return action;
    },
    get location() {
      return location;
    },
    createHref,
    push(to, state) {
      const url = createHref(to);
      try {
        globalHistory.pushState(entry(state, (index ?? 0) + 1), "", url);
      } catch {
        // iOS limits pushState calls; fall back to a real navigation.
        window.location.assign(url);
      }
      apply("PUSH" as Action);
    },
    replace(to, state) {
      globalHistory.replaceState(entry(state, index ?? 0), "", createHref(to));
      apply("REPLACE" as Action);
    },
    go: (delta) => globalHistory.go(delta),
    back: () => globalHistory.go(-1),
    forward: () => globalHistory.go(1),
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    block() {
      throw new Error("gemi: history.block() is not supported.");
    },
  };
}
