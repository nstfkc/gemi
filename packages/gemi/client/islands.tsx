import { type ComponentType, type Context, createContext, createElement, useContext } from "react";

/**
 * When an island's client module is fetched and mounted, per marker.
 *
 * - `"eager"` (default): as soon as the page has parsed. The module (and its
 *   static imports) is `modulepreload`ed from the head, so it is usually in
 *   cache by then.
 * - `"idle"`: on `requestIdleCallback` (a timeout where unsupported).
 * - `"visible"`: when the island's content first scrolls into view. Suits a
 *   heavy island far down the page, like a canvas or a map.
 */
export type IslandLoad = "eager" | "idle" | "visible";

/**
 * The default export of an island's client module (`*.island.ts`). Runs once
 * per marker on the page: `root` is the `<gemi-island>` element wrapping the
 * server-rendered markup, `props` what the island chose to serialise (see
 * `IslandOptions.props`), or `undefined`.
 *
 * Plain DOM code — no React is loaded on a static page.
 */
export type IslandMount<P = unknown> = (root: HTMLElement, props: P) => void;

/** `() => import("./x.island")`. Never called on the server. */
export type IslandLoader = () => Promise<{ default: IslandMount<any> }>;

export interface IslandOptions<P> {
  /** When the client module loads. Defaults to `"eager"`. */
  load?: IslandLoad;
  /**
   * What `mount` receives as `props`. Left out (or `false`), nothing is
   * serialised: most islands read what they need from the markup. `true`
   * serialises the component's props without `children`; a function picks
   * what to send.
   *
   * Serialised with `JSON.stringify` into an attribute, so the value must be
   * JSON: functions and `undefined` are dropped, a `Date` becomes a string.
   * Anything in it is visible in the page source.
   */
  props?: boolean | ((props: P) => unknown);
}

/** @internal What a static render records about the islands it used. */
export interface StaticRenderCollector {
  /** Island name -> the client module's build key and load strategy. */
  islands: Map<string, { module: string; load: IslandLoad }>;
}

/** The property gemi's Vite plugin attaches to an island's loader. */
export const ISLAND_MODULE_KEY = "gemiIsland";

const CONTEXT_KEY = Symbol.for("gemi.staticRender");

/**
 * @internal Provided by the view router around a static view's render; `null`
 * everywhere else, which is how `island()` knows to render a plain component.
 *
 * On `globalThis` rather than a module-level `createContext`: the published
 * package bundles `gemi/client` and the server side separately, so a plain
 * module singleton would give the provider and the islands two different
 * context objects.
 */
export const StaticRenderContext: Context<StaticRenderCollector | null> = ((
  globalThis as Record<symbol, unknown>
)[CONTEXT_KEY] ??= createContext<StaticRenderCollector | null>(null)) as Context<
  StaticRenderCollector | null
>;

function serialiseProps<P>(props: P, option: IslandOptions<P>["props"]): string | undefined {
  if (!option) {
    return undefined;
  }
  let value: unknown;
  if (option === true) {
    const { children: _children, ...rest } = (props ?? {}) as Record<string, unknown>;
    value = rest;
  } else {
    value = option(props);
  }
  // React escapes attribute values (`"`, `&`, `<`, `>`), so the JSON needs no
  // escaping of its own here — and must not get any, or `mount` would read
  // the escapes back.
  return JSON.stringify(value);
}

/**
 * Declares an interactive part of a page.
 *
 * ```tsx
 * export const NavMenu = island("nav-menu", NavMenuView, () => import("./navMenu.island"));
 * ```
 *
 * - In a **static** view (`this.view(...).static()`), it server-renders
 *   `Component` inside a `<gemi-island name="nav-menu">` marker and records
 *   that the page uses it. The document then carries a tiny loader plus the
 *   island's own module — and only for islands that rendered. The module's
 *   default export (`IslandMount`) is called once per marker.
 * - In a **hydrated** view, it renders `Component` as an ordinary component and
 *   loads nothing: the same component works in both kinds of page.
 *
 * The client module must be a file named `*.island.ts` (or `.tsx`/`.js`)
 * under `app/`, imported exactly as `() => import("./path.island")`: gemi's
 * Vite plugin finds that call, builds the file as its own entry, and tells the
 * server which built file it is.
 *
 * `name` identifies the island in the markup and must be unique per module.
 */
export function island<P extends object>(
  name: string,
  Component: ComponentType<P>,
  loader: IslandLoader,
  options: IslandOptions<P> = {},
): ComponentType<P> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("island(): the name must be a non-empty string.");
  }
  const load: IslandLoad = options.load ?? "eager";

  function Island(props: P) {
    const collector = useContext(StaticRenderContext);
    if (!collector) {
      return createElement(Component, props);
    }

    const module = (loader as unknown as Record<string, unknown>)[ISLAND_MODULE_KEY];
    if (typeof module !== "string") {
      throw new Error(
        `island("${name}"): the client module could not be identified. Pass the loader as ` +
          `\`() => import("./name.island")\` — a file named *.island.ts(x) under app/ — so ` +
          `gemi's Vite plugin can map it to its built file.`,
      );
    }
    const known = collector.islands.get(name);
    if (known && known.module !== module) {
      throw new Error(
        `island("${name}") is declared for two modules (${known.module} and ${module}). ` +
          `Island names must be unique.`,
      );
    }
    collector.islands.set(name, { module, load });

    return createElement(
      "gemi-island",
      {
        name,
        "data-props": serialiseProps(props, options.props),
        style: { display: "contents" },
      },
      createElement(Component, props),
    );
  }

  Island.displayName = `Island(${name})`;
  return Island;
}
