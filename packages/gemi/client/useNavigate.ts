import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import type { IsViewPath, UrlParser, ViewPaths } from "./types";
import { applyParams } from "../utils/applyParams";
import { isAbsoluteUrl } from "../utils/domainUrl";
import { useLocation } from "./useLocation";
import { I18nContext } from "./I18nContext";

type Search = Record<string, string | number | boolean | undefined | null>;

// `string` rather than `ViewPaths`, so the conditional below can name it
// without intersecting the path type back down first. `UrlParser` has always
// taken any string.
type Options<T extends string> = UrlParser<T> extends Record<string, never>
  ? {
      search?: Search;
      shallow?: boolean;
      hash?: string;
      locale?: string;
    }
  : {
      search?: Search;
      params: UrlParser<T>;
      hash?: string;
      shallow?: boolean;
      locale?: string;
    };

/**
 * The options for a path that is not a declared route: a URL built at runtime.
 *
 * `params` is present but optional. A concrete path — what `useIntendedUrl()`
 * returns — has nothing to substitute and should not have to pass an empty
 * object. But a *pattern* held in a `string` variable is the same type to
 * TypeScript and does still need its params, so refusing them here would break
 * a call that works today. `applyParams` ignores what it cannot place.
 */
type RuntimeOptions = {
  search?: Search;
  params?: Record<string, string | number | undefined>;
  hash?: string;
  shallow?: boolean;
  locale?: string;
};

/**
 * Required for a declared route that has params, optional for everything else.
 * See `IsViewPath` for why the test is on the path the caller passed rather
 * than on a type parameter constrained to `ViewPaths`.
 */
type NavigateArgs<P extends string> = IsViewPath<P> extends true
  ? UrlParser<P> extends Record<string, never>
    ? [options?: Options<P>]
    : [options: Options<P>]
  : [options?: RuntimeOptions];

export function useNavigate() {
  const { history, setNavigationAbortController } =
    useContext(ClientRouterContext);
  const { defaultLocale } = useContext(I18nContext);
  const location = useLocation();

  function action(pushOrReplace: "push" | "replace") {
    return async <P extends ViewPaths | (string & {})>(
      path: P,
      ...args: NavigateArgs<P>
    ) => {
      const navigationAbortController = new AbortController();
      if (setNavigationAbortController) {
        setNavigationAbortController(navigationAbortController);
      }

      // Another host — `useDomain().url(...)` — is out of this router's reach.
      if (isAbsoluteUrl(path)) {
        window.location[pushOrReplace === "push" ? "assign" : "replace"](path);
        return;
      }

      const [options = {}] = args;
      const {
        search = {},
        params = {},
        shallow,
        locale,
        hash,
      } = {
        params: {},
        shallow: false,
        locale: null,
        hash: "",
        ...options,
      };

      // Cast because `URLSearchParams`'s lib type takes `Record<string,
      // string>` while its runtime contract stringifies whatever it is given —
      // and `Options.search` has always accepted numbers and booleans on
      // purpose. Behaviour is unchanged; only the mismatch is now visible,
      // because the argument type above no longer defers this whole block
      // behind an unresolved conditional.
      const urlSearchParams = new URLSearchParams(search as Record<string, string>);
      let localeSegment = location.locale;
      if (locale) {
        localeSegment = locale;
      }
      if (localeSegment === defaultLocale) {
        localeSegment = "";
      }

      const routePath = applyParams(path, params);
      const navigationPath = [
        `${localeSegment ? `/${localeSegment}` : ""}${routePath === "/" ? "" : routePath}`,
        urlSearchParams.toString(),
      ]
        .filter((s) => s.length > 0)
        .join("?");

      const finalPath = [navigationPath, hash].filter(Boolean).join("");

      if (shallow) {
        history?.[pushOrReplace](finalPath, { shallow });
        return;
      }

      history?.[pushOrReplace](finalPath === '' ? '/' : finalPath);
    };
  }

  return {
    push: action("push"),
    replace: action("replace"),
  };
}
