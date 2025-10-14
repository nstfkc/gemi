import { useContext } from "react";
import { ServerDataContext } from "./ServerDataProvider";
import { RouteStateContext } from "./RouteStateContext";

export function useAppIdMissmatch() {
  const { appId: next } = useContext(RouteStateContext);
  const { appId: current } = useContext(ServerDataContext);

  return current !== next;
}
