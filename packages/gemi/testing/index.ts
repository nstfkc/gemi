export { Page } from "./Page";
export type { PageProps, PageDictionary } from "./Page";

/**
 * The recorder `Event.fake()` installs, published here as a **type only**.
 *
 * There is nothing to construct — `Event.fake()` (from `gemi/services`) is what
 * makes one, and it is on `Event` so that the door a test reaches for is the
 * same class it is asserting about. This export exists for the signature: a
 * helper that takes or returns the recorder needs to be able to name it.
 *
 * Why not the class itself. This entrypoint is bundled for the **browser** —
 * `vite.client.config.mts` builds `client/index.ts` and `testing/index.ts`
 * together so a `<Page>` and the components under it share one copy of every
 * React context. A runtime export from here would drag `EventManager` into that
 * bundle, and behind it `node:async_hooks`, the container and Bun's `SQL`. The
 * same reasoning is on `PageDictionary`, which is typed structurally rather
 * than imported from `gemi/i18n` to keep a server entry out of a component
 * test's module graph.
 */
export type { FakeEventManager } from "../services/events/FakeEventManager";
