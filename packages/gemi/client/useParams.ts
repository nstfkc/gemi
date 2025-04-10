import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import { RouteStateContext } from "./RouteStateContext";

export function useParams() {
  const { params = {} } = useContext(RouteStateContext);
  return params;
}
