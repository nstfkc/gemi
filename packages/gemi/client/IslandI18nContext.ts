import { type Context, createContext, useContext } from "react";
import { useRouteData } from "./useRouteData";

/**
 * The page's i18n, as much of it as an island on a static page gets (#1095):
 * the locale strings resolve in and the zone dates are formatted in.
 */
export interface IslandI18n {
  /** The page's resolved locale; absent when the app configures none. */
  currentLocale?: string;
  defaultLocale?: string;
  /** The IANA zone dates are formatted in, resolved on the server. */
  timeZone?: string;
}

/** The key the island runtime (`h`) finds this context under. */
export const ISLAND_I18N_CONTEXT_KEY = "gemi.islandI18n";

/**
 * @internal Provided around an island's own root on a static page: by the
 * server while it renders the island, and by the island runtime when it
 * hydrates it, from the document's `gemi-island-i18n` payload. `null`
 * everywhere else.
 *
 * On `globalThis`, like `StaticRenderContext`: the runtime is plain source
 * with no imports of gemi's, so it looks the context up by this key, and the
 * published package bundles `gemi/client` and the server side separately.
 */
export const IslandI18nContext: Context<IslandI18n | null> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for(ISLAND_I18N_CONTEXT_KEY)
] ??= createContext<IslandI18n | null>(null)) as Context<IslandI18n | null>;

/**
 * @internal The page's i18n payload: the route's in a view, the island's own
 * on a static page, where an island is a React root of its own and the
 * route's does not reach it.
 */
export function usePageI18n(): IslandI18n | undefined {
  const { i18n } = useRouteData();
  const island = useContext(IslandI18nContext);
  return i18n ?? island ?? undefined;
}
