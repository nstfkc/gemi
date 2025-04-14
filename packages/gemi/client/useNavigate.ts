import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import type { UrlParser, ViewPaths } from "./types";
import { applyParams } from "../utils/applyParams";

type Options<T extends ViewPaths> = UrlParser<T> extends Record<string, never>
  ? {
      search?: Record<string, string | number | boolean | undefined | null>;
      shallow?: boolean;
    }
  : {
      search?: Record<string, string | number | boolean | undefined | null>;
      params: UrlParser<T>;
      shallow?: boolean;
    };

export function useNavigate() {
  const { history, setNavigationAbortController } =
    useContext(ClientRouterContext);
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
      } = {
        params: {},
        shallow: false,
        ...options,
      };
      const urlSearchParams = new URLSearchParams(search);

      const navigationPath = [
        applyParams(path, params),
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
