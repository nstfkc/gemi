import type { SqlDialect } from "../dialect";
import type { FieldSchema } from "../schema";
import { type Binder, type Fragment, param } from "./fragment";

/**
 * Binds a field's value, letting the dialect add a cast to the placeholder.
 *
 * Only `Json` on Postgres needs one today, and the reason is the whole of #209.
 * Bun serialises a JS value bound to a `jsonb` parameter, so an object arrives
 * correctly and a bare number arrives as `integer` and is rejected. Serialising
 * first does not help on its own — the string is then serialised again and the
 * column ends up holding the jsonb *string* `"42"`, which is the silent
 * mis-store the refusal existed to prevent. Measured against Postgres 16:
 *
 *   values ($1)                 42        integer vs jsonb
 *   values ($1::jsonb)          "42"      jsonb_typeof -> string
 *   values (to_jsonb($1))       {a:1}     could not determine polymorphic type
 *   values ($1::text::jsonb)    "42"      jsonb_typeof -> number
 *
 * The last is the only form that carries all six shapes, so it is the one the
 * dialect asks for.
 *
 * **A site that does not use this keeps today's behaviour**, which is the point
 * of putting the serialisation here rather than in `encode`. Moving it into
 * `encode` would serialise at every binding site whether or not that site
 * emitted the cast — and a site that serialises without casting is exactly the
 * mis-store above, arrived at silently. Here, a binding site nobody converted
 * still binds raw: objects work, a bare number is still refused, and the
 * failure stays loud.
 */
export function fieldParam(
  field: FieldSchema,
  dialect: SqlDialect,
  binder: Binder,
): Fragment {
  const cast = dialect.castParameter(field);
  if (!cast) return param(binder);

  return param((args, context) => {
    const value = binder(args, context);
    // `null` stays SQL NULL rather than becoming the JSON value `null`:
    // `JSON.stringify(null)` is `"null"`, and `'null'::jsonb` is a jsonb null,
    // which is a different thing from an absent value and would diverge from
    // Prisma on every nullable Json column.
    return value === null || value === undefined ? null : JSON.stringify(value);
  }, cast);
}
