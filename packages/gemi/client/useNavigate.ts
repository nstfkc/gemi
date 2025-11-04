import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import type { UrlParser, ViewPaths } from "./types";
import { applyParams } from "../utils/applyParams";
import { useLocation } from "./useLocation";
import { I18nContext } from "./I18nContext";

type Options<T extends ViewPaths> = UrlParser<T> extends Record<string, never>
  ? {
      search?: Record<string, string | number | boolean | undefined | null>;
      shallow?: boolean;
      hash?: string;
      locale?: string;
    }
  : {
      search?: Record<string, string | number | boolean | undefined | null>;
      params: UrlParser<T>;
      hash?: string;
      shallow?: boolean;
      locale?: string;
    };

export function useNavigate() {
  const { history, setNavigationAbortController } =
    useContext(ClientRouterContext);
  const { defaultLocale } = useContext(I18nContext);
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
        hash,
      } = {
        params: {},
        shallow: false,
        locale: null,
        hash: "",
        ...options,
      };

      const urlSearchParams = new URLSearchParams(search);
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

      history?.[pushOrReplace](finalPath);
    };
  }

  return {
    push: action("push"),
    replace: action("replace"),
  };
}
