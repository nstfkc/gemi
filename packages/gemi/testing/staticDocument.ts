import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { ISLAND_HYDRATE_SOURCE } from "../internal/islandRuntime";
import { STATIC_NAVIGATION_SOURCE } from "../internal/staticNavigationRuntime";

/**
 * One page `renderStaticDocument` serves to the navigation runtime: its HTML, or
 * a response of another kind to see the runtime fall back to a full load.
 */
export interface StaticTestPage {
  html?: string;
  /** Default 200. */
  status?: number;
  /** Default `text/html; charset=utf-8`. */
  contentType?: string;
  /** The URL the response ends at, as after a redirect. Default: the one asked for. */
  url?: string;
}

export interface StaticDocumentOptions {
  /** The document's URL, resolved against the test window's origin. Default `/`. */
  url?: string;
  /**
   * What the runtime's `fetch` gets, by path (`/about`, `/about?x=1`) or full
   * URL: HTML, a `StaticTestPage`, or a function for anything else. A URL
   * not listed is a 404.
   */
  pages?:
    | Record<string, string | StaticTestPage>
    | ((url: URL) => string | StaticTestPage | Promise<string | StaticTestPage>);
  /**
   * The island modules, by the entry URL the page's island table names (`s`):
   * each a module whose exports include the islands' components. Hydrated
   * with React, as `<module>?gemi-island` would.
   */
  islands?: Record<string, Record<string, unknown>>;
}

/** How a navigation ended. */
export type StaticNavigationResult =
  /** The runtime swapped the fetched page in. */
  | { kind: "swap"; url: string }
  /** The runtime gave up on a swap and asked for a full page load of `url`. */
  | { kind: "full-load"; url: string }
  /** The runtime left the click alone: the browser would follow the link itself. */
  | { kind: "native" };

export interface StaticDocumentHandle {
  /**
   * Clicks the page's first `<a>` whose `href` attribute is `href` and waits
   * for the outcome. Throws when there is no such link.
   */
  navigate(href: string, init?: MouseEventInit): Promise<StaticNavigationResult>;
  /** `history.back()`, and waits for the runtime to show that entry. */
  back(): Promise<StaticNavigationResult>;
  /** Every URL the runtime fetched, prefetches included, in order. */
  requests: string[];
  /** Every full page load the runtime asked for. */
  fullLoads: string[];
  /** Stops the runtime and restores what the helper stubbed. */
  dispose(): void;
}

const hydrate = new Function(
  "createElement",
  "hydrateRoot",
  `${ISLAND_HYDRATE_SOURCE};return h;`,
)(createElement, hydrateRoot) as (marker: Element, component: unknown) => unknown;

/**
 * Puts a static document (`.static({ navigation })`) into the test's DOM and
 * starts its navigation runtime against stubbed pages, so a test can check that
 * a site's links are followed client-side, and what the next page looks like.
 * Needs a DOM (`// @vitest-environment jsdom`).
 *
 * ```ts
 * const html = await (await render("/")).text(); // the page, from your app
 * const page = renderStaticDocument(html, { pages: { "/about": aboutHtml } });
 * expect(await page.navigate("/about")).toEqual({ kind: "swap", url: "http://localhost:3000/about" });
 * expect(document.querySelector("h1")!.textContent).toBe("About");
 * page.dispose();
 * ```
 *
 * The document's own scripts do not run (the helper runs the runtime itself),
 * and a link the runtime leaves alone is not followed. Islands hydrate
 * asynchronously, as in a browser: wrap what follows in `act`, or wait for it.
 */
export function renderStaticDocument(
  html: string,
  options: StaticDocumentOptions = {},
): StaticDocumentHandle {
  const requests: string[] = [];
  const fullLoads: string[] = [];
  let settle: ((result: StaticNavigationResult) => void) | undefined;
  const outcome = () =>
    new Promise<StaticNavigationResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the navigation did not finish in 5 s")), 5000);
      settle = (result) => {
        clearTimeout(timer);
        settle = undefined;
        resolve(result);
      };
    });

  history.replaceState(null, "", options.url ?? "/");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const script of Array.from(parsed.querySelectorAll("script"))) {
    if (!/json/.test(script.type)) script.remove();
  }
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement);

  const fullLoad = (url: string) => {
    fullLoads.push(url);
    settle?.({ kind: "full-load", url });
  };
  const location = {
    get href() {
      return window.location.href;
    },
    get origin() {
      return window.location.origin;
    },
    assign: (url: string) => fullLoad(new URL(url, window.location.href).href),
    reload: () => fullLoad(window.location.href),
  };

  const pages = options.pages ?? {};
  const fetch = async (input: string) => {
    const url = new URL(input, window.location.href);
    requests.push(url.href);
    const page =
      typeof pages === "function"
        ? await pages(url)
        : (pages[url.href] ?? pages[url.pathname + url.search]);
    const spec: StaticTestPage =
      page === undefined
        ? { status: 404, html: "not found", contentType: "text/plain" }
        : typeof page === "string"
          ? { html: page }
          : page;
    const response = new Response(spec.html ?? "", {
      status: spec.status ?? 200,
      headers: { "content-type": spec.contentType ?? "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "url", { value: new URL(spec.url ?? url.href, url).href });
    return response;
  };

  const importIsland = async (src: string) => {
    const module = options.islands?.[src];
    if (!module) throw new Error(`renderStaticDocument: no island module for ${src} in options.islands`);
    return { m: module, h: hydrate };
  };

  // The runtime announces a click it takes with `gemi:before-navigate`; one
  // it does not take (or one a listener cancelled) is the browser's, which
  // jsdom would try (and fail) to follow, so it is stopped here, on `window`,
  // after every listener on the way.
  let announced: Event | undefined;
  const onBeforeNavigate = (event: Event) => {
    announced = event;
  };
  document.addEventListener("gemi:before-navigate", onBeforeNavigate);
  const onClick = (event: Event) => {
    const taken = announced !== undefined && !announced.defaultPrevented;
    announced = undefined;
    if (taken || !(event.target as Element).closest?.("a[href]")) return;
    event.preventDefault();
    settle?.({ kind: "native" });
  };
  window.addEventListener("click", onClick);
  const onPageLoad = (event: Event) => {
    const detail = (event as CustomEvent<{ url: string; initial: boolean }>).detail;
    if (!detail.initial) settle?.({ kind: "swap", url: detail.url });
  };
  document.addEventListener("gemi:page-load", onPageLoad);

  // Not implemented by jsdom.
  const scrollTo = window.scrollTo;
  window.scrollTo = () => {};
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {};

  const source = STATIC_NAVIGATION_SOURCE.replace("import(", "__import(");
  new Function("__import", "location", "fetch", source)(importIsland, location, fetch);

  return {
    requests,
    fullLoads,
    async navigate(href, init) {
      const link = Array.from(document.querySelectorAll("a[href]")).find(
        (a) => a.getAttribute("href") === href,
      );
      if (!link) throw new Error(`renderStaticDocument: no <a href="${href}"> on the page`);
      const done = outcome();
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
      return await done;
    },
    async back() {
      const done = outcome();
      history.back();
      return await done;
    },
    dispose() {
      (window as unknown as { __gemi_nav?: { d: () => void } }).__gemi_nav?.d();
      window.removeEventListener("click", onClick);
      document.removeEventListener("gemi:before-navigate", onBeforeNavigate);
      document.removeEventListener("gemi:page-load", onPageLoad);
      window.scrollTo = scrollTo;
      Element.prototype.scrollIntoView = scrollIntoView;
    },
  };
}
