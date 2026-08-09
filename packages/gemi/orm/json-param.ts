import {
  type Fragment,
  fromParamSegments,
  paramSegments,
} from "./compile/fragment";
import type { SqlDialect } from "./dialect";
import { InvalidArgumentError } from "./errors";
import { jsonNullKind } from "./json-null";

/**
 * A raw parameter the caller cast to `json`/`jsonb` carries **JSON text**.
 *
 * ## The statement that changes meaning between the two clients
 *
 * ```sql
 * update "AsyncJob" set payload = payload || $1::jsonb where id = $2
 * ```
 *
 * Byte-identical under Prisma's `$executeRaw` and under `DB.execute`, and it
 * did two different things. Measured on Postgres 16 through Bun 1.3.14 and a
 * generated `@prisma/client` 6.19.2, binding the JS string
 * `'{"version":1}'` into a `jsonb` column:
 *
 *   form                      prisma                       bun
 *   $1                        error: jsonb vs text         "{\"version\":1}"   (a jsonb string)
 *   $1::jsonb                 {"version": 1}               "{\"version\":1}"
 *   cast($1 as jsonb)         {"version": 1}               "{\"version\":1}"
 *   $1::text::jsonb           {"version": 1}               {"version": 1}
 *
 * The mechanism is the parameter's *type*, not the cast's. Prisma sends a JS
 * string as `text` and lets Postgres parse it into the target type; Bun asks
 * the server what the statement wants, is told `jsonb`, and JSON-encodes the
 * string it was handed — so the string becomes a jsonb **string** rather than
 * the object it spells. `::text::jsonb` pins the parameter back to `text`,
 * which is what Prisma did implicitly and what `compile/cast.ts` already emits
 * for a typed `Json` column (#209).
 *
 * **The `||` case is the sharp end.** Concatenating an object with a jsonb
 * *string* is array concatenation, not a merge:
 *
 *   payload || $1::jsonb        [{"attribution": …}, "{\"version\":1}"]
 *   payload || $1::text::jsonb  {"attribution": …, "version": 1}
 *
 * A statement written to merge metadata into a document appends the serialised
 * text as a new array element instead. The write succeeds, nothing raises, the
 * SQL reads correctly by eye, and the corruption is found by whatever reads the
 * column next.
 *
 * ## So the cast is read, and the parameter retyped
 *
 * A `::json`/`::jsonb` the caller wrote onto their own placeholder is the one
 * thing in a raw statement that says "this parameter is JSON" — there is no
 * field to ask, which is the whole difference between this and `fieldParam`.
 * When it is there, the placeholder is rewritten to cast through `text` and the
 * value is serialised to match, so the Prisma-shaped statement does the Prisma
 * thing.
 *
 * **Rewriting a caller's SQL text needs a reason, and this is it:** the cast is
 * preserved exactly — `::text::jsonb` and `::jsonb` denote the same type and
 * the expression's result is unchanged — while the *parameter's* type, which is
 * the thing that differs from Prisma and the thing no caller can otherwise
 * reach, is set to what Prisma set it to. The raw path was never
 * byte-preserving in any case: it is what turns a marker into `$1` or `?`.
 *
 * ## A string passes through, unlike the typed path — and Prisma agrees twice
 *
 * `fieldParam` serialises *every* value, so a `Json` column set to the JS string
 * `"42"` stores the jsonb string `"42"`. Here a string is handed over as it
 * arrived, so `${'{"a":1}'}::jsonb` stores the object. That is not an
 * inconsistency to be tidied away: it is which of the two Prisma does, on each
 * path, and both were measured against 6.19.2.
 *
 *   prisma.doc.create({ data: { payload: '{"version":1}' } })  -> jsonb string
 *   prisma.$executeRaw`… values (${'{"version":1}'}::jsonb)`   -> jsonb object
 *
 * The distinction that explains both: with a field, nobody wrote a cast and the
 * value is a JSON *value*; with a caller-written cast, the caller has said the
 * parameter is JSON *text* being cast. Somebody who wants the jsonb string
 * writes the serialisation they mean — `${JSON.stringify(v)}::jsonb`.
 *
 * ## What is left, and why the remainder is the right remainder
 *
 * A bare `$1` into a `jsonb` column is the same fault and is not detectable
 * here: no cast, no field, nothing to read. It is also the shape a Prisma port
 * cannot contain — Prisma *refuses* it (`column "payload" is of type jsonb but
 * expression is of type text`), so a statement that ran under Prisma with a
 * string operand had a cast on it. An object there works on both clients and is
 * untouched. `docs/orm.md` carries the residue; this covers what a port can
 * actually be carrying.
 *
 * Schema-qualified spellings (`$1::pg_catalog.jsonb`) and `jsonb[]` are
 * deliberately not matched. The first is not what anyone writes and the second
 * is a different operand — an array of documents, where serialising the JS
 * array to one JSON text would be wrong. Nor is a cast on an *expression
 * around* the placeholder: `(${v})::jsonb` and `cast(coalesce(${v}) as jsonb)`
 * read as an untyped parameter and still mis-store. Detection is textual, and
 * parsing parentheses to reach a spelling nobody writes buys less than it
 * costs; `docs/orm.md` says so where a reader looking for the covered set will
 * find it.
 *
 * ## Postgres only, and that is a dialect capability rather than a regex's luck
 *
 * The first version of this ran on both dialects, on the argument that `::` is
 * not SQLite syntax and SQLite has no `jsonb`, so nothing could match a
 * statement SQLite could run. **The first half of that is true and the second
 * is not.** SQLite's `CAST` accepts an arbitrary type name, so `cast(? as
 * json)` parses and runs there — and means something else entirely, since a
 * type name matching none of INT/CHAR/CLOB/TEXT/BLOB/REAL/FLOA/DOUB gets
 * NUMERIC affinity:
 *
 *   select cast(? as jsonb)                           -> 0
 *   select json_set('{"a":1}','$.b', cast(? as json))  -> {"a":1,"b":2}   (the cast
 *                                                        is what makes it the number
 *                                                        2 rather than the string)
 *   select cast(? as text)::json                       -> unrecognized token: ":"
 *
 * So the rewrite would have turned a working SQLite statement into a syntax
 * error. The gate is {@link SqlDialect.typesParametersFromStatement}, asked
 * rather than matched on `dialect.name`, because "cannot fire" was exactly the
 * kind of claim that should have been a capability someone can typecheck
 * instead of a property of two regular expressions.
 */

/**
 * `::jsonb` / `::json` applied to the placeholder that precedes it.
 *
 * Whitespace is allowed on both sides of the operator because Postgres allows
 * it and `$1 :: jsonb` mis-stores identically — measured, not assumed. The
 * lookahead keeps `::jsonb[]` out: that operand is an array of documents, and
 * the serialisation this triggers would flatten it into one.
 *
 * **`::text::jsonb` matches too**, and is then rewritten to itself. The cast is
 * already right there — it is the spelling this whole note recommends, and the
 * one a caller who has already been bitten will have written — but the *value*
 * still has to be serialised, or an object bound to it reaches Postgres as
 * `[object Object]`. Matching both spellings is what makes them mean the same
 * thing, which is the only defensible relationship between them.
 */
const OPERATOR_CAST = /^\s*::\s*(?:text\s*::\s*)?(jsonb|json)\b(?!\s*\[)/i;

/**
 * The same cast written as a function: `cast($1 as jsonb)`.
 *
 * **This is the branch that is reachable on SQLite, and the reason the whole
 * function is gated on a dialect capability rather than on the shape of these
 * two patterns.** `::` is Postgres-only *syntax* — SQLite's parser rejects it,
 * so `OPERATOR_CAST` genuinely cannot fire on a statement SQLite could run.
 * `cast(… as …)` is not: SQLite takes any type name there, `cast(? as json)`
 * parses and runs, and the rewrite this pairs with emits `as text)::json`,
 * which SQLite refuses. "SQLite has no jsonb type" is a claim about semantics;
 * what matters here is what the parser accepts. See
 * {@link SqlDialect.typesParametersFromStatement}.
 */
const FUNCTION_CAST = /^\s*as\s+(jsonb|json)\s*\)/i;

/**
 * ...which is only that when a `cast(` opened immediately before the
 * placeholder. Without this, `select ${x} as jsonb)` — nonsense, but nonsense
 * the caller wrote — would have its parameter serialised on the strength of two
 * keywords that mean nothing here.
 */
const CAST_OPEN = /\bcast\s*\(\s*$/i;

/** The answer on a dialect that is gated out, before any set is built. */
const EMPTY: ReadonlySet<number> = new Set<number>();

/**
 * The fragment with every JSON-cast parameter retyped through `text`, and the
 * positions of the parameters that were.
 *
 * Returns the fragment unchanged, and an empty set, when there is no such cast
 * — which is every statement in the compiler and nearly every raw one — and on
 * any dialect that does not type a parameter from the statement, which today is
 * SQLite. See the header: there the correction is unnecessary, the cast means
 * NUMERIC affinity rather than JSON, and the rewrite does not parse.
 */
export function retypeJsonParameters(
  fragment: Fragment,
  dialect: SqlDialect,
): {
  fragment: Fragment;
  jsonParameters: ReadonlySet<number>;
} {
  if (!dialect.typesParametersFromStatement) {
    return { fragment, jsonParameters: EMPTY };
  }

  const segments = paramSegments(fragment);
  const jsonParameters = new Set<number>();
  let rewritten: string[] | undefined;

  // `segments[i]` is the text before parameter `i` and `segments[i + 1]` the
  // text after it, so the last segment trails the final parameter and has no
  // parameter of its own.
  for (let index = 0; index < segments.length - 1; index++) {
    const after = segments[index + 1];

    const operator = OPERATOR_CAST.exec(after);
    if (operator) {
      rewritten ??= [...segments];
      rewritten[index + 1] =
        `::text::${operator[1]}${after.slice(operator[0].length)}`;
      jsonParameters.add(index);
      continue;
    }

    const fn = FUNCTION_CAST.exec(after);
    // The preceding segment is read from the rewrite when there is one: a
    // previous parameter's rewrite replaces the head of this segment and leaves
    // its tail — the `cast(` this is looking for — where it was, but reading the
    // live array is what keeps that a fact rather than an assumption.
    if (fn && CAST_OPEN.test((rewritten ?? segments)[index])) {
      rewritten ??= [...segments];
      rewritten[index + 1] = ` as text)::${fn[1]}${after.slice(fn[0].length)}`;
      jsonParameters.add(index);
    }
  }

  if (!rewritten) return { fragment, jsonParameters };
  return {
    fragment: fromParamSegments(rewritten, fragment.binders),
    jsonParameters,
  };
}

/**
 * The value for one such parameter: JSON text, or SQL NULL.
 *
 * `dialect.encodeUntyped` deliberately does not run on these. Its two
 * conversions are for a value being compared against a column the ORM wrote — a
 * `Date` as milliseconds, a boolean as `0`/`1` — and neither is JSON. A `Date`
 * here becomes the ISO string `JSON.stringify` gives it, because that is what
 * putting a `Date` in a JSON document means.
 */
export function jsonTextParameter(value: unknown, operation: string): unknown {
  // SQL NULL rather than the JSON value `null`, the same reading `fieldParam`
  // takes for a nullable `Json` column: an absent value is not a stored null.
  // Prisma binds a JS `null` at `$1::jsonb` to SQL NULL too — which follows
  // from the parameter being declared `text` (the `values ($1)` error text in
  // the table above is what shows that it is), since `NULL::text::jsonb` is SQL
  // NULL. Reasoned, not measured: it is the one row of that table nobody ran.
  if (value === null || value === undefined) return null;

  // Prisma's null sentinels, which `JSON.stringify` turns into `{}` — #259's
  // mis-store arrived at by a third route. `DbNull` is the column being NULL and
  // `JsonNull` is the JSON value, exactly as in `compile/cast.ts`.
  const nullKind = jsonNullKind(value);
  if (nullKind === "db") return null;
  if (nullKind === "json") return "null";
  if (nullKind === "any") {
    throw new InvalidArgumentError(
      operation,
      "DB",
      operation,
      `Prisma.AnyNull is a filter operand — it asks for a SQL NULL *or* a JSON ` +
        `null — so it has no single value to bind. Write the one you mean: ` +
        `Prisma.DbNull for the column being NULL, Prisma.JsonNull for the JSON ` +
        `value.`,
    );
  }

  // Already JSON text. See the header: at a cast the caller wrote, a string is
  // the document rather than a JSON string value, which is Prisma's reading of
  // the same parameter.
  if (typeof value === "string") return value;

  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    // A `bigint` and a circular structure are the two that get here. Prisma
    // fails on the first as well (`cannot cast type bigint to jsonb`), and this
    // says which parameter rather than which JSON.stringify.
    throw new InvalidArgumentError(
      operation,
      "DB",
      operation,
      `A parameter cast to json could not be serialised: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Bind text you have serialised yourself if the value is not JSON — a ` +
        `bigint has no JSON form, and neither does a cycle.`,
    );
  }

  // `undefined` back from `JSON.stringify` means the value has no JSON form at
  // all — a function, a symbol. Binding it would be SQL NULL, which is a
  // successfully-written wrong answer.
  if (text === undefined) {
    throw new InvalidArgumentError(
      operation,
      "DB",
      operation,
      `A ${typeof value} was bound to a parameter cast to json, and has no ` +
        `JSON form. Bind the value it stands for.`,
    );
  }

  return text;
}
