import {
  BROADCAST_PROTOCOL,
  CloseCode,
  DEFAULT_SOCKET_PATH,
  isPermanentDenial,
  type ClientFrame,
  type DeniedCode,
  type ServerFrame,
} from "../../services/broadcast/protocol";

/**
 * Where a channel subscription stands, as the hooks report it.
 *
 * - `idle`: the hook is disabled (`enabled: false`).
 * - `connecting`: the socket is opening, or the `sub` awaits its answer.
 * - `open`: subscribed; events arrive.
 * - `denied`: the server refused (or revoked) it; `code` says why.
 * - `closed`: no socket, on the server, before the first effect, or while
 *   waiting to reconnect.
 */
export type ChannelStatus = "idle" | "connecting" | "open" | "denied" | "closed";

export type ChannelParamValues = Record<string, string | number>;

/** What a hook hands the socket for one channel. */
export interface ChannelListener {
  onEvent?(event: string, data: unknown): void;
  /** Events may have been missed: refetch what the channel describes. */
  onResync?(): void;
  onStatus?(status: ChannelStatus, code: DeniedCode | null): void;
}

/**
 * What the hooks subscribe through: the tab's `RealtimeClient`, or a
 * `FakeSocket` in tests. Returns the release function.
 */
export interface RealtimeSocket {
  subscribe(pattern: string, params: ChannelParamValues, listener: ChannelListener): () => void;
}

export interface RealtimeOptions {
  /** The socket endpoint, `defineBroadcastConfig({ path })`. Default `/__gemi/socket`. */
  path?: string;
  /**
   * How long a hidden tab keeps its socket, in ms, before disconnecting. On
   * becoming visible again it reconnects and resyncs. Default 60 000.
   */
  hiddenDisconnectMs?: number;
}

interface ClientInternals {
  /** Test seam: the WebSocket class. */
  WebSocket?: typeof WebSocket;
  /** Test seam: the full URL, instead of the page's origin + `path`. */
  url?: string;
  random?: () => number;
}

/** The minimum gap between two resyncs of one subscription. */
export const RESYNC_COALESCE_MS = 2_000;
/** How long the socket stays open after its last subscription goes. */
export const IDLE_CLOSE_MS = 5_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_HIDDEN_DISCONNECT_MS = 60_000;

interface Entry {
  key: string;
  id: string;
  pattern: string;
  params: ChannelParamValues;
  listeners: Set<ChannelListener>;
  status: ChannelStatus;
  code: DeniedCode | null;
  /** Refused for good: not resent on a reconnect. */
  permanent: boolean;
  topic: string | null;
  lastResyncAt: number;
  resyncTimer: ReturnType<typeof setTimeout> | null;
}

/** `pattern` and its params, canonical: two hooks on one channel share a `sub`. */
export function channelKey(pattern: string, params: ChannelParamValues): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => [key, String(params[key])]);
  return `${pattern}\u0000${JSON.stringify(sorted)}`;
}

/**
 * The tab's one WebSocket to the app (`gemi.v1`), multiplexing every channel
 * the mounted hooks subscribe to.
 *
 * Opened by the first subscription and closed a few seconds after the last
 * one goes. Reconnects with full-jitter backoff (1 to 30 s), or after the
 * server's `bye.retryAfter`, at once on `online`; resubscribes everything
 * then. A tab hidden for `hiddenDisconnectMs` disconnects, and reconnects
 * when shown. Every `subscribed` ack and every `gap` resyncs the
 * subscription (coalesced to one per 2 s), because events are volatile: a
 * client that may have missed one refetches over HTTP.
 */
export class RealtimeClient implements RealtimeSocket {
  private options: Required<RealtimeOptions>;
  private readonly internals: ClientInternals;
  private ws: WebSocket | null = null;
  private entries = new Map<string, Entry>();
  private byId = new Map<string, Entry>();
  private topics = new Map<string, Set<string>>();
  private nextId = 1;
  private attempt = 0;
  private tag: string | null = null;
  private socketIdValue: string | null = null;
  private heartbeatMs = DEFAULT_HEARTBEAT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAfter: number | null = null;
  private revoked = false;
  private pausedWhileHidden = false;
  private listening = false;

  constructor(options: RealtimeOptions = {}, internals: ClientInternals = {}) {
    this.options = withDefaults(options);
    this.internals = internals;
  }

  configure(options: RealtimeOptions) {
    this.options = withDefaults({ ...this.options, ...options });
  }

  /** The id to send as `X-Gemi-Socket`, while the socket is open. */
  get socketId(): string | null {
    return this.socketIdValue;
  }

  subscribe(pattern: string, params: ChannelParamValues, listener: ChannelListener): () => void {
    const key = channelKey(pattern, params);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        id: String(this.nextId++),
        pattern,
        params: { ...params },
        listeners: new Set(),
        status: "closed",
        code: null,
        permanent: false,
        topic: null,
        lastResyncAt: 0,
        resyncTimer: null,
      };
      this.entries.set(key, entry);
      this.byId.set(entry.id, entry);
      if (this.isOpen()) {
        this.sendSub(entry);
      }
    }
    entry.listeners.add(listener);
    listener.onStatus?.(entry.status, entry.code);
    this.cancelIdleClose();
    this.listen();
    if (!this.ws && !this.reconnectTimer && !this.pausedWhileHidden) {
      this.connect();
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(entry!, listener);
    };
  }

  private release(entry: Entry, listener: ChannelListener) {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    if (entry.resyncTimer) clearTimeout(entry.resyncTimer);
    this.entries.delete(entry.key);
    this.byId.delete(entry.id);
    this.dropTopic(entry);
    if (this.isOpen() && (entry.status === "open" || entry.status === "connecting")) {
      this.send({ op: "unsub", id: entry.id });
    }
    if (this.entries.size === 0) this.scheduleIdleClose();
  }

  private isOpen() {
    return this.ws !== null && this.ws.readyState === 1;
  }

  private connect() {
    if (typeof window === "undefined") return;
    if (this.entries.size === 0) return;
    const Impl = this.internals.WebSocket ?? globalThis.WebSocket;
    if (!Impl) return;
    this.clearReconnect();
    let ws: WebSocket;
    try {
    ws = new Impl(this.url(), [BROADCAST_PROTOCOL]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    for (const entry of this.entries.values()) {
      if (!entry.permanent) this.setStatus(entry, "connecting", null);
    }
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.touch();
      for (const entry of this.entries.values()) {
        if (!entry.permanent) this.sendSub(entry);
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      this.touch();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handle(frame);
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.onClosed(event.code);
    };
    ws.onerror = () => {
      // A `close` follows.
    };
  }

  private url(): string {
    if (this.internals.url) return this.internals.url;
    const { protocol, host } = window.location;
    return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${this.options.path}`;
  }

  private sendSub(entry: Entry) {
    this.setStatus(entry, "connecting", null);
    const frame: ClientFrame = { op: "sub", id: entry.id, ch: entry.pattern };
    if (Object.keys(entry.params).length > 0) frame.p = entry.params;
    this.send(frame);
  }

  private send(frame: ClientFrame) {
    if (!this.isOpen()) return;
    try {
      this.ws!.send(JSON.stringify(frame));
    } catch {
      // The close handler takes over.
    }
  }

  private handle(frame: ServerFrame) {
    switch (frame.op) {
      case "hello":
        this.socketIdValue = frame.socketId;
        this.tag = frame.tag;
        this.attempt = 0;
        this.revoked = false;
        if (frame.heartbeatMs > 0) {
          this.heartbeatMs = frame.heartbeatMs;
        }
        this.startHeartbeat();
        return;
      case "subscribed": {
        const entry = this.byId.get(frame.id);
        if (!entry) return;
        this.dropTopic(entry);
        entry.topic = frame.t;
        let ids = this.topics.get(frame.t);
        if (!ids) this.topics.set(frame.t, (ids = new Set()));
        ids.add(entry.id);
        this.setStatus(entry, "open", null);
        // The window between the view rendering and this ack, or the time
        // the socket was down, may have carried events this tab missed.
        this.resync(entry);
        return;
      }
      case "denied": {
        const entry = this.byId.get(frame.id);
        if (!entry) return;
        this.dropTopic(entry);
        entry.permanent = isPermanentDenial(frame.code);
        this.setStatus(entry, "denied", frame.code);
        return;
      }
      case "ev": {
        if (frame.x !== undefined && frame.x === this.tag) return;
        const ids = this.topics.get(frame.t);
        if (!ids) return;
        for (const id of Array.from(ids)) {
          const entry = this.byId.get(id);
          if (!entry) continue;
          for (const listener of Array.from(entry.listeners)) {
            try {
              listener.onEvent?.(frame.ev, frame.d);
            } catch (error) {
              reportListenerError(error);
            }
          }
        }
        return;
      }
      case "gap":
        for (const entry of this.entries.values()) {
          if (entry.status === "open") this.resync(entry);
        }
        return;
      case "bye":
        this.retryAfter = Math.max(0, Number(frame.retryAfter) || 0);
        return;
      case "pong":
        return;
    }
  }

  private onClosed(code: number) {
    this.ws = null;
    this.socketIdValue = null;
    this.tag = null;
    this.stopHeartbeat();
    this.topics.clear();
    for (const entry of this.entries.values()) {
      entry.topic = null;
      if (!entry.permanent) this.setStatus(entry, "closed", null);
    }
    if (code === CloseCode.Revoked) this.revoked = true;
    if (this.entries.size > 0 && !this.pausedWhileHidden) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    this.clearReconnect();
    let delay: number;
    if (this.retryAfter !== null) {
      delay = this.retryAfter;
      this.retryAfter = null;
    } else if (this.revoked) {
      // Signed out or access revoked: come back promptly, as whoever we are now.
      this.revoked = false;
      delay = Math.floor(this.random() * 500);
    } else {
      delay = backoffDelay(this.attempt, this.random());
    }
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private random() {
    return (this.internals.random ?? Math.random)();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.send({ op: "ping" }), this.heartbeatMs);
    this.touch();
  }

  private stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.pingTimer = null;
    this.livenessTimer = null;
  }

  /** Anything from the server proves the socket alive. */
  private touch() {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    const ws = this.ws;
    this.livenessTimer = setTimeout(() => {
      if (this.ws !== ws || !ws) return;
      // Silent for two heartbeats: a dead connection a proxy never closed.
      try {
        ws.close();
      } catch {}
      this.onClosed(1006);
    }, this.heartbeatMs * 2);
  }

  private setStatus(entry: Entry, status: ChannelStatus, code: DeniedCode | null) {
    if (entry.status === status && entry.code === code) return;
    entry.status = status;
    entry.code = code;
    for (const listener of Array.from(entry.listeners)) {
      try {
        listener.onStatus?.(status, code);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  /** At most one resync per subscription per 2 s; a later one is deferred, not dropped. */
  private resync(entry: Entry) {
    if (entry.resyncTimer) return;
    const now = Date.now();
    const wait = entry.lastResyncAt + RESYNC_COALESCE_MS - now;
    const fire = () => {
      entry.resyncTimer = null;
      entry.lastResyncAt = Date.now();
      for (const listener of Array.from(entry.listeners)) {
        try {
          listener.onResync?.();
        } catch (error) {
          reportListenerError(error);
        }
      }
    };
    if (entry.lastResyncAt === 0 || wait <= 0) fire();
    else entry.resyncTimer = setTimeout(fire, wait);
  }

  private dropTopic(entry: Entry) {
    if (!entry.topic) return;
    const ids = this.topics.get(entry.topic);
    ids?.delete(entry.id);
    if (ids && ids.size === 0) this.topics.delete(entry.topic);
    entry.topic = null;
  }

  private scheduleIdleClose() {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.entries.size > 0) return;
      this.clearReconnect();
      this.close();
    }, IDLE_CLOSE_MS);
  }

  private cancelIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Closes the socket without reconnecting. */
  private close() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    try {
      ws.close(CloseCode.Normal);
    } catch {}
    this.onClosed(CloseCode.Normal);
  }

  private listen() {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("online", this.onOnline);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  private onOnline = () => {
    if (this.entries.size === 0 || this.ws || this.pausedWhileHidden) return;
    this.attempt = 0;
    this.connect();
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (this.hiddenTimer) return;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        if (document.visibilityState !== "hidden") return;
        this.pausedWhileHidden = true;
        this.clearReconnect();
        this.close();
      }, this.options.hiddenDisconnectMs);
      return;
    }
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.pausedWhileHidden) {
      this.pausedWhileHidden = false;
      this.attempt = 0;
      // The `subscribed` acks resync every subscription.
      this.connect();
    }
  };

  /** For tests: drops the socket, timers and listeners. */
  dispose() {
    this.clearReconnect();
    this.cancelIdleClose();
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    for (const entry of this.entries.values()) {
      if (entry.resyncTimer) clearTimeout(entry.resyncTimer);
    }
    this.entries.clear();
    this.byId.clear();
    this.close();
    if (this.listening && typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      document?.removeEventListener("visibilitychange", this.onVisibility);
      this.listening = false;
    }
  }
}

/** Full jitter, 1 to 30 s: `max(1 s, random × min(30 s, 1 s × 2^attempt))`. */
export function backoffDelay(attempt: number, random: number): number {
  const cap = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(attempt, 10));
  return Math.max(MIN_BACKOFF_MS, Math.floor(random * cap));
}

function withDefaults(options: RealtimeOptions): Required<RealtimeOptions> {
  return {
    path: options.path ?? DEFAULT_SOCKET_PATH,
    hiddenDisconnectMs: options.hiddenDisconnectMs ?? DEFAULT_HIDDEN_DISCONNECT_MS,
  };
}

function reportListenerError(error: unknown) {
  setTimeout(() => {
    throw error;
  });
}

let configured: RealtimeOptions = {};
let instance: RealtimeClient | null = null;

/**
 * Sets the socket options (`init({ realtime })` calls it). Takes effect on
 * the next connection.
 */
export function configureRealtime(options: RealtimeOptions = {}) {
  configured = { ...configured, ...options };
  instance?.configure(configured);
}

/** The tab's client, created on first use. `null` on the server. */
export function getRealtimeClient(): RealtimeClient | null {
  if (typeof window === "undefined") return null;
  instance ??= new RealtimeClient(configured);
  return instance;
}

/**
 * The open socket's id, for the `X-Gemi-Socket` header, or `null`. Never
 * creates the client.
 */
export function currentSocketId(): string | null {
  return instance?.socketId ?? null;
}
