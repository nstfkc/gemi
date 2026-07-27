import type { SqlDialect } from "../dialect";

/**
 * Pulls one value out of the argument tree at bind time. Compilation closes
 * over the *path* to a value, never the value itself — that is what makes two
 * calls with the same argument shape and different values produce byte
 * identical SQL, and it is what the plan cache depends on.
 */
export type Binder = (args: any) => unknown;

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

/** A single parameter position, bound from the argument tree at call time. */
export function param(binder: Binder): Fragment {
  return { text: PARAM_MARKER, binders: [binder] };
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

  let text = segments[0];
  for (let i = 0; i < count; i++) {
    text += dialect.placeholder(i) + segments[i + 1];
  }

  return { text, binders: fragment.binders };
}
