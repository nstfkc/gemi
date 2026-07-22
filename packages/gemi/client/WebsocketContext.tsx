import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

type Subscribe = (
  topic: string,
  handler: (event: any) => void,
) => Promise<void>;

export const WebSocketContext = createContext(
  {} as {
    broadcast: (topic: string, payload: Record<string, any>) => void;
    subscribe: Subscribe;
    unsubscribe: (
      topic: string,
      handler: (event: any) => void,
    ) => Promise<void>;
  },
);

export const WebSocketContextProvider = (props: PropsWithChildren) => {
  const wsRef = useRef<WebSocket>(null);

  const getWS = useCallback(() => {
    return new Promise<WebSocket>((resolve) => {
      if (wsRef.current) {
        resolve(wsRef.current);
      } else {
        const ws = new WebSocket("ws://localhost:5173/");
        ws.onopen = () => {
          wsRef.current = ws;
          console.log("ws opened");
          ws.addEventListener("close", () => {
            console.log("ws closed");
            wsRef.current = null;
          });
          resolve(ws);
        };
      }
    });
  }, []);

  const subscribe = useCallback(
    async (topic: string, handler: (event: MessageEvent<any>) => void) => {
      const ws = await getWS();
      ws.send(JSON.stringify({ type: "subscribe", topic }));
      ws.addEventListener("message", handler);
    },
    [getWS],
  );

  const unsubscribe = useCallback(
    async (topic: string, handler: (event: MessageEvent<any>) => void) => {
      const ws = await getWS();
      ws.send(JSON.stringify({ type: "unsubscribe", topic }));
      ws.removeEventListener("message", handler);
    },
    [getWS],
  );

  const broadcast = useCallback(
    async (topic: string, payload = {}) => {
      const ws = await getWS();
      ws.send(
        JSON.stringify({
          type: "broadcast",
          topic,
          payload,
        }),
      );
    },
    [getWS],
  );

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const value = useMemo(
    () => ({ subscribe, unsubscribe, broadcast }),
    [subscribe, unsubscribe, broadcast],
  );

  return (
    <WebSocketContext.Provider value={value}>
      {props.children}
    </WebSocketContext.Provider>
  );
};
