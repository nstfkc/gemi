import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import type { UrlParser, ViewPaths } from "./types";
import { applyParams } from "../utils/applyParams";

type Options<T extends ViewPaths> =
  UrlParser<T> extends never
    ? {
        search?: Record<string, string | number | boolean | undefined | null>;
        shallow?: boolean;
      }
    : {
        search?: Record<string, string | number | boolean | undefined | null>;
        params: UrlParser<T>;
        shallow?: boolean;
      };

export function useRouter() {
  const { updatePageData, history, getViewPathsFromPathname } =
    useContext(ClientRouterContext);

  function action(pushOrReplace: "push" | "replace") {
    return async <T extends ViewPaths>(
      path: T,
      ...args: UrlParser<T> extends never
        ? [options?: Options<T>]
        : [options: Options<T>]
    ) => {
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

      const basePath = applyParams(path, params);

      const navigationPath = [
        applyParams(path, params),
        urlSearchParams.toString(),
      ].join("?");

      const components = getViewPathsFromPathname(path);

      const fetchUrlSearchParams = new URLSearchParams(urlSearchParams);
      fetchUrlSearchParams.set("json", "true");
      const fetchPath = [basePath, fetchUrlSearchParams.toString()].join("?");

      urlSearchParams.set("json", "true");

      if (shallow) {
        history?.[pushOrReplace](navigationPath);
        return;
      }

      const [res] = await Promise.all([
        fetch(fetchPath),
        ...components.map((component) => (window as any).loaders[component]()),
      ]);

      if (res.ok) {
        const { data, is404 = false } = await res.json();

        updatePageData(data);
        history?.[pushOrReplace](navigationPath, is404 ? { status: 404 } : {});
        window.scrollTo(0, 0);
      }
    };
  }

  return {
    push: action("push"),
    replace: action("replace"),
  };
}
