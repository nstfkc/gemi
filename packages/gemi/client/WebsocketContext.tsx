import {
  createContext,
  type PropsWithChildren,
  useEffect,
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

  function getWS() {
    return new Promise<WebSocket>((resolve) => {
      if (wsRef.current) {
        resolve(wsRef.current);
      } else {
        const ws = new WebSocket("ws://localhost:5173/");
        ws.onopen = () => {
          wsRef.current = ws;
          ws.addEventListener("close", () => {
            wsRef.current = null;
          });
          resolve(ws);
        };
      }
    });
  }

  const subscribe = async (
    topic: string,
    handler: (event: MessageEvent<any>) => void,
  ) => {
    const ws = await getWS();
    ws.send(JSON.stringify({ type: "subscribe", topic }));
    ws.addEventListener("message", handler);
  };

  const unsubscribe = async (
    topic: string,
    handler: (event: MessageEvent<any>) => void,
  ) => {
    const ws = await getWS();
    ws.send(JSON.stringify({ type: "unsubscribe", topic }));
    ws.removeEventListener("message", handler);
  };

  const broadcast = async (topic: string, payload = {}) => {
    const ws = await getWS();
    ws.send(
      JSON.stringify({
        type: "broadcast",
        topic,
        payload,
      }),
    );
  };

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return (
    <WebSocketContext.Provider value={{ subscribe, unsubscribe, broadcast }}>
      {props.children}
    </WebSocketContext.Provider>
  );
};
