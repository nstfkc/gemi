import type { SqlDialect } from "../dialect";
import { ParameterLimitError } from "../errors";

/**
 * Pulls one value out of the argument tree at bind time. Compilation closes
 * over the *path* to a value, never the value itself — that is what makes two
 * calls with the same argument shape and different values produce byte
 * identical SQL, and it is what the plan cache depends on.
 *
 * Writes add a second source: values that do not exist in the argument tree at
 * all. A `@default(cuid())` is minted per call, `@default(now())` has to be the
 * *same* instant across every field and row of one logical operation, and a
 * nested `create` produces a foreign key only once its own insert has run. All
 * three arrive through the context rather than through `args`, so the binder
 * stays a pure function of (arguments, call) and compilation stays pure.
 */
export type Binder = (args: any, context: BindContext) => unknown;

/**
 * Per-call state a binder may read. Created once per `$exec`, never cached with
 * the plan — a plan outlives the call, and `now` must not.
 */
export interface BindContext {
  /**
   * One instant for the whole operation. Prisma returns `createdAt` and
   * `updatedAt` from a single `create` as the same instant (verified against
   * 6.19.2), which reading the clock per field would not reproduce.
   */
  now: Date;
  /**
   * Values produced before the main statement runs, keyed by field name. Today
   * that is exactly the foreign keys a nested `connect` or `create` resolved.
   */
  resolved: Record<string, unknown>;
}

export function createBindContext(): BindContext {
  return { now: new Date(), resolved: {} };
}

/**
 * The default context for a read. Reads never consult it, but `bind` takes one
 * argument on every path so the choke point does not have to branch.
 */
const READ_CONTEXT: BindContext = { now: new Date(0), resolved: {} };

/** Turns a compiled binder list into a plan's `bind`. */
export function bindValues(
  binders: Binder[],
): (args: any, context?: BindContext) => unknown[] {
  return (args: any, context: BindContext = READ_CONTEXT) => {
    const values: unknown[] = [];
    for (let i = 0; i < binders.length; i++) {
      values.push(binders[i](args, context));
    }
    return values;
  };
}

/**
 * Marks a parameter position inside a fragment's text. Placeholders are only
 * rendered once the whole statement is assembled, because Postgres numbers them
 * (`$1`, `$2`) and the number is not knowable until a fragment's position in
 * the final statement is fixed. A sentinel rather than a shared mutable counter
 * is what lets fragments compose in any order without corrupting parameter
 * ordering.
 *
 * NUL cannot appear in an identifier from the schema and never appears in the
 * keywords the compiler emits, so it cannot collide with real text.
 */
const PARAM_MARKER = "\u0000";

export interface Fragment {
  text: string;
  binders: Binder[];
}

/** A fragment with no parameters: keywords, quoted identifiers, punctuation. */
export function sql(text: string): Fragment {
  return { text, binders: [] };
}

/**
 * A single parameter position, bound from the argument tree at call time.
 *
 * `cast` is SQL appended immediately after the placeholder — `$1::text::jsonb`.
 * It rides as ordinary text rather than as a parallel array because the marker
 * is replaced in place at render, so text following it needs no bookkeeping and
 * cannot fall out of step with the binders.
 *
 * Only a dialect may supply one, and only from a constant: it is the one string
 * here that reaches the statement without being a parameter. See
 * `castParameter`.
 */
export function param(binder: Binder, cast = ""): Fragment {
  return { text: PARAM_MARKER + cast, binders: [binder] };
}

/**
 * A fragment's text cut at every parameter: `segments[i]` is the text that
 * precedes parameter `i`, and `segments[i + 1]` the text that follows it. The
 * inverse is `fromParamSegments`.
 *
 * It exists so that one caller — `renderFragment` — can read *what the author
 * wrote next to a parameter* before placeholders are assigned. A `::jsonb` a
 * caller wrote onto their own placeholder is the only thing that says a raw
 * parameter is JSON, and it is only readable here, in the marker's own
 * coordinates; after `render` the text holds `$1` and the segment boundaries
 * are gone.
 *
 * Nothing in the compiler uses this. A plan's casts come from the dialect and
 * are already correct, and re-deriving them from text would be a second,
 * weaker source for something the schema already answers.
 */
export function paramSegments(fragment: Fragment): string[] {
  return fragment.text.split(PARAM_MARKER);
}

/** `paramSegments` reversed: the segments woven back around the markers. */
export function fromParamSegments(
  segments: readonly string[],
  binders: Binder[],
): Fragment {
  return { text: segments.join(PARAM_MARKER), binders };
}

export function concat(...parts: Fragment[]): Fragment {
  return joinFragments(parts, "");
}

export function joinFragments(parts: Fragment[], separator: string): Fragment {
  let text = "";
  const binders: Binder[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) text += separator;
    text += parts[i].text;
    for (const binder of parts[i].binders) binders.push(binder);
  }
  return { text, binders };
}

/**
 * Replace every parameter marker with the dialect's placeholder for its
 * position. Runs once per compiled plan, never per call.
 */
export function render(
  fragment: Fragment,
  dialect: SqlDialect,
  /**
   * Where the statement came from, for the parameter-ceiling error.
   *
   * Required, and deliberately so. Optional would reintroduce in miniature the
   * hole this check exists to close — a new call site that omits it skips the
   * ceiling silently, which is the same failure as a per-compiler guard, one
   * level down. Making it required is the difference between a convention and
   * something `tsc` enforces. A test that wants to render bare can pass
   * `{ model: "test", operation: "test" }`.
   */
  origin: { model: string; operation: string },
): { text: string; binders: Binder[] } {
  const segments = fragment.text.split(PARAM_MARKER);
  const count = segments.length - 1;

  if (count !== fragment.binders.length) {
    // Unreachable unless a fragment was built by hand with a mismatched count.
    // Worth an assertion rather than a subtly misaligned parameter array.
    throw new Error(
      `Compiled ${count} parameter placeholders but collected ` +
        `${fragment.binders.length} binders.`,
    );
  }

  // The parameter ceiling, checked here because this is the one place that
  // knows a *statement's* final count — and because a guard at any single
  // compiler is a guard the next compiler forgets.
  //
  // It started life inside `compileCreateMany`, on the reasoning that
  // `rows × columns` was the only count that scaled with the caller's data.
  // That was wrong: on SQLite an `in` list binds one placeholder per element,
  // so `findMany({ where: { id: { in: <40 000 ids> } } })` walks into the same
  // driver error, and such a list is routinely request-derived. The relation
  // loader has the same shape, batching an `in` over the parent keys — so a
  // large `findMany` with an `include` reaches it without anyone writing a big
  // list by hand. Postgres is unaffected either way: `= any($1)` is one
  // parameter however long the array.
  //
  // Compile-time is exact rather than approximate, on both dialects: where the
  // length changes the placeholder count it also changes the SQL text, so it is
  // already part of the plan's identity.
  if (count > dialect.maxBoundParameters) {
    throw new ParameterLimitError(
      origin.model,
      origin.operation,
      count,
      dialect.maxBoundParameters,
      dialect.name,
      dialect.bindsListAsOneParameter
        ? `That is one parameter per value in the statement.`
        : `That is one parameter per value, and on ${dialect.name} each ` +
            `element of an 'in' list counts separately.`,
    );
  }

  let text = segments[0];
  for (let i = 0; i < count; i++) {
    text += dialect.placeholder(i) + segments[i + 1];
  }

  return { text, binders: fragment.binders };
}
