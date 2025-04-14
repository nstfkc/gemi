import { useContext } from "react";
import { RouteStateContext } from "./RouteStateContext";

export function useLocation() {
  const ctx = useContext(RouteStateContext);
  if (!ctx) {
    throw new Error("Router context not found");
  }
  const { hash, pathname, search, state } = ctx;
  return {
    hash,
    key: pathname,
    pathname,
    search,
    state,
  };
}
