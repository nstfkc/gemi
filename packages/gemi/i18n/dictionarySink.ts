import type { LocaleStrings } from "./dictionaryShape";

/**
 * Collects the dictionaries one SSR render actually read.
 *
 * Scoped per request by living in React context rather than in module state: a
 * streaming server has several renders in flight at once, so a module-level
 * collector would mix one page's dictionaries into another's payload. Context
 * is per render tree, which is exactly the boundary wanted, and it needs no
 * async-local storage to survive React's internal scheduling.
 *
 * Why stream these rather than put them in `__GEMI_DATA__`: that snapshot is
 * serialized before `renderToReadableStream` is even called, and which
 * dictionaries a page reads is only known once it has rendered. A suspended
 * segment reveals later still, long after the shell has flushed.
 *
 * The sink deliberately emits data, not markup — `streamQueryInjection` owns
 * script formatting and the `</script>`-safe encoding that goes with it.
 */
export interface DictionaryUse {
  id: string;
  locale: string;
  strings: LocaleStrings;
}

export interface DictionarySink {
  /** Called during render, the first time a dictionary is read. */
  use(id: string, locale: string, strings: LocaleStrings): void;
  /** The response injector subscribes to receive uses as they happen. */
  onUse(cb: (use: DictionaryUse) => void): void;
}

export function createDictionarySink(): DictionarySink {
  const seen = new Set<string>();
  const listeners: Array<(use: DictionaryUse) => void> = [];
  // Uses recorded before the injector subscribed — the render begins before the
  // response stream is wrapped.
  const pending: DictionaryUse[] = [];

  return {
    use(id, locale, strings) {
      const key = `${id} ${locale}`;
      if (seen.has(key)) return;
      seen.add(key);
      const entry: DictionaryUse = { id, locale, strings };
      if (listeners.length === 0) {
        pending.push(entry);
        return;
      }
      for (const listener of listeners) listener(entry);
    },
    onUse(cb) {
      listeners.push(cb);
      while (pending.length > 0) {
        cb(pending.shift()!);
      }
    },
  };
}
