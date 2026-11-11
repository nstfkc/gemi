/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from "vitest";
import { createBrowserHistory as packageHistory } from "history";
import { createBrowserHistory } from "./browserHistory";

/**
 * #1162: the router's own small history, in place of the `history` package's
 * `createBrowserHistory`. Same `window.history.state` shape, same events.
 */

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("createBrowserHistory (#1162)", () => {
  test("stamps the first entry with idx 0, as the package does", () => {
    window.history.replaceState({ usr: { a: 1 }, key: "k0" }, "", "/start");
    const history = createBrowserHistory();
    expect(window.history.state).toEqual({ usr: { a: 1 }, key: "k0", idx: 0 });
    expect(history.location).toMatchObject({ pathname: "/start", state: { a: 1 }, key: "k0" });
    expect(history.action).toBe("POP");
  });

  test("push and replace write { usr, key, idx } and tell the listeners", () => {
    const history = createBrowserHistory();
    const seen: unknown[] = [];
    const stop = history.listen(({ action, location }) =>
      seen.push([action, location.pathname, location.search, location.state]),
    );

    history.push("/posts/1?x=1", { shallow: true });
    const pushed = window.history.state;
    expect(pushed).toMatchObject({ usr: { shallow: true }, idx: 1 });
    expect(pushed.key).toMatch(/^[a-z0-9]+$/);
    expect(history.location.key).toBe(pushed.key);

    history.replace("/posts/2");
    expect(window.history.state).toMatchObject({ usr: null, idx: 1 });
    expect(window.history.state.key).not.toBe(pushed.key);

    stop();
    history.push("/after-stop");
    expect(seen).toEqual([
      ["PUSH", "/posts/1", "?x=1", { shallow: true }],
      ["REPLACE", "/posts/2", "", null],
    ]);
  });

  test("an object target keeps only the current pathname, as the package does", () => {
    window.history.replaceState(null, "", "/list?page=2#top");
    const ours = createBrowserHistory();
    ours.push({ hash: "#row-3" });
    const oursUrl = window.location.pathname + window.location.search + window.location.hash;

    window.history.replaceState(null, "", "/list?page=2#top");
    const theirs = packageHistory();
    theirs.push({ hash: "#row-3" });
    const theirsUrl = window.location.pathname + window.location.search + window.location.hash;

    expect(oursUrl).toBe("/list#row-3");
    expect(oursUrl).toBe(theirsUrl);
  });

  test("a popstate is a POP with the entry's location", () => {
    const history = createBrowserHistory();
    history.push("/a");
    const seen: string[] = [];
    history.listen(({ action, location }) => seen.push(`${action} ${location.pathname}`));
    window.history.replaceState({ usr: null, key: "back", idx: 0 }, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(seen).toEqual(["POP /"]);
    expect(history.location.key).toBe("back");
  });

  test("reads entries the package wrote, and the package reads ours", () => {
    const theirs = packageHistory();
    theirs.push("/theirs", { from: "package" });
    const ours = createBrowserHistory();
    expect(ours.location).toMatchObject({ pathname: "/theirs", state: { from: "package" } });
    ours.push("/ours", { from: "gemi" });
    expect(packageHistory().location).toMatchObject({ pathname: "/ours", state: { from: "gemi" } });
  });
});
