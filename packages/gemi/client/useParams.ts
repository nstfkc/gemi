import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";

export function useParams() {
  const { params = {} } = useContext(ClientRouterContext);
  return params;
}
