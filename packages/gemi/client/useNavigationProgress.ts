import { useContext, useEffect, useState } from "react";
import { ClientRouterContext } from "./ClientRouterContext";

export function useNavigationProgress() {
  const { progressManager } = useContext(ClientRouterContext);
  const [progress, setProgress] = useState(progressManager.state.getValue());

  useEffect(() => {
    const unsub = progressManager.state.subscribe((p) => setProgress(p));
    return () => {
      unsub();
    };
  }, []);

  return progress;
}
