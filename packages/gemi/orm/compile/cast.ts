import type { SqlDialect } from "../dialect";
import { jsonNullKind } from "../json-null";
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
    if (value === null || value === undefined) return null;

    // Prisma's sentinels, which serialise to `{}` if left to `JSON.stringify`.
    // `'null'::text::jsonb` is the JSON value; a bound `null` is SQL NULL.
    const kind = jsonNullKind(value);
    if (kind === "db") return null;
    if (kind === "json") return "null";
    // `AnyNull` is a question rather than a value — see `json-null.ts`. Every
    // path that could carry one has already answered it: the filter compiles it
    // to `is null or = 'null'`, and the write refuses it where the schema and
    // operation are in scope to say so. Reaching here means one of those was
    // missed, and the alternative to throwing is the `{}` mis-store of #259
    // arrived at a second way. Not an `InvalidArgumentError`: this reports an
    // ORM bug, not a caller's.
    if (kind === "any") {
      throw new Error(
        "gemi ORM bug: Prisma.AnyNull reached the parameter binder. It is a " +
          "filter operand only, and both the filter and write paths are " +
          "supposed to have handled it before this point.",
      );
    }

    return JSON.stringify(value);
  }, cast);
}
