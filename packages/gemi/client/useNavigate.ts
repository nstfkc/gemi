import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import type { UrlParser, ViewPaths } from "./types";
import { applyParams } from "../utils/applyParams";
import { useLocation } from "./useLocation";

type Options<T extends ViewPaths> = UrlParser<T> extends Record<string, never>
  ? {
      search?: Record<string, string | number | boolean | undefined | null>;
      shallow?: boolean;
      locale?: string;
    }
  : {
      search?: Record<string, string | number | boolean | undefined | null>;
      params: UrlParser<T>;
      shallow?: boolean;
      locale?: string;
    };

export function useNavigate() {
  const { history, setNavigationAbortController } =
    useContext(ClientRouterContext);
  const location = useLocation();
  function action(pushOrReplace: "push" | "replace") {
    return async <T extends ViewPaths>(
      path: T | (string & {}),
      ...args: UrlParser<T> extends Record<string, never>
        ? [options?: Options<T>]
        : [options: Options<T>]
    ) => {
      const navigationAbortController = new AbortController();
      setNavigationAbortController(navigationAbortController);

      const [options = {}] = args;
      const {
        search = {},
        params = {},
        shallow,
        locale,
      } = {
        params: {},
        shallow: false,
        locale: null,
        ...options,
      };

      const urlSearchParams = new URLSearchParams(search);
      let localeSegment = location.locale;
      if (locale) {
        localeSegment = locale;
      }

      let routePath = applyParams(path, params);
      routePath = localeSegment && routePath === "/" ? "" : routePath;
      const navigationPath = [
        [localeSegment ? `/${localeSegment}` : "", routePath].join(""),
        urlSearchParams.toString(),
      ].join("?");

      if (shallow) {
        history?.[pushOrReplace](navigationPath);
        return;
      }

      history?.[pushOrReplace](navigationPath);
    };
  }

  return {
    push: action("push"),
    replace: action("replace"),
  };
}
