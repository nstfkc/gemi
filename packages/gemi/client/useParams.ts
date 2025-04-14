import { useContext } from "react";
import { RouteStateContext } from "./RouteStateContext";

export function useParams() {
  const { params = {} } = useContext(RouteStateContext);
  return params;
}
