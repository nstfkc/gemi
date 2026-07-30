/**
 * How long a prefetched payload stays usable. Long enough to cover the gap
 * between hovering a link and clicking it, short enough that a navigation is
 * not served a snapshot the visitor would notice as out of date.
 *
 * A payload cached here is committed wholesale on navigation — including into
 * the query cache via `hydrate` — so anything that invalidates page data has to
 * `clear()` this too. `useMutation` does exactly that on every successful
 * write; locale needs no such call, since the locale segment is part of the key.
 */
export const PREFETCH_TTL = 10_000;

/**
 * Ceiling on retained payloads. Entries only leave on their own when a
 * navigation consumes them, and `viewport`/`render` on a long list warms links
 * that are mostly never clicked — each one a full page payload. Oldest goes
 * first, which is also the one closest to expiry.
 */
export const PREFETCH_MAX_ENTRIES = 12;

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

  private isFresh(entry: Entry) {
    return Date.now() - entry.createdAt < PREFETCH_TTL;
  }

  /** Drops what has expired, then the oldest of whatever is still over budget. */
  private evict() {
    for (const [url, entry] of this.entries) {
      if (!this.isFresh(entry)) {
        this.entries.delete(url);
      }
    }
    while (this.entries.size >= PREFETCH_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
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

    this.evict();

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

  /**
   * Drops everything, for when the data behind these payloads may have moved
   * on. In-flight loads still settle; their entries are simply gone by then.
   */
  clear() {
    this.entries.clear();
  }

  /** Retained entries, fresh or not. Exposed for tests. */
  get size() {
    return this.entries.size;
  }
}
