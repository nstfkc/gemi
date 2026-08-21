/**
 * What a route's `.middleware()` accepts.
 *
 * A bare string is allowed because it is what people write — `"auth"` reads
 * better than `["auth"]` for the overwhelmingly common single-middleware case,
 * and the array form was accepted silently wrong for long enough that the
 * starter template itself does it (`.middleware("cache:private")`).
 */
export type MiddlewareInput = string | string[];

/**
 * Normalizes `.middleware()`'s argument to the array the registry expects.
 *
 * Without this, a bare string was assigned straight to `middlewares`, and
 * `transformMiddleware` iterates its input — so a string was iterated one
 * **character** at a time. Each character became an alias lookup that resolved
 * to nothing and was dropped by the trailing `.filter(Boolean)`, which means the
 * middleware did not run and nothing anywhere said so. A route that looked
 * authenticated was public.
 *
 * The type said `string[]`, so this was a type error at every call site — but
 * only for a project whose `tsc` is clean, and the failure at runtime is silent
 * either way. Accepting both shapes removes the trap rather than documenting it.
 */
export function toMiddlewareList(input: MiddlewareInput): string[] {
  return typeof input === "string" ? [input] : input;
}
