import { buildTopic, topicMatches } from "../../services/broadcast/channels";
import type { DeniedCode } from "../../services/broadcast/protocol";
import {
  channelKey,
  type ChannelListener,
  type ChannelParamValues,
  type ChannelStatus,
  type RealtimeSocket,
} from "./RealtimeClient";

export interface FakeSubscription {
  pattern: string;
  params: ChannelParamValues;
  status: ChannelStatus;
  code: DeniedCode | null;
}

interface FakeEntry extends FakeSubscription {
  key: string;
  listeners: Set<ChannelListener>;
}

/**
 * A socket for component tests: what `<Page socket={...}>` hands the
 * channel hooks instead of a WebSocket. Every subscription is `open` at
 * once; the test pushes events and resyncs by hand.
 *
 * ```tsx
 * const socket = fakeSocket();
 * render(<Page socket={socket}><SiteEditor /></Page>);
 * act(() => socket.emit("site.:siteId", "changed", { pages: ["/about"] }));
 * act(() => socket.resync());
 * ```
 *
 * No resync is run on subscribe, unlike the real socket's ack: a test says
 * when one happens.
 */
export class FakeSocket implements RealtimeSocket {
  private entries = new Map<string, FakeEntry>();
  private status: ChannelStatus = "open";

  subscribe(pattern: string, params: ChannelParamValues, listener: ChannelListener): () => void {
    const key = channelKey(pattern, params);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        pattern,
        params: { ...params },
        status: this.status,
        code: null,
        listeners: new Set(),
      };
      this.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    listener.onStatus?.(entry.status, entry.code);
    return () => {
      entry!.listeners.delete(listener);
      if (entry!.listeners.size === 0) this.entries.delete(key);
    };
  }

  /** The channels subscribed to right now. */
  get subscriptions(): FakeSubscription[] {
    return Array.from(this.entries.values()).map(({ pattern, params, status, code }) => ({
      pattern,
      params,
      status,
      code,
    }));
  }

  /**
   * Delivers `event` to the open subscriptions `channel` names: a pattern
   * (`"site.:siteId"`, every subscription to it, or only those with `params`
   * when given), or a concrete topic (`"site.abc"`).
   */
  emit(channel: string, event: string, data?: unknown, params?: ChannelParamValues): void {
    for (const entry of this.matching(channel, params)) {
      if (entry.status !== "open") continue;
      for (const listener of Array.from(entry.listeners)) listener.onEvent?.(event, data);
    }
  }

  /** Runs every matching subscription's resync (all when `channel` is left out). */
  resync(channel?: string, params?: ChannelParamValues): void {
    for (const entry of channel ? this.matching(channel, params) : this.entries.values()) {
      if (entry.status !== "open") continue;
      for (const listener of Array.from(entry.listeners)) listener.onResync?.();
    }
  }

  /** Sets every subscription's status (and the status new ones start in). */
  setStatus(status: ChannelStatus): void {
    this.status = status;
    for (const entry of this.entries.values()) this.update(entry, status, null);
  }

  /** Refuses the matching subscriptions with `code`. */
  deny(channel: string, code: DeniedCode = "denied", params?: ChannelParamValues): void {
    for (const entry of this.matching(channel, params)) this.update(entry, "denied", code);
  }

  private update(entry: FakeEntry, status: ChannelStatus, code: DeniedCode | null) {
    entry.status = status;
    entry.code = code;
    for (const listener of Array.from(entry.listeners)) listener.onStatus?.(status, code);
  }

  private matching(channel: string, params?: ChannelParamValues): FakeEntry[] {
    return Array.from(this.entries.values()).filter((entry) => {
      if (entry.pattern === channel) {
        return !params || channelKey(channel, params) === entry.key;
      }
      try {
        const topic =
          Object.keys(entry.params).length > 0
            ? buildTopic(entry.pattern, entry.params)
            : entry.pattern;
        // `"user"` is resolved to `user.<id>` by the server; any id matches.
        return topic === channel || (entry.pattern === "user" && topicMatches("user", channel));
      } catch {
        return false;
      }
    });
  }
}

/** A `FakeSocket` for `<Page socket={...}>`. */
export function fakeSocket(): FakeSocket {
  return new FakeSocket();
}
