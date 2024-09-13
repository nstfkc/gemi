import { useContext } from "react";
import { WebSocketContext } from "./WebsocketContext";
import { applyParams } from "../utils/applyParams";

export function useBroadcast(
  path: string,
  options: { params: Record<string, string | number> },
) {
  const { params = {} } = options;
  const { broadcast } = useContext(WebSocketContext);

  const topic = applyParams(path, params);

  return (payload: Record<string, any>) => broadcast(topic, payload);
}
