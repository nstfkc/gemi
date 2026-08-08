/**
 * `take` / `skip` built from a request, so that a query string cannot produce a
 * value the compiler refuses.
 *
 * **This file is not `compile/paginate.ts`, and the two do opposite jobs.** That
 * one is the compiler's *validator*: `assertPageArgument` refuses a `take` or a
 * `skip` that is not an integer, and its note explains at length why refusing is
 * the only honest answer — a fraction is an opaque `SQLITE_MISMATCH` on one
 * dialect and a silent disagreement with both Prisma and the other dialect on
 * the second. Read that note (`compile/paginate.ts:9-63`) for the reasoning; it
 * is not restated here.
 *
 * This file is the other half, and the half that was missing. A refusal is only
 * useful if the correct spelling is available and short — otherwise the fix a
 * caller reaches for is `Math.floor` sprinkled at whichever call site happened
 * to throw, which fixes one of them. `paginate` is the shorter spelling:
 *
 *     const { take, skip } = paginate({
 *       page: req.search.get("page"),
 *       perPage: req.search.get("perPage"),
 *     })
 *     await Post.findMany({ take, skip, orderBy: { createdAt: "desc" } })
 *
 * against the shape gemi's own documentation used to teach, which breaks:
 *
 *     const limit = Number(req.search.get("limit")) || 25   // ?limit=1.5
 *
 * **Why the arguments are `unknown` and not `number`.** A query string is where
 * these values come from — that is the entire point of the helper, and typing
 * them as `number` would mean every caller writes the `Number(...)` that is the
 * bug. `req.search.get` hands back `string | string[]` (`http/HttpRequest.ts:211-223`
 * collects repeated keys into an array), a JSON body hands back whatever was
 * sent, and both arrive here unconverted.
 *
 * **The coercions, measured rather than assumed.** Each of these is a shape a
 * real query string produces, and each one is why the rules below are not simply
 * `Number(...)`:
 *
 *     Number("")           0          `?perPage=` — a form's blank field
 *     Number("  ")         0          the same, url-encoded
 *     Number(null)         0          an absent key read off a plain object
 *     Number(["2"])        2          a single repeated key
 *     Number(["1","2"])    NaN        two of them — so `Number` honours a
 *                                     repeated param sometimes and not others
 *     Number("1e400")      Infinity   not a number `Math.trunc` can fix
 *     Number(true)         1
 *
 * The `0`s are the dangerous ones. `page: 0` computes `skip: -25`, and
 * `assertPageArgument` refuses a negative `skip` outright — so a blank field in
 * a form is a 500. `perPage: 0` is worse, because it is *not* refused: `take: 0`
 * is a perfectly good integer and returns an empty page for ever.
 *
 * So an empty or blank string means **absent**, not zero, and anything that is
 * not a number or a string is absent too. Coercing a boolean or a one-element
 * array would be honouring input no HTTP surface can actually send, at the cost
 * of the rule being explainable.
 *
 * **Why `skip` is capped.** `?page=1e300` is finite, so it survives every check
 * above and multiplies out to a `skip` of `2.5e301`. Measured through Bun
 * against SQLite, binding an offset past int64:
 *
 *     offset 1e18                  ->  ok
 *     offset 9223372036854775807   ->  SQLiteError: datatype mismatch
 *     offset 1e20                  ->  SQLiteError: datatype mismatch
 *
 * — the same `SQLITE_MISMATCH` the fractional-`take` note records, reached from
 * the other end. The cap is `Number.MAX_SAFE_INTEGER` rather than int64's
 * ceiling: it is well inside what both drivers bind, it needs no per-dialect
 * measurement, and above it JavaScript's own arithmetic stops being exact, so a
 * number past it was never a page anybody could count to.
 *
 * **The guarantee, which is the whole contract:** every return value is a pair
 * of integers with `take >= 1` and `skip >= 0`, for every input. It is therefore
 * impossible for `paginate`'s output to be something `assertPageArgument`
 * refuses, and `page-args.test.ts` asserts exactly that by running the validator
 * over the output of a table of hostile query-string values rather than by
 * re-checking the arithmetic.
 */

/**
 * The default page size, and it is not an invented number: `docs/controllers.md`
 * and `docs/routing.md` both taught `Number(req.search.get("limit")) || 25`. The
 * helper replaces those examples, and picking a different default would silently
 * change the page size of every call site rewritten onto it.
 */
const DEFAULT_PER_PAGE = 25;

/**
 * The ceiling on a *request-supplied* page size. Its job is that `?perPage=100000`
 * cannot ask for the whole table — one request that reads a million rows into
 * memory is a denial of service the caller did not have to authenticate for.
 *
 * A hundred rather than "no ceiling at all", because a helper whose ceiling is
 * opt-in has no ceiling in the code that most needs one. An endpoint that
 * genuinely serves larger pages says so at the call site — `paginate(args,
 * { maxPerPage: 500 })` — which is one visible decision instead of an invisible
 * default.
 */
const DEFAULT_MAX_PER_PAGE = 100;

/**
 * See the cap discussion above. Exported so the test can assert the boundary
 * against the same constant the implementation clamps to, rather than repeating
 * the literal and agreeing with itself.
 */
export const MAX_SKIP = Number.MAX_SAFE_INTEGER;

/**
 * A query-string value as a whole number, or `null` for "absent".
 *
 * `null` rather than a default, so the two callers below can apply *their* own
 * default — the page defaults to 1 and the size defaults to `perPage`, and
 * folding that in here would mean one of them lying about which.
 */
function toWholeNumber(value: unknown): number | null {
  if (typeof value === "string") {
    // Measured above: `Number("")` is 0. `?perPage=` is what a browser sends
    // for a blank field, and reading it as zero rather than as absent is how a
    // cleared filter box becomes an empty page.
    if (value.trim() === "") return null;
  } else if (typeof value !== "number") {
    // Arrays, objects, booleans, `null`, `undefined`. Every one of them has a
    // `Number()` answer and not one of them has a *meaning* — see the table.
    return null;
  }

  const parsed = Number(value);
  // Catches `NaN` and both infinities in one test, which is what `Math.trunc`
  // cannot do: `Math.trunc(Infinity)` is `Infinity`, and `Number.isInteger`
  // then says false, so an untruncatable value would reach the compiler and be
  // refused there — by this helper, which exists so that cannot happen.
  if (!Number.isFinite(parsed)) return null;

  // Toward zero, which is what Prisma does with a fractional `take` (measured
  // in `compile/paginate.ts`). Matching it means a caller who moves off Prisma
  // keeps the same page, rather than trading a crash for a different answer.
  return Math.trunc(parsed);
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/**
 * Turn `{ page, perPage }` — as read off a query string, in whatever state the
 * client left them — into a `take` / `skip` pair the ORM accepts.
 *
 *     paginate({ page: "2" })                        { take: 25, skip: 25 }
 *     paginate({ page: "2.5" })                      { take: 25, skip: 25 }
 *     paginate({ page: "0" })                        { take: 25, skip: 0 }
 *     paginate({ page: "abc" })                      { take: 25, skip: 0 }
 *     paginate({ perPage: "1000" })                  { take: 100, skip: 0 }
 *     paginate({ perPage: "10" }, { maxPerPage: 5 }) { take: 5, skip: 0 }
 */
export function paginate(
  args: { page?: unknown; perPage?: unknown },
  options: {
    /** The page size when the request does not name one. Default 25. */
    perPage?: number;
    /** The largest page size a *request* may ask for. Default 100. */
    maxPerPage?: number;
  } = {},
): { take: number; skip: number } {
  // The options are code rather than user input, so it is tempting to trust
  // them. They are clamped anyway, because the guarantee this function makes is
  // unconditional — `paginate(args, { perPage: 0 })` returning `take: 0` would
  // be an empty page for ever, with the helper's own name on it.
  const maxPerPage = Math.max(1, toWholeNumber(options.maxPerPage) ?? DEFAULT_MAX_PER_PAGE);
  const fallback = clamp(
    toWholeNumber(options.perPage) ?? DEFAULT_PER_PAGE,
    1,
    maxPerPage,
  );

  const perPage = clamp(toWholeNumber(args?.perPage) ?? fallback, 1, maxPerPage);

  // Page 1 is the first page, and there is no page 0 — a `page` below 1 is
  // clamped up rather than refused, because the values that land there are
  // `""`, `"0"` and `"-1"`, and none of them is a request for a page that does
  // not exist. Refusing would put a 500 on a link somebody edited by hand.
  const page = Math.max(toWholeNumber(args?.page) ?? 1, 1);

  // Clamped after multiplying rather than by bounding `page` first: the product
  // is the thing that has to stay exact, and `page` alone cannot be bounded
  // without knowing `perPage` anyway.
  const skip = Math.min((page - 1) * perPage, MAX_SKIP);

  return { take: perPage, skip };
}
