import { loadLazy, type LazyModule } from "./lazyModule";

/**
 * `./mutationExtras`, which a page only needs once it mutates: loaded when the
 * first mutation hook, or `useSetQueryData()`, mounts (#915), so no route's
 * entry chunk carries it. By the time a request settles it is normally there;
 * one that settles first waits for it.
 *
 * Keep this module out of `gemi/testing`'s imports. Shared with that entry, it
 * moves into the chunk both entries import, and there an app's bundler can
 * emit `./mutationExtras` even for an app that never mutates, which splits the
 * app's entry chunk ("needs no chunk besides the entry to start" in
 * `packaging.test.ts`).
 */
export const mutationExtras: LazyModule<typeof import("./mutationExtras")> = {
  current: null,
  load: () => import("./mutationExtras.js"),
};

/** Starts loading `./mutationExtras`: the hooks' mount effect. */
export function preloadMutationExtras() {
  loadLazy(mutationExtras).catch(() => {});
}
