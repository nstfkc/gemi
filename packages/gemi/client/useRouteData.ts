import { useContext } from "react";
import { RouteStateContext } from "./RouteStateContext";

export function useRouteData() {
  const { data, i18n, prefetchedData, breadcrumbs } =
    useContext(RouteStateContext);

  return { data, i18n, prefetchedData, breadcrumbs };
}
