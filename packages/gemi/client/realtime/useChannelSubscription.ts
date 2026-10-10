import { useContext, useEffect, useRef, useState } from "react";
import type { DeniedCode } from "../../services/broadcast/protocol";
import {
  channelKey,
  getRealtimeClient,
  type ChannelParamValues,
  type ChannelStatus,
} from "./RealtimeClient";
import { RealtimeContext } from "./RealtimeContext";

export interface ChannelState {
  status: ChannelStatus;
  /** Why the subscription was refused, while `status` is `denied`. */
  code: DeniedCode | null;
}

export interface ChannelHandlers {
  onEvent?: (event: string, data: unknown) => void;
  onResync?: () => void;
}

const CLOSED: ChannelState = { status: "closed", code: null };
const IDLE: ChannelState = { status: "idle", code: null };

/**
 * The one subscription primitive the channel hooks share. Subscribes only in
 * an effect, so a server render, a static page or an island that never
 * mounts opens no socket; on the server it reports `closed`. Handlers may
 * change between renders without resubscribing.
 */
export function useChannelSubscription(
  pattern: string | null,
  params: ChannelParamValues,
  handlers: ChannelHandlers,
  enabled: boolean,
): ChannelState {
  const active = enabled && pattern !== null;
  const [state, setState] = useState<ChannelState>(active ? CLOSED : IDLE);
  const provided = useContext(RealtimeContext);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const key = pattern === null ? null : channelKey(pattern, params);

  useEffect(() => {
    if (!active || pattern === null) {
      setState(IDLE);
      return;
    }
    const socket = provided ?? getRealtimeClient();
    if (!socket) return;
    const release = socket.subscribe(pattern, paramsRef.current, {
      onEvent: (event, data) => handlersRef.current.onEvent?.(event, data),
      onResync: () => handlersRef.current.onResync?.(),
      onStatus: (status, code) =>
        setState((previous) =>
          previous.status === status && previous.code === code ? previous : { status, code },
        ),
    });
    return () => {
      release();
      setState(CLOSED);
    };
    // `key` stands for `pattern` and `params`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provided, key, active]);

  if (typeof window === "undefined") return active ? CLOSED : IDLE;
  return state;
}

/**
 * How long an event-driven refetch waits for the events behind it: a burst
 * (a progress tick per second, a bulk update) refetches once per window, not
 * once per event. The window starts at the first event and is never pushed
 * back, so a steady stream still refetches every `EVENT_COALESCE_MS`.
 */
export const EVENT_COALESCE_MS = 150;

/**
 * `fn`, run at most once per `ms`: the first call starts the window, and the
 * calls inside it fold into the one run at its end. Stable across renders;
 * a pending run is dropped on unmount.
 */
export function useCoalesced(fn: () => void, ms: number = EVENT_COALESCE_MS): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  const coalesced = useRef<() => void>(null as unknown as () => void);
  coalesced.current ??= () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, ms);
  };
  return coalesced.current;
}
