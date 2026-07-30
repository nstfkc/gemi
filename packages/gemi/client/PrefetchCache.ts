/**
 * How long a prefetched payload stays usable. Long enough to cover the gap
 * between hovering a link and clicking it, short enough that a link left on
 * screen doesn't hand a navigation minutes-old data.
 */
export const PREFETCH_TTL = 30_000;

interface Entry {
  promise: Promise<unknown>;
  createdAt: number;
}

/**
 * Payloads fetched ahead of a navigation, keyed by the `.json` URL that
 * navigation would request. Entries are handed over once — a navigation that
 * consumes one becomes the live route data, so keeping a copy around would only
 * let a later visit render from a stale snapshot.
 */
export class PrefetchCache {
  private entries = new Map<string, Entry>();
  private ttl: number;

  constructor(ttl: number = PREFETCH_TTL) {
    this.ttl = ttl;
  }

  private isFresh(entry: Entry) {
    return Date.now() - entry.createdAt < this.ttl;
  }

  /**
   * Runs `load` unless the same URL is already in flight or freshly cached, so
   * a link hovered repeatedly — or a screenful of eagerly prefetched links
   * pointing at one route — costs a single request.
   */
  prime(url: string, load: () => Promise<unknown>): Promise<unknown> {
    const existing = this.entries.get(url);
    if (existing && this.isFresh(existing)) {
      return existing.promise;
    }

    const entry: Entry = { createdAt: Date.now(), promise: null as never };
    entry.promise = load()
      .catch(() => null)
      .then((payload) => {
        // A failed prefetch is dropped rather than remembered: the navigation
        // falls back to its own request and the next hover gets to retry.
        if (payload == null && this.entries.get(url) === entry) {
          this.entries.delete(url);
        }
        return payload;
      });

    this.entries.set(url, entry);
    return entry.promise;
  }

  /**
   * Hands the payload for `url` to a navigation, if one was prefetched and is
   * still fresh. Resolves to `null` when the prefetch failed, which callers
   * must treat as a miss.
   */
  take(url: string): Promise<unknown> | null {
    const entry = this.entries.get(url);
    if (!entry) {
      return null;
    }
    this.entries.delete(url);
    return this.isFresh(entry) ? entry.promise : null;
  }
}
