import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  memo,
  type ComponentProps,
  type SyntheticEvent,
} from "react";

import { applyParams } from "../utils/applyParams";
import { useLocation } from "./useLocation";
import type { UrlParser, ViewResult } from "./types";
import { useNavigate } from "./useNavigate";
import type { ViewRPC } from "./rpc";
import type { Prettify } from "../utils/type";
import { useParams } from "./useParams";
import { I18nContext } from "./I18nContext";
import { useRouteTransition } from "./RouteTransitionProvider";
import { usePrefetch } from "./usePrefetch";

type Views = {
  [K in keyof ViewRPC as K extends `view:${infer P}`
    ? P
    : never]: ViewResult<K>;
};

type Search = Record<string, string | number | boolean | undefined | null>;

/**
 * When to warm the target route's data, styles and chunks.
 *
 * - `hover` — the moment the pointer arrives, or on touch or keyboard focus.
 * - `intent` — hover held long enough to read as intent, so a cursor sweeping
 *   across a nav bar does not fire a request per link it crosses.
 * - `viewport` — as the link comes into view.
 * - `render` — as soon as the link renders.
 *
 * Several can be combined. The useful pairing is a bulk strategy with an
 * interactive one — `["viewport", "intent"]` warms the link on the way past and
 * warms it again on approach if the cached payload has since gone stale.
 * `hover` and `intent` together is just `hover`, since it fires first.
 *
 * Every strategy stands down on metered or very slow connections.
 */
export type PrefetchStrategy = "hover" | "intent" | "viewport" | "render";

/** How long the pointer has to rest on an `intent` link before it counts. */
const INTENT_DELAY = 100;

/** How far ahead of the viewport a `viewport` link starts warming. */
const VIEWPORT_MARGIN = "200px";

type LinkBaseProps<T extends keyof Views> = Omit<
  ComponentProps<"a">,
  "href"
> & {
  active?: boolean;
  href: T;
  hash?: string;
  /** Off unless set. `false` is accepted so it can be driven by a variable. */
  prefetch?: PrefetchStrategy | readonly PrefetchStrategy[] | false;
  params: UrlParser<T>;
  search?: T extends keyof Views
    ? Views[T]["input"] extends Record<string, never>
      ? Search
      : Prettify<Partial<Views[T]["input"]> & Search>
    : Search;
};

type LinkProps<T extends keyof Views, U = UrlParser<T>> = U extends Record<
  string,
  never
>
  ? Omit<LinkBaseProps<T>, "params">
  : LinkBaseProps<T>;

function normalizeSearch(search: Search): Record<string, string> {
  return Object.fromEntries(
    Object.entries(search)
      .filter(([_k, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;
}

export const Link = memo(<T extends keyof Views>(props: LinkProps<T>) => {
  const _params = useParams();
  const { isTransitioning, targetPath } = useRouteTransition();
  const {
    href,
    onClick,
    onMouseEnter,
    onMouseLeave,
    onTouchStart,
    onFocus,
    onBlur,
    ref,
    hash = "",
    active = false,
    prefetch,
    params = {},
    search = {},
    ...rest
  } = { params: _params, search: {}, ...props };
  const { defaultLocale } = useContext(I18nContext);
  const { push } = useNavigate();
  const location = useLocation();
  const prefetchRoute = usePrefetch();
  const searchParams = new URLSearchParams(normalizeSearch(search));

  const path = applyParams(href, params);
  let urlLocaleSegment = location.locale;
  if (urlLocaleSegment === defaultLocale) {
    urlLocaleSegment = "";
  }

  const localeSegment = urlLocaleSegment ? `/${urlLocaleSegment}` : "";

  const targetHref = [
    [`${localeSegment}${path}`, searchParams.toString()]
      .filter((s) => s.length > 0)
      .join("?"),
    hash,
  ].join("");

  const currentHref = [location.pathname, location.search, location.hash]
    .filter((item) => !!item)
    .join("");

  // Held in a ref because the prefetch callback is rebuilt on every router
  // render — an effect that depended on it would re-fire on renders that have
  // nothing to do with this link.
  const prefetchRouteRef = useRef(prefetchRoute);
  useEffect(() => {
    prefetchRouteRef.current = prefetchRoute;
  });

  // Clicking through to the path we are already on is a shallow navigation —
  // it moves the URL without fetching, so there is nothing to warm.
  const isShallowTarget = (path || "/") === location.pathname;

  const strategies = !prefetch
    ? []
    : Array.isArray(prefetch)
      ? prefetch
      : [prefetch];
  const uses = (strategy: PrefetchStrategy) => strategies.includes(strategy);
  // Effects below key off the strategies, which arrive as an array literal with
  // a fresh identity on every render. The names are what actually matters.
  const strategyKey = strategies.join(",");

  // Repeats are the cache's problem, not this component's: it collapses a
  // hover storm into one request and lets a hover past the TTL refresh a
  // payload that has gone stale.
  const runPrefetch = () => {
    if (strategies.length === 0 || isShallowTarget) {
      return;
    }
    prefetchRouteRef.current(href, { params, search } as never);
  };

  useEffect(() => {
    if (uses("render")) {
      runPrefetch();
    }
  }, [strategyKey, targetHref]);

  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  // A caller's own `ref` still has to reach them — under React 19 it arrives as
  // a plain prop, and the spread below would otherwise hand the element to one
  // of us and null to the other.
  //
  // Memoised because `Link` re-renders on every navigation in the app: a fresh
  // callback identity would have React detach and reattach the element each
  // time, handing a caller's ref callback a null it never asked for.
  const setAnchorRef = useCallback(
    (node: HTMLAnchorElement | null) => {
      anchorRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  useEffect(() => {
    if (!uses("viewport")) {
      return;
    }
    const element = anchorRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    // One shot: a link scrolled past and back is already warm, and if its entry
    // has expired the next hover or click pays for a fresh one.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          runPrefetch();
        }
      },
      { rootMargin: VIEWPORT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [strategyKey, targetHref]);

  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelIntent = () => {
    if (intentTimerRef.current !== null) {
      clearTimeout(intentTimerRef.current);
      intentTimerRef.current = null;
    }
  };
  useEffect(() => cancelIntent, []);

  /** A pointer arriving — the one signal `intent` waits on before believing. */
  const pointerArrived = () => {
    if (uses("hover")) {
      runPrefetch();
    } else if (uses("intent")) {
      cancelIntent();
      intentTimerRef.current = setTimeout(runPrefetch, INTENT_DELAY);
    }
  };

  /** Focus and touch are deliberate, so neither strategy makes them wait. */
  const linkTargeted = () => {
    if (uses("hover") || uses("intent")) {
      runPrefetch();
    }
  };

  /** Runs the caller's own handler first, then the prefetch trigger. */
  const prefetchOn =
    <E extends SyntheticEvent>(
      handler: ((event: E) => void) | undefined,
      trigger: () => void,
    ) =>
    (event: E) => {
      handler?.(event);
      trigger();
    };

  return (
    <a
      ref={setAnchorRef}
      data-active={active || currentHref === targetHref}
      data-pending={href === targetPath && isTransitioning}
      href={targetHref === '' ? '/' : targetHref}
      onClick={(e) => {
        if (typeof window !== "undefined") {
          if (currentHref === targetHref) {
            e.preventDefault();
            return;
          }
        }
        let currentPath = window.location.pathname.replace(localeSegment, "");
        currentPath = currentPath === "" ? "/" : currentPath;
        onClick?.(e);

        if (hash === "") {
          e.preventDefault();
        }
        push(href, {
          hash,
          search,
          params,
          shallow: path === currentPath,
        } as unknown as never);
      }}
      onMouseEnter={prefetchOn(onMouseEnter, pointerArrived)}
      onMouseLeave={prefetchOn(onMouseLeave, cancelIntent)}
      onTouchStart={prefetchOn(onTouchStart, linkTargeted)}
      onFocus={prefetchOn(onFocus, linkTargeted)}
      onBlur={prefetchOn(onBlur, cancelIntent)}
      {...rest}
    />
  );
});
