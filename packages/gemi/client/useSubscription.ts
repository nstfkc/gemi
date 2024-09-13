import { useCallback, useContext, useEffect, useMemo } from "react";
import { WebSocketContext } from "./WebsocketContext";
import { applyParams } from "../utils/applyParams";

export function useSubscription(
  route: string,
  options: { params: {}; cb: (data: any) => void },
) {
  const { cb, params } = options;
  const { subscribe, unsubscribe } = useContext(WebSocketContext);

  const topic = useMemo(
    () => applyParams(route, options.params),
    [route, params],
  );

  const handler = (event: MessageEvent<any>) => {
    const message = JSON.parse(event.data);
    if (topic === message.topic) {
      cb(message.data);
    }
  };

  useEffect(() => {
    subscribe(topic, handler);

    return () => {
      unsubscribe(topic, handler);
    };
  }, [topic]);
}
