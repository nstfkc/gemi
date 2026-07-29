import type { SqlDialect } from "./dialect";
import {
  InvalidArgumentError,
  UnsupportedQueryError,
} from "./errors";
import {
  type Fragment,
  bindValues,
  concat,
  joinFragments,
  param,
  render,
  sql as text,
} from "./compile/fragment";

/**
 * SQL fragments as first-class values: `sql`, `join`, `empty`, and one door out.
 *
 * The ORM deliberately does not implement every SQL shape — `distinct`, cursor
 * pagination, `groupBy`, window functions, recursive CTEs. That is the right
 * call, but it is only half a decision: the shapes it declines have to have
 * somewhere to go, and "drop to raw SQL" is not an answer if raw SQL cannot be
 * *composed*.
 *
 * `DB.sql` — Bun's tagged template — covers a single self-contained statement,
 * and that is genuinely all it covers. The shape it cannot express is the common
 * one: a predicate list built conditionally, passed around as a value, and
 * interpolated into a larger statement.
 *
 * ```ts
 * const filters = []
 * if (q) filters.push(sql`name ilike ${`%${q}%`}`)
 * if (organizationId) filters.push(sql`"organizationId" = ${organizationId}`)
 *
 * const where = filters.length ? sql`where ${join(filters, " and ")}` : empty
 * const rows = await DB.query(sql`select * from "Product" ${where} limit ${20}`)
 * ```
 *
 * ## This is the compiler's own `Fragment`, made public
 *
 * Not a parallel mechanism. `compile/fragment.ts` has held exactly this shape
 * since iteration 1 — text plus positional binders, composable, never
 * concatenating a value into the text — because that is what invariant 2 needs
 * internally. Reusing it means a public fragment binds by the same rule the
 * compiler's own SQL does, and it means the parameter ceiling, the placeholder
 * numbering and the dialect split are all already handled rather than
 * reimplemented one door down.
 *
 * **Placeholders are assigned at assembly, not at authoring.** SQLite writes
 * `?` and Postgres writes `$1`, `$2`, and a fragment does not know where in the
 * final statement it will land — so `sql` records a *position* and `render`
 * turns it into a placeholder once the whole statement exists. That is what lets
 * the same fragment be nested, reused twice in one statement, or built before
 * the dialect is even known.
 */

/**
 * A composable piece of SQL. Its values are bound parameters, never text.
 *
 * Opaque on purpose: an application builds one with `sql`, combines it with
 * `join`, and hands it to `DB.query` / `DB.execute`. Reading `.text` off it is
 * not part of the contract — it holds parameter *markers* rather than the
 * dialect's placeholders, so it is not the statement that runs.
 */
export type SqlFragment = Fragment;

/**
 * Every fragment this module has produced.
 *
 * **Identity, not shape, and the difference is a SQL injection.** `interpolate`
 * splices a fragment as text and binds everything else, so "is this a fragment"
 * decides whether a value reaches the statement or a parameter. Asking the
 * *shape* — a `text` string and a `binders` array — makes that decision
 * answerable by anything that can name two properties, and `{"text": "…",
 * "binders": []}` is two lines of JSON:
 *
 * ```ts
 * const body = await request.json()
 * await DB.query(sql`select "email" from "User" where "email" = ${body.email}`)
 * // body.email = { text: `'' union select "password" from "User"`, binders: [] }
 * // -> select "email" from "User" where "email" = '' union select "password" from "User"
 * ```
 *
 * That is the intended call site with the intended safe value, and it returned
 * the password column out of a statement selecting only `email`. The internal
 * `Fragment` never had the problem because nothing outside `compile/` could
 * construct one; making the type public is what turned "text plus binders" from
 * an implementation detail into a shape an attacker can name. `unsafeSql` is
 * built so that reaching for the escape hatch is a decision — a structural check
 * is a second, unmarked door beside it.
 *
 * A `WeakSet` the module owns cannot be forged: membership is granted only by
 * the constructors below. It registers the *returned* object rather than
 * stamping a property, because `concat` and `joinFragments` return fresh objects
 * — a marker property on the inputs would not survive them, and the version that
 * cannot drift is the one that brands what actually comes out.
 */
const FRAGMENTS = new WeakSet<object>();

function brand(fragment: Fragment): SqlFragment {
  FRAGMENTS.add(fragment);
  return fragment;
}

/** Whether a value is a fragment *this module made*, so it splices rather than binds. */
function isFragment(value: unknown): value is Fragment {
  return typeof value === "object" && value !== null && FRAGMENTS.has(value);
}

/**
 * A SQL fragment. Every `${value}` is bound as a parameter; a `${fragment}` is
 * spliced in, carrying its own parameters with it.
 *
 * ```ts
 * sql`where "id" = ${id}`                       // "id" = $1, with id bound
 * sql`where ${sql`"a" = ${1}`} and ${sql`"b" = ${2}`}`   // nests to any depth
 * ```
 *
 * An interpolated **array** is bound as one value, not expanded — that is what
 * Postgres's `= any($1)` wants, and it is the only reading that does not depend
 * on the dialect. For a comma-separated list of placeholders, say so with
 * `join`.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlFragment {
  // A defensive check rather than a type error, because the interesting misuse
  // is `sql(userInput)` — a plain call with a string, which would otherwise
  // reach `strings.raw` as `undefined` and produce a fragment of `undefined`
  // text rather than an error. It is also the shape somebody reaches for when
  // they want the escape hatch and have not found `unsafeSql`.
  if (!Array.isArray(strings) || !("raw" in (strings as object))) {
    throw new UnsupportedQueryError(
      "sql",
      "DB",
      "sql",
      `'sql' is a tagged template — write sql\`select 1\`, not sql("select 1"). ` +
        `To put text that is not a value into a statement, use 'unsafeSql', ` +
        `and read what it says first.`,
    );
  }

  const parts: Fragment[] = [];

  for (let i = 0; i < strings.length; i++) {
    parts.push(text(strings[i]));
    if (i < values.length) parts.push(interpolate(values[i]));
  }

  return brand(concat(...parts));
}

/**
 * Fragments — or values — joined by a separator, the way `Array.join` reads.
 *
 * ```ts
 * join(filters, " and ")            // a and b and c
 * join([sql`"a" asc`, sql`"b" desc`])   // "a" asc, "b" desc
 * join(ids)                         // $1, $2, $3 — each bound
 * ```
 *
 * An **empty list produces `empty`**, not a separator and not a syntax error, so
 * `join` composes with a list that turned out to have nothing in it. That is the
 * case a caller forgets, and it is the one that would otherwise emit `where ` and
 * fail at the database rather than here.
 *
 * ## The separator is text, so it is not a free string
 *
 * It goes between the fragments *in the statement*, which makes it the one other
 * place a string could reach the SQL — and this module's whole claim is that
 * `unsafeSql` is **the** door. So a plain-string separator has to be glue and
 * nothing else: whitespace, commas, or a boolean connective. Anything more
 * expressive is legitimate and has to say so:
 *
 * ```ts
 * join(filters, " and ")                 // fine
 * join(parts, unsafeSql(") and ("))      // fine, and visibly a decision
 * join(ids, request.query.sep)           // refused
 * ```
 *
 * A **blocklist would not do**, which is why this is an allowlist. The obvious
 * one — reject quotes, semicolons and comment markers — lets this through:
 *
 *     join([1, 2], ") or 1=1 union select password from Users where 1=(1")
 *
 * No quote, no `--`, still an injection. There is no sound way to say "this
 * arbitrary text is safe glue", so the rule is that glue is a small closed set
 * and everything else is a fragment somebody built on purpose.
 */
export function join(
  values: readonly unknown[],
  separator: string | SqlFragment = ", ",
): SqlFragment {
  if (!Array.isArray(values)) {
    throw new InvalidArgumentError(
      "join",
      "DB",
      "sql",
      `Expected an array of fragments or values, got ${typeof values}.`,
    );
  }
  if (values.length === 0) return empty;

  const parts = values.map(interpolate);

  if (isFragment(separator)) {
    const woven: Fragment[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) woven.push(separator);
      woven.push(parts[i]);
    }
    return brand(concat(...woven));
  }

  assertGlue(separator);
  return brand(joinFragments(parts, separator));
}

/**
 * Whitespace and commas, or a boolean connective surrounded by whitespace.
 *
 * Deliberately small. Every separator a composed statement actually needs is in
 * here — `", "`, `" and "`, `" or "`, `" "` — and everything outside it is
 * expressive enough to change what the statement *does*, which is the property
 * that makes it a `unsafeSql` decision rather than a string argument.
 */
const GLUE = /^[\s,]*$|^\s*(?:and|or)\s*$/i;

function assertGlue(separator: unknown): void {
  if (typeof separator === "string" && GLUE.test(separator)) return;

  throw new InvalidArgumentError(
    "join",
    "DB",
    "sql",
    typeof separator === "string"
      ? `A separator is written into the SQL text, so it may only be glue: ` +
        `whitespace, commas, or 'and' / 'or'. Got ` +
        `${JSON.stringify(separator)}. If that is deliberate, say so with ` +
        `unsafeSql(...) — and never build one from anything that came from ` +
        `outside the program.`
      : `Expected a separator string or a fragment, got ${
          separator === null ? "null" : typeof separator
        }.`,
  );
}

/**
 * The fragment that contributes nothing.
 *
 * The point of it is that `where ${empty}` and `where ${filter}` are the same
 * expression — a conditional predicate is a value, not a branch around the
 * statement. Frozen, because it is shared by every caller and a fragment is read
 * as immutable everywhere else.
 */
export const empty: SqlFragment = brand(
  Object.freeze({ text: "", binders: Object.freeze([]) as [] }),
);

/**
 * **Text straight into the SQL, with no parameter around it.** The one door in
 * this ORM through which a value reaches the statement text.
 *
 * Everything else in the compiler exists to make this impossible — identifiers
 * come from the generated schema, values are bound — so reaching for it should
 * feel like reaching for it. **Never give it a value that came from a request, a
 * form, a URL, a header, a queue payload or a database row.** There is no
 * escaping here and there will not be: escaping that is "usually right" is worse
 * than none, because it survives review.
 *
 * ## Why it exists at all, since that is the fair question
 *
 * Plan quality can depend on *not* parameterising. A partial index declared as
 *
 * ```sql
 * create index … on "Job" (…) where "name" is distinct from 'reaper'
 * ```
 *
 * is only usable if the planner can prove the query's predicate matches the
 * index's. A bound parameter is opaque at plan time, so `where "name" is
 * distinct from $1` does not match — and the query falls back to a sequential
 * scan over the whole table. The constant has to be *in the text*:
 *
 * ```ts
 * const REAPER = unsafeSql(`'reaper'`)   // a literal in this file, never input
 * await DB.query(sql`
 *   select … from "Job" where "name" is distinct from ${REAPER} …
 * `)
 * ```
 *
 * A builder with no escape hatch cannot express that at any price, and the
 * workaround — hand-writing the whole statement — loses composition for every
 * other part of it.
 *
 * The same applies to the other things that cannot be parameters in SQL:
 * identifiers, a sort direction, a table name chosen from a fixed set in code.
 * All of them share the rule above — the value is written in the source file, or
 * chosen from a set written in the source file, never passed in.
 */
export function unsafeSql(literal: string): SqlFragment {
  if (typeof literal !== "string") {
    throw new InvalidArgumentError(
      "unsafeSql",
      "DB",
      "sql",
      `Expected a string literal, got ${
        Array.isArray(literal) ? "an array" : typeof literal
      }. 'unsafeSql' is a plain call, not a tagged template — a template would ` +
        `interpolate values into the SQL text, which is the one thing it must ` +
        `never do.`,
    );
  }
  return brand(text(literal));
}

/**
 * A fragment as the statement a driver can run: the dialect's placeholders in
 * the text, and the values in the order they appear.
 *
 * Separate from the executing, and exported, because it is the half that is a
 * pure function of `(fragment, dialect)` — so a test can assert what a
 * composition emits on both dialects without a database anywhere near it, which
 * is exactly how the rest of the compiler is tested.
 *
 * `render` also applies the parameter ceiling here, which matters more for a
 * hand-built fragment than for a compiled plan: `join(ids)` over a
 * request-derived list is one placeholder per element on SQLite, and 40 000 of
 * them is a driver error rather than a clear one.
 */
export function renderFragment(
  fragment: SqlFragment,
  dialect: SqlDialect,
  operation = "query",
): { text: string; values: unknown[] } {
  if (!isFragment(fragment)) {
    throw new InvalidArgumentError(
      operation,
      "DB",
      operation,
      `Expected a fragment built with 'sql', got ${
        fragment === null ? "null" : typeof fragment
      }. A plain string is not accepted here on purpose — it would be the one ` +
        `path into the SQL text that nobody had to think about.`,
    );
  }

  const rendered = render(fragment, dialect, { model: "DB", operation });
  return {
    text: rendered.text,
    // `encodeUntyped` and not `encode`: there is no field here to ask, which is
    // the whole difference between a fragment's parameters and a compiled
    // plan's. It normalises the two JavaScript types whose SQL form the ORM has
    // already decided — a `Date` and a boolean — so a raw statement compares
    // against ORM-written rows on both dialects rather than only on Postgres.
    values: bindValues(rendered.binders)(undefined).map((value) =>
      value === null || value === undefined
        ? (value ?? null)
        : dialect.encodeUntyped(value),
    ),
  };
}

/**
 * One interpolated slot: a fragment splices, anything else binds.
 *
 * The binder ignores both its arguments. A compiled plan's binders read the
 * *call's* argument tree, because one plan serves many calls; a fragment is
 * built per call and closes over the value it was given, which is the whole
 * difference between the compiler's fragments and these.
 */
function interpolate(value: unknown): Fragment {
  if (isFragment(value)) return value;
  return param(() => value);
}
