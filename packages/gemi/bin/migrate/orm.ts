// The two ORM-port passes: what a Prisma application walks into when a read or
// a write moves onto gemi's ORM and nothing anywhere says so.
//
// Both came off the same port (#356, #357) and both share the shape that makes
// a documentation line insufficient. The code keeps compiling, keeps running
// and keeps passing its tests; the thing that broke only surfaces under a
// condition the application itself never produces — a race, or a hand-edited
// URL. `tsc` cannot see either (`Number(x)` is a `number`, and a guard over
// `unknown` is supposed to accept anything), and a grep only helps somebody who
// already knows what to grep for. So the check has to sweep the tree unprompted,
// which is the one thing this command already does.
//
// Annotate-only, like every other pass in this command. `lex.ts` is a hand-
// rolled scanner rather than a parser: it can tell a string literal from a
// comment and match a bracket, and it cannot tell whether `limit` holds an
// integer or whether the `catch` this `"P2002"` sits in wraps an ORM call or a
// Prisma one. A rewrite would need that. A sentence beside the line does not,
// and a sentence beside the line is what both issues asked for.
//
// **Except in a file that can hold JSX, where a `//` line is not a comment.**
// Inside JSX children it is page text, and the `{ code: "P2002" }` this module's
// own message contains becomes an expression container — so splicing one in
// stops the file parsing. Measured, on the obvious shape:
//
//     {error?.code === "P2002" ? <p>Email taken</p> : null}
//
// annotated and fed to Bun's `tsx` loader answers `Expected "}" but found ":"`.
// A migration command that leaves the app unable to build is worse than one that
// says nothing, and the `take` pass is exposed further still — it has no import
// gate, and its message parses in children position, so it would have rendered a
// paragraph of migration advice onto the page.
//
// The gate is the file extension, and that is a guarantee rather than a guess:
// TypeScript permits JSX only in `.tsx` / `.jsx`, so a `.ts` file cannot contain
// any. Those files are *reported* instead, with line numbers, which is what the
// splice was carrying anyway. Neither pass can hit inside a string or template
// literal — `skipAtomic` steps over both before either finder looks — so on a
// file that cannot hold JSX every hit is ordinary code and the splice is safe.

import { parseImports } from "./imports";
import { matchDelims, skipAtomic, skipTrivia } from "./lex";
import { TODO } from "./tables";

/**
 * The report sink `runMigrate` collects into. Spelled structurally rather than
 * imported, because `index.ts` imports this module and naming its `Note` here
 * would close the cycle.
 */
type Notes = { file: string; message: string }[];

/**
 * What a `"P2002"` guard becomes once the write under it is a gemi write.
 *
 * The sentence has to carry the *silence*, not just the fact. Every other thing
 * this command flags announces itself — a missing export is a compile error, a
 * renamed field is a type error. This one has four independent signals and all
 * four stay green, so a reader who is told only "the code changed" will
 * reasonably conclude their guard is fine because their tests pass. It is the
 * tests passing that is the symptom.
 */
const P2002_HAZARD =
  '`"P2002"` stops matching the moment the write it guards moves onto the ORM. ' +
  "gemi raises `UniqueConstraintError`, which carries `model`, `operation`, " +
  "`fields` and `constraint` and no `code` anywhere on its prototype chain — so " +
  "the check returns false, the recovery branch it exists to run never runs, and " +
  "nothing reports it: it compiles, it runs, and a test that mocks " +
  '`{ code: "P2002" }` still passes while the branch it certifies is dead. Use ' +
  "`isUniqueConstraintError` from `gemi/orm`. While some writes in this app are " +
  "still on Prisma, keep the old check as a second arm — " +
  '`isUniqueConstraintError(e) || (isRecord(e) && e.code === "P2002")` — and ' +
  "delete that arm when the last Prisma writer goes. See UPGRADE.md.";

/**
 * What a non-literal `take` / `skip` might be.
 *
 * Deliberately phrased as a request to confirm rather than a claim of a bug.
 * Most non-literal `take`s are fine — they are a clamped constant, a page size
 * the app itself computed, a value already truncated — and this pass cannot
 * tell those from the broken ones, because the difference is a runtime value.
 * An annotation that asserted a defect would be wrong most of the times it
 * fires, and a marker that is wrong most of the time is one people learn to
 * skip past, which costs more than the pass earns.
 *
 * So it names the shape that actually breaks, and it names `page` louder than
 * `take`: `page` never reaches the ORM at all, it reaches it multiplied, as a
 * fractional `skip`, which is why the ported application's reviewers found the
 * `take` sites and missed the `page` ones.
 */
const PAGE_ARGUMENT_HAZARD =
  "`take` and `skip` must be integers — gemi refuses a fractional one with " +
  "`InvalidArgumentError` where Prisma truncated it, because SQLite answers " +
  "`limit 1.5` with an opaque driver error and Postgres rounds it up to 2 rows. " +
  "This value is not an integer literal, which is usually fine: confirm it is " +
  "truncated where it enters the app rather than reading this as a bug. " +
  '`Number(req.search.get("limit"))` is the shape that breaks, and a fractional ' +
  "`page` is the one to look hardest for — it never reaches the ORM itself, it " +
  "reaches it multiplied, as a fractional `skip`. `paginate({ page, perPage })` " +
  "from `gemi/orm` truncates and clamps in one place and cannot produce a value " +
  "the ORM refuses.";

/**
 * Runs both passes over one file under `app/`.
 *
 * Sequential rather than merged: each pass re-scans the text the previous one
 * produced, which is free (these files are small) and removes the only way the
 * two could interfere — an offset computed against the pre-insertion text being
 * applied to the post-insertion one.
 */
export function annotateOrmPortHazards(
  source: string,
  label: string,
  notes: Notes,
): string {
  const spliceable = !JSX_FILE.test(label);
  let result = source;

  // The import gate is #357's, and it is what keeps this pass worth reading. A
  // `"P2002"` in a file with no model import is either still-Prisma code, where
  // the guard is correct exactly as written, or an unrelated string; annotating
  // those teaches the reader that the marker means nothing. A file mid-port
  // imports both `@prisma/client` and the app's models, and that file *is* the
  // one that needs the bridge — so the gate asks only about the model side.
  //
  // Its false negative is real and deliberate: a guard living in a shared
  // `lib/errors.ts` that imports nothing from the model surface is not found
  // here. UPGRADE.md carries the plain grep for that, because a codemod that
  // followed call graphs would need the parser this command does not have.
  if (importsModelSurface(result)) {
    result = runPass(
      result,
      prismaErrorCodeLiterals(result),
      '`"P2002"`',
      P2002_HAZARD,
      label,
      notes,
      spliceable,
    );
  }

  // No import gate on this one, on purpose. A fractional `skip` is produced
  // where the query string is read and consumed several layers away, so the
  // file holding `take: limit` need not import a model at all — it is often a
  // repository or a service that takes the numbers and passes them along. The
  // gate would remove exactly the hop that makes the value hard to trace.
  result = runPass(
    result,
    nonIntegerPageArguments(result),
    "`take` / `skip`",
    PAGE_ARGUMENT_HAZARD,
    label,
    notes,
    spliceable,
  );

  return result;
}

/**
 * TypeScript accepts JSX only in these two extensions, which is what makes the
 * test a guarantee rather than a heuristic: a `.ts` file cannot contain JSX, so
 * it cannot contain a position where a `//` line means something else.
 */
const JSX_FILE = /\.[jt]sx$/i;

/**
 * One pass: splice where that is safe, report where it is not.
 *
 * The report is not a lesser outcome. It carries the line numbers the splice
 * carried by sitting on them, and it is what the `--dry-run` reader sees either
 * way; what it loses is surviving into the diff, which is worth less than the
 * file continuing to parse.
 */
function runPass(
  src: string,
  hits: number[],
  what: string,
  message: string,
  label: string,
  notes: Notes,
  spliceable: boolean,
): string {
  if (!hits.length) return src;

  if (!spliceable) {
    notes.push({
      file: label,
      message:
        `${what} on ${lineList(src, hits)} — reported rather than annotated: ` +
        `a \`//\` line inside JSX children is page text, not a comment, so ` +
        `writing one here would stop the file parsing. ${message}`,
    });
    return src;
  }

  const marked = annotateLines(src, hits, message);
  if (marked.annotated > 0) {
    notes.push({
      file: label,
      message: `${what} (${occurrences(hits.length)}) — ${message}`,
    });
  }
  return marked.text;
}

const occurrences = (count: number) =>
  count === 1 ? "1 occurrence" : `${count} occurrences`;

/** `line 12` / `lines 12, 40` — 1-based, deduplicated, in source order. */
function lineList(src: string, offsets: number[]): string {
  const numbers: number[] = [];
  for (const offset of offsets) {
    let line = 1;
    for (let i = 0; i < offset && i < src.length; i++) {
      if (src[i] === "\n") line++;
    }
    if (numbers[numbers.length - 1] !== line) numbers.push(line);
  }
  return numbers.length === 1
    ? `line ${numbers[0]}`
    : `lines ${numbers.join(", ")}`;
}

// ---------------------------------------------------------------------------
// #357 — a `"P2002"` literal in a file that also imports the model surface
// ---------------------------------------------------------------------------

/**
 * Offsets of every `"P2002"` string literal, template included.
 *
 * Only `P2002`, not the `P` codes in general. It is the one whose replacement
 * gemi actually ships a predicate for, and a marker that fires on `P2025` while
 * having nothing to offer instead would be a complaint rather than a migration
 * step.
 *
 * Comments are stepped over rather than searched, and that is load-bearing for
 * more than tidiness: the annotation this pass writes quotes `"P2002"` twice, so
 * scanning comments would make the command annotate its own output on the second
 * run. The idempotency check below is the belt; this is the braces.
 */
function prismaErrorCodeLiterals(src: string): number[] {
  const hits: number[] = [];
  let i = 0;
  while (i < src.length) {
    const end = skipAtomic(src, i);
    if (end === null || end <= i) {
      i++;
      continue;
    }
    const span = src.slice(i, end);
    if (/^["'`]/.test(span) && span.slice(1, -1) === "P2002") hits.push(i);
    i = end;
  }
  return hits;
}

/**
 * `models` as a path segment, which is how every gemi app spells it —
 * `@/app/models`, `../models/Invoice`, `./models`. `app/models/index.ts` is the
 * barrel the Kernel registers, so a file that touches a model at all reaches it
 * through a specifier ending in or passing through `models`.
 */
const MODEL_SURFACE = /(^|\/)models(\/|$)/;

function importsModelSurface(src: string): boolean {
  return parseImports(src).some(
    (decl) => decl.module === "gemi/orm" || MODEL_SURFACE.test(decl.module),
  );
}

// ---------------------------------------------------------------------------
// #356 — a `take:` / `skip:` whose value is not an integer literal
// ---------------------------------------------------------------------------

const PAGE_KEYS = ["take", "skip"];

/** Offsets of the `take` / `skip` keys whose value is not provably integral. */
function nonIntegerPageArguments(src: string): number[] {
  const hits: number[] = [];
  let i = 0;
  while (i < src.length) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }

    const key = PAGE_KEYS.find((candidate) => src.startsWith(candidate, i));
    if (!key || /[\w$.]/.test(src[i - 1] ?? "")) {
      i++;
      continue;
    }

    let after = skipTrivia(src, i + key.length);
    // `take?:` is an optional property, which only exists in a type — an object
    // literal cannot spell one. Skipping it keeps every wrapper interface an app
    // writes around its own pagination arguments out of the report.
    if (src[after] === "?") after = skipTrivia(src, after + 1);
    if (src[after] !== ":") {
      i += key.length;
      continue;
    }

    const valueStart = skipTrivia(src, after + 1);
    const valueEnd = endOfValue(src, valueStart);
    if (!isIntegerArgument(src.slice(valueStart, valueEnd).trim())) {
      hits.push(i);
    }
    i = Math.max(valueEnd, i + key.length);
  }
  return hits;
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * End of the expression a property key was given.
 *
 * Bounded at the newline as well as at the usual separators. A value continued
 * onto a second line is therefore read as its first line alone — which can only
 * make it look *less* integral than it is, never more, so the pass errs toward
 * annotating rather than toward missing a site. That direction is the right one
 * here: the annotation already asks the reader to confirm rather than asserting
 * a defect, so a surplus one costs a glance and a missing one costs a 500.
 */
function endOfValue(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const skipped = skipAtomic(src, i);
    if (skipped !== null && skipped > i) {
      i = skipped;
      continue;
    }
    const c = src[i]!;
    const closer = CLOSERS[c];
    if (closer) {
      i = matchDelims(src, i, c, closer);
      continue;
    }
    if (c === "," || c === ")" || c === "]" || c === "}" || c === ";" || c === "\n") {
      return i;
    }
    i++;
  }
  return src.length;
}

const INTEGER_LITERAL = /^-?\d+(?:_\d+)*$/;

/**
 * `Math.trunc(x)` and friends as the *whole* value, not merely somewhere in it —
 * `Math.trunc(perPage) * (page - 1)` is arithmetic on a truncated number and
 * stays truncated, but `Math.trunc(a) / 2` does not, and the two are the same
 * shape to a scanner. Anchoring on the whole value keeps the exemption to the
 * spelling that is unambiguously safe.
 *
 * Exempting them at all is a judgement about what the marker is worth. Two of
 * the nine call sites #356 measured had already truncated, for unrelated
 * reasons; flagging the sites that already carry the fix is the fastest way to
 * turn the pass into noise.
 */
const TRUNCATING_CALL =
  /^(?:Math\.(?:trunc|floor|ceil|round)|(?:Number\.)?parseInt)\s*(?=\()/;

/**
 * A bare `number` is a type annotation in a position this scanner cannot
 * distinguish from a value — `interface Page { take: number }` with no `?` and
 * no `;`. Nothing writes an object literal whose value is an identifier called
 * `number`, so reading it as a type is right far more often than it is wrong.
 */
const TYPE_POSITION = /^number(?:\s*\|\s*undefined)?$/;

function isIntegerArgument(value: string): boolean {
  if (INTEGER_LITERAL.test(value)) return true;
  if (TYPE_POSITION.test(value)) return true;

  const call = TRUNCATING_CALL.exec(value);
  if (!call) return false;
  const open = call[0].length;
  return value[open] === "(" && matchDelims(value, open, "(", ")") === value.length;
}

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

/**
 * Puts one `TODO(gemi-migrate):` line above every line an offset falls on.
 *
 * Line-oriented for the same reason `annotateRetiredFields` is: the offsets are
 * computed once against the text as it stands, and rebuilding the file from its
 * lines cannot outlive the array — where advancing a cursor through a string
 * that grows as annotations are spliced into it depends on the splice for
 * termination.
 *
 * Idempotent per line, and the annotation is deliberately a single line so that
 * the one just emitted is the only place a previous run's could be. Two hits on
 * one line (`{ take: limit, skip: limit * (page - 1) }`, which is exactly how
 * the ported application wrote it) share one annotation.
 */
function annotateLines(
  src: string,
  offsets: number[],
  message: string,
): { text: string; annotated: number } {
  if (!offsets.length) return { text: src, annotated: 0 };

  const lines = src.split("\n");
  const targets = new Set<number>();
  let cursor = 0;
  let next = 0;
  for (let index = 0; index < lines.length && next < offsets.length; index++) {
    const end = cursor + lines[index]!.length;
    while (next < offsets.length && offsets[next]! <= end) {
      targets.add(index);
      next++;
    }
    cursor = end + 1;
  }

  const out: string[] = [];
  let annotated = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (targets.has(index)) {
      const previous = out[out.length - 1] ?? "";
      if (!previous.includes(message)) {
        out.push(`${/^[ \t]*/.exec(line)![0]}${TODO} ${message}`);
        annotated++;
      }
    }
    out.push(line);
  }

  return { text: out.join("\n"), annotated };
}
