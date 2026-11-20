import type { QueryResource } from "./QueryResource";
import type { QueryTarget, QueryUpdate } from "./useSetQueryData";
import { applyParams } from "../utils/applyParams";
import { toVariantKey } from "../utils/variantKey";

// The cache writes behind a mutation's `updates` and `useSetQueryData()`
// (#897), and invalidation by key (#1329). Loaded with the hooks' other extras when one mounts (see
// `./mutationModules`), so no route's entry chunk carries it (#915).

type Resolve = (key: string) => QueryResource;

/**
 * Write data the server just produced (a mutation's answer) into a variant,
 * with no refetch: unlike `mutate`, the value is not a guess to reconcile.
 * The variant counts as freshly fetched, so its `staleTime` starts again, and
 * a GET already on the wire for it is dropped when it lands, since it may
 * carry the data from before the write. A reader suspended on the variant
 * wakes up with it (#897). Here rather than on `QueryResource`, which every
 * entry chunk carries (#915).
 */
function setVariant(resource: QueryResource, variantKey: string, data: unknown) {
  resource.dropHttpCache(variantKey);
  resource.markApplied(variantKey);
  const store = resource.store.getValue();
  resource.fill(store, variantKey, data, Date.now());
  resource.store.next(store);
}

/** The value to write, or a function of the cached one. */
export type WriteQueryNext = { value: unknown } | { update: (current: any) => unknown };

/**
 * Write into every variant `target` names. `next` is the value to write, or
 * a function of the cached value; a function skips a variant with nothing
 * cached. A value seeds a single variant that is not cached yet; a predicate
 * only ever reaches variants that are.
 */
export function writeQueryData(
  getResource: Resolve,
  routeParams: Record<string, any>,
  target: QueryTarget<any>,
  next: WriteQueryNext,
) {
  const { path, params = {}, search = {} } = target;
  const resource = getResource(applyParams(String(path), { ...routeParams, ...params }));
  const write = (variantKey: string) => {
    if ("value" in next) {
      setVariant(resource, variantKey, next.value);
      return;
    }
    const state = resource.peek(variantKey);
    if (!state?.hasData) return;
    setVariant(resource, variantKey, next.update(state.data));
  };

  if (typeof search === "function") {
    for (const variantKey of resource.variantKeys()) {
      if (!resource.peek(variantKey)?.hasData) continue;
      if (search(new URLSearchParams(variantKey))) write(variantKey);
    }
    return;
  }
  write(toVariantKey(search));
}

/**
 * Write a mutation's `updates` with its answer.
 */
export function applyQueryUpdates(
  getResource: Resolve,
  routeParams: Record<string, any>,
  updates: ReadonlyArray<QueryUpdate<any>> | undefined,
  answer: unknown,
) {
  for (const update of updates ?? []) {
    const { data } = update as { data?: (answer: any, current: any) => any };
    writeQueryData(
      getResource,
      routeParams,
      update,
      data ? { update: (current) => data(answer, current) } : { value: answer },
    );
  }
}

/**
 * Invalidates every cached query a key matches: one a mounted reader is
 * rendering refetches now, any other is marked stale and revalidates when next
 * read. A key is a resolved path (`"/posts"`, every search variant of it), a
 * single variant (`"/posts?status=open"`), or a prefix ending in `*`
 * (`"/posts/*"`).
 */
export function invalidateQueries(
  resources: Iterable<QueryResource>,
  keys: ReadonlyArray<string>,
) {
  if (keys.length === 0) return;
  const all = [...resources];
  // Collected first, so a variant two keys match refetches once.
  const matched = new Map<QueryResource, Set<string>>();
  const add = (resource: QueryResource, variantKeys: string[]) => {
    const set = matched.get(resource) ?? new Set<string>();
    for (const variantKey of variantKeys) set.add(variantKey);
    matched.set(resource, set);
  };
  for (const key of keys) {
    const at = key.indexOf("?");
    const path = at === -1 ? key : key.slice(0, at);
    if (path.endsWith("*")) {
      const prefix = path.slice(0, -1);
      for (const resource of all) {
        if (resource.key.startsWith(prefix)) add(resource, resource.variantKeys());
      }
      continue;
    }
    for (const resource of all) {
      if (resource.key !== path) continue;
      add(resource, at === -1 ? resource.variantKeys() : [toVariantKey(key.slice(at + 1))]);
    }
  }
  for (const [resource, variantKeys] of matched) {
    for (const variantKey of variantKeys) resource.invalidate(variantKey);
  }
}
