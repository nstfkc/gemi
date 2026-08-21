/**
 * Value-level mirrors of the template-literal types that build RPC keys.
 *
 * The plugin has to arrive at exactly the same strings `CreateRPC` and
 * `CreateViewRPC` produce — a route the type system spells `/org/:orgId/products`
 * and the plugin spells `/org/:orgId/products/` is a route the plugin can never
 * be asked about, because the string the user typed came from the types.
 *
 * So each function here is a transcription of one conditional type in
 * `http/ApiRouter.ts` / `http/ViewRouter.ts` / `client/types.ts`, quirks
 * included: `removeGroupPrefix` strips one group and not all of them,
 * `parsePrefixAndKey` collapses one double slash and not all of them. Where the
 * behaviour looks wrong, it is wrong in the same direction as the types, which
 * is the only property that matters. `routePath.test.ts` pins the pairs, and
 * `http/ApiRouter.test-d.ts` pins the type side.
 */

/** Mirrors `RemoveDoubleSlash` in `client/types.ts` — recursive, unlike its callers. */
export function removeDoubleSlash(input: string): string {
  const at = input.indexOf("//");
  if (at === -1) return input;
  return removeDoubleSlash(`${input.slice(0, at)}/${input.slice(at + 2)}`);
}

/**
 * Mirrors `RemoveGroupPrefix` in `client/types.ts`.
 *
 * Strips the *first* `(group)` — a route folder that organises the tree without
 * appearing in the URL — and then collapses the double slash that removal
 * leaves behind. A second group in the same segment survives, exactly as it
 * does in the type.
 */
export function removeGroupPrefix(input: string): string {
  const open = input.indexOf("(");
  if (open === -1) return input;
  const close = input.indexOf(")", open + 1);
  if (close === -1) return input;
  return removeDoubleSlash(`${input.slice(0, open)}${input.slice(close + 1)}`);
}

/**
 * Mirrors `ParsePrefixAndKey`, which both routers declare identically: join a
 * parent prefix to a child key and normalise the seam.
 *
 * The `${infer T1}//${infer T2}` and `${infer T1}/${infer T2}/` patterns infer
 * the leftmost-shortest `T1`, so both branches split at the *first* slash that
 * satisfies the pattern — not the last, and not every one.
 */
export function parsePrefixAndKey(prefix: string, key: string): string {
  const joined = `${prefix}${key}`;
  if (joined === "//") return "/";

  const doubleSlash = joined.indexOf("//");
  if (doubleSlash !== -1) {
    return `${removeGroupPrefix(joined.slice(0, doubleSlash))}/${removeGroupPrefix(
      joined.slice(doubleSlash + 2),
    )}`;
  }

  if (joined.endsWith("/")) {
    // `${T1}/${T2}/` needs two distinct slashes, so a bare "health/" falls
    // through to the default branch keeping its trailing slash — as it does in
    // the type.
    const first = joined.indexOf("/");
    if (first !== -1 && first < joined.length - 1) {
      return `${removeGroupPrefix(joined.slice(0, first))}/${removeGroupPrefix(
        joined.slice(first + 1, -1),
      )}`;
    }
  }

  return removeGroupPrefix(joined);
}

/**
 * Mirrors `RemoveTrailingId` in `http/ApiRouter.ts` — drops the last `:param`
 * segment, which is how a resource's collection routes (`list`, `store`) get
 * their path from the same key the member routes (`show`, `update`, `delete`)
 * use.
 *
 * `"/:orgId/products/:productId"` → `"/:orgId/products"`. A key that is nothing
 * but an id segment empties out, which is not a reachable route — reproducing
 * that rather than "correcting" it to `"/"` keeps the plugin from claiming a
 * route the types never emitted.
 *
 * The type's `"X"` branch is transcribed for fidelity even though no input
 * reaches it: `Head` is everything before the first `/:`, so it cannot itself
 * begin with `/:`.
 */
export function removeTrailingId(input: string): string {
  const at = input.indexOf("/:");
  if (at === -1) return input;
  const head = input.slice(0, at);
  const tail = input.slice(at + 2);
  if (tail.includes("/:")) return `${head}/:${removeTrailingId(tail)}`;
  if (head.startsWith("/:")) return "X";
  return head;
}

/**
 * Mirrors the `RouteHandlers` branch of `RouteParser`, which — unlike every
 * other branch — concatenates raw instead of going through `ParsePrefixAndKey`.
 * A verb-map value therefore keeps any group parentheses in its prefix.
 */
export function joinHandlerMapKey(prefix: string, key: string): string {
  return `${prefix}${key === "/" ? "" : key}`;
}
