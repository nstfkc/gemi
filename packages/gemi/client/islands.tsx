import {
  type ComponentType,
  type Context,
  type ReactElement,
  type ReactNode,
  Fragment,
  createContext,
  createElement,
  lazy,
  use,
  useContext,
} from "react";

/**
 * When an island's code is fetched and hydrated, per marker.
 *
 * - `"eager"` (default): as soon as the page has parsed. The island's chunks
 *   and React are `modulepreload`ed from the head, so they are usually in
 *   cache by then.
 * - `"idle"`: on `requestIdleCallback` (a timeout where unsupported).
 * - `"visible"`: when the island's content first scrolls into view. Suits a
 *   heavy island far down the page, like a canvas or a map.
 */
export type IslandLoad = "eager" | "idle" | "visible";

export interface IslandOptions {
  /** When the island hydrates on a static page. Defaults to `"eager"`. */
  load?: IslandLoad;
  /** Which export of the module is the component. Defaults to `"default"`. */
  export?: string;
}

/**
 * `() => import("./Counter")`, the argument `island()` takes. gemi's Vite
 * plugin adds the module's build key and the module itself, so the server can
 * render it synchronously in a hydrated view and point a static page at its
 * built chunk.
 */
export type IslandLoader<M = any> = (() => Promise<M>) & {
  /** @internal The module's path from the project root, the client manifest's key. */
  gemiIsland?: string;
  /** @internal The module, statically imported by the plugin. */
  gemiModule?: M;
};

/** @internal One island module a static page uses: an entry of the page's island table. */
export interface IslandEntry {
  /** The module's build key, or `undefined` when the plugin did not run. */
  module: string | undefined;
  export: string;
  load: IslandLoad;
}

interface IslandInstance {
  html: Promise<string>;
  index: number;
  uid: string;
  props: string | undefined;
}

/**
 * @internal Provided by the view router around a static view's render; `null`
 * everywhere else, which is how `island()` knows to render a plain component.
 */
export interface StaticRenderCollector {
  /** The page's island table: what the loader imports, by marker index. */
  islands: IslandEntry[];
  /**
   * Renders one island as its own React root, settled, to HTML. Supplied by
   * the server, so this module never imports `react-dom/server`.
   */
  render: (element: ReactElement, identifierPrefix: string) => Promise<string>;
  /** Per-instance render state, keyed by the island's props object. */
  instances: WeakMap<object, IslandInstance>;
  /** Instances rendered so far, for each one's `identifierPrefix`. */
  count: number;
}

/** @internal */
export function createStaticRenderCollector(
  render: StaticRenderCollector["render"],
): StaticRenderCollector {
  return { islands: [], render, instances: new WeakMap(), count: 0 };
}

/** @internal The element an island's static children land in. */
export const ISLAND_SLOT_TAG = "gemi-slot";
/** @internal On the empty slot an island's own render leaves for its children. */
export const ISLAND_SLOT_ATTRIBUTE = "data-slot";
/** @internal On the template holding the children the page tree rendered. */
export const ISLAND_SLOT_TEMPLATE_ATTRIBUTE = "data-gemi-slot";

/** The property gemi's Vite plugin attaches to an island's loader. */
export const ISLAND_MODULE_KEY = "gemiIsland";

const CONTEXT_KEY = Symbol.for("gemi.staticRender");

/**
 * @internal On `globalThis` rather than a module-level `createContext`: the
 * published package bundles `gemi/client` and the server side separately, so a
 * plain module singleton would give the provider and the islands two different
 * context objects.
 */
export const StaticRenderContext: Context<StaticRenderCollector | null> = ((
  globalThis as Record<symbol, unknown>
)[CONTEXT_KEY] ??= createContext<StaticRenderCollector | null>(null)) as Context<
  StaticRenderCollector | null
>;

const isProduction = () =>
  typeof process !== "undefined" && process.env?.NODE_ENV === "production";

/**
 * Throws when `value` would not survive `JSON.stringify` and `JSON.parse`
 * unchanged, naming the prop. An island's props cross from the server to the
 * browser as JSON: a function would vanish and a `Date` would arrive as a
 * string, so the island would hydrate with other props than it rendered with.
 */
export function assertSerialisableProps(value: unknown, island: string): void {
  const seen = new Set<object>();
  const fail = (path: string, what: string): never => {
    throw new Error(
      `${island}: the prop \`${path}\` is ${what}. An island's props are sent to the browser ` +
        `as JSON, so they must be plain data: strings, finite numbers, booleans, null, ` +
        `arrays and plain objects. Pass static markup as children instead.`,
    );
  };
  const walk = (v: unknown, path: string, inArray: boolean): void => {
    switch (typeof v) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(v)) fail(path, String(v));
        return;
      case "undefined":
        // Dropped from an object, which reads back the same; not in an array.
        if (inArray) fail(path, "undefined (it would arrive as null)");
        return;
      case "function":
        fail(path, "a function");
        return;
      case "symbol":
      case "bigint":
        fail(path, `a ${typeof v}`);
        return;
    }
    if (v === null) return;
    const object = v as Record<string, unknown>;
    if (seen.has(object)) fail(path, "a circular reference");
    if ("$$typeof" in object) fail(path, "a React element");
    seen.add(object);
    if (Array.isArray(object)) {
      object.forEach((item, i) => walk(item, `${path}[${i}]`, true));
    } else {
      const proto = Object.getPrototypeOf(object);
      if (proto !== Object.prototype && proto !== null) {
        fail(path, `an instance of ${proto?.constructor?.name || "a class"}`);
      }
      for (const [key, item] of Object.entries(object)) {
        walk(item, path ? `${path}.${key}` : key, false);
      }
    }
    seen.delete(object);
  };
  walk(value, "", false);
}

const hasChildren = (children: unknown) =>
  children !== undefined && children !== null && typeof children !== "boolean";

type AnyComponent = ComponentType<any>;

/**
 * Makes a component an island: hydrated on its own on a static page, an
 * ordinary component everywhere else.
 *
 * ```tsx
 * // app/views/site/Counter.tsx: a plain React component
 * export default function Counter({ start }: { start: number }) {
 *   const [n, setN] = useState(start);
 *   return <button onClick={() => setN(n + 1)}>{n}</button>;
 * }
 *
 * // where it is used
 * const Counter = island(() => import("./Counter"), { load: "visible" });
 * <Counter start={3} />
 * ```
 *
 * - In a **static** view (`this.view(...).static()`), it server-renders the
 *   component as its own React root inside a `<gemi-island>` marker and
 *   serialises its props. The page gets a tiny loader that, on the island's
 *   `load` trigger, imports React (one chunk shared by every island) and the
 *   component's chunk and calls `hydrateRoot` on the marker.
 * - In a **hydrated** view, it is the component itself: rendered inline, with
 *   the page's context, and nothing extra to load.
 *
 * Write the loader exactly as `() => import("./path")` inside the `island(`
 * call: gemi's Vite plugin finds that call, builds the module as its own
 * client entry and imports it statically for the server.
 *
 * Props must be plain data (checked in dev). `children` are rendered on the
 * server as static HTML and passed through untouched. On a static page the
 * island is a separate React root, so context from the page does not reach it.
 */
export function island<M extends { default: AnyComponent }>(
  loader: () => Promise<M>,
  options?: IslandOptions & { export?: "default" },
): M["default"];
export function island<M, K extends keyof M & string>(
  loader: () => Promise<M>,
  options: IslandOptions & { export: K },
): M[K];
export function island(loader: IslandLoader, options: IslandOptions = {}): AnyComponent {
  if (typeof loader !== "function") {
    throw new Error(
      'island() takes `() => import("./Component")` and options since gemi 0.110. ' +
        'The island("name", Component, () => import("./x.island")) form was removed: see UPGRADE.md.',
    );
  }
  const exportName = options.export ?? "default";
  const load: IslandLoad = options.load ?? "eager";
  const key = loader[ISLAND_MODULE_KEY];
  const label = `island(${key ?? "() => import(…)"}${exportName === "default" ? "" : `#${exportName}`})`;

  const pick = (mod: Record<string, unknown>): AnyComponent => {
    const component = mod?.[exportName];
    if (typeof component !== "function" && (typeof component !== "object" || component === null)) {
      throw new Error(`${label}: the module has no component export \`${exportName}\`.`);
    }
    return component as AnyComponent;
  };

  // A hydrated view renders the component in place. The plugin imported the
  // module statically; without it (a test that doesn't run the plugin) the
  // component loads lazily and suspends once.
  let inline: AnyComponent | undefined;
  const inlineComponent = (): AnyComponent =>
    (inline ??= loader.gemiModule
      ? pick(loader.gemiModule)
      : lazy(() => loader().then((mod) => ({ default: pick(mod) }))));

  const register = (collector: StaticRenderCollector): number => {
    const known = collector.islands.findIndex(
      (entry) =>
        key !== undefined && entry.module === key && entry.export === exportName && entry.load === load,
    );
    return known !== -1 ? known : collector.islands.push({ module: key, export: exportName, load }) - 1;
  };

  const start = (collector: StaticRenderCollector, props: Record<string, unknown>): IslandInstance => {
    const { children, ...rest } = props;
    if (!isProduction()) {
      assertSerialisableProps(rest, label);
    }
    const uid = `i${collector.count++}-`;
    const component = loader.gemiModule
      ? Promise.resolve(pick(loader.gemiModule))
      : loader().then(pick);
    // The island's own render is a root of its own, as it will be in the
    // browser: islands nested in it are plain components of that root. Its
    // children are not rendered here: they belong to the page (and its
    // context), so the page tree renders them next to the marker and
    // `spliceIslandSlots` moves their HTML into this empty slot.
    const html = component.then((Component) =>
      collector.render(
        createElement(
          StaticRenderContext.Provider,
          { value: null },
          hasChildren(children)
            ? createElement(
                Component,
                rest,
                createElement(ISLAND_SLOT_TAG, { [ISLAND_SLOT_ATTRIBUTE]: uid, style: { display: "contents" } }),
              )
            : createElement(Component, rest),
        ),
        uid,
      ),
    );
    // A rejection surfaces through `use`; this keeps it from also being
    // reported as unhandled.
    html.catch(() => {});
    const json = JSON.stringify(rest);
    return { html, index: register(collector), uid, props: json === "{}" ? undefined : json };
  };

  function Island(props: Record<string, unknown>): ReactNode {
    const collector = useContext(StaticRenderContext);
    if (!collector) {
      return createElement(inlineComponent(), props);
    }

    // Suspending on `use` re-renders this component with the same props
    // object, so the render it started is found again rather than restarted.
    let instance = collector.instances.get(props);
    if (!instance) {
      instance = start(collector, props);
      collector.instances.set(props, instance);
    }

    const marker = createElement("gemi-island", {
      "data-island": instance.index,
      "data-uid": instance.uid,
      // React escapes attribute values, so the JSON needs (and must get) no
      // escaping of its own.
      "data-props": instance.props,
      style: { display: "contents" },
      dangerouslySetInnerHTML: { __html: use(instance.html) },
    });
    if (!hasChildren(props.children)) {
      return marker;
    }
    // The children, rendered here in the page tree with the page's context
    // (islands among them are islands of their own), in a template the
    // static document splices into the island's slot before it is sent.
    return createElement(
      Fragment,
      null,
      marker,
      createElement("template", { [ISLAND_SLOT_TEMPLATE_ATTRIBUTE]: instance.uid }, props.children as ReactNode),
    );
  }

  Island.displayName = label;
  return Island;
}
