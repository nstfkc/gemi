import { useContext } from "react";
import { useRoute } from "./useRoute";
import { ClientRouterContext } from "./ClientRouterContext";

export type Breadcrumb = {
  label: string;
  href: string;
};

export function useBreadcrumbs() {
  const { pathname } = useRoute();
  const { getViewPathsFromPathname, breadcrumbsCache } =
    useContext(ClientRouterContext);

  let breadcrumbs: Breadcrumb[] = [];
  const viewPaths = getViewPathsFromPathname(pathname);
  for (const viewPath of viewPaths) {
    if (breadcrumbsCache.has(`${viewPath}:${pathname}`)) {
      breadcrumbs.push(breadcrumbsCache.get(`${viewPath}:${pathname}`));
    }
  }

  return breadcrumbs.filter((breadcrumb) => breadcrumb?.label.length > 0);
}
