import { omitNullishValues } from "./omitNullishValues";

/**
 * The key one search-param combination is cached under, inside a query's
 * resource: the params sorted and serialized, empty when there are none.
 *
 * Sorted because `?b=2&a=1` and `?a=1&b=2` are the same request, and a cache
 * that keyed them separately would fetch twice and hydrate one of them from a
 * payload the server produced for the other. Nullish values are dropped for
 * the same reason: an optional filter left `undefined` is absent, not the
 * string `"undefined"`.
 *
 * Every site that reads or writes the cache derives its key from here —
 * `useQuery` (the read), `useMutate` (the write), and `gemi/testing`'s `<Page>`
 * (the seed). They used to hold a copy each, which is the kind of duplication
 * that fails quietly: a seed built by an old copy simply misses, and the test
 * that should have read it fetches over the network and asserts an empty state
 * with nothing pointing at the mismatch.
 */
export function toVariantKey(
  search: string | Record<string, unknown> | null | undefined,
): string {
  const searchParams = new URLSearchParams(
    typeof search === "string"
      ? search
      : (omitNullishValues(search ?? {}) as Record<string, string>),
  );
  searchParams.sort();
  return searchParams.toString();
}
