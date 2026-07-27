import {
  SqliteDialect,
  buildInterpretedShaper,
  buildRowShaper,
} from "gemi/orm";

import { UserModel } from "../generated";
import { time } from "./harness";

/**
 * Deliverable 4, the shaper half — the only optimisation the main suite
 * justified. It measured ~190µs of a ~600µs 1000-row SQLite read, so roughly a
 * third of that scenario is the ceiling on anything here.
 *
 * The plan says to choose between "a monomorphic closure chain or, if benchmarks
 * justify it, a compiled function body", and to measure before choosing —
 * because a compiled body costs debuggability and is unavailable wherever `eval`
 * is disallowed (a strict CSP, some edge runtimes). That is a real constraint on
 * a framework, so the bar for taking it has to be a number rather than a
 * preference.
 *
 * Three variants, on the same 1000 rows:
 *
 *   current    what ships: closure over a column array, dynamic key assignment
 *   flat       the same, with per-column data hoisted into parallel arrays
 *   compiled   `new Function` emitting an object literal with fixed keys
 *
 * The interesting difference is the third: an object literal with known keys
 * gets one hidden class, while `shaped[key] = value` in a loop transitions the
 * object's shape once per property. That is the mechanism that would make it
 * win, and the reason it is worth measuring despite the cost.
 *
 * Run: bun run app/models/bench/shaper.ts
 */

const dialect = new SqliteDialect();
const schema = UserModel.$schema;
const fields = Object.values(schema.fields);

/** A driver row, as Bun's SQLite driver hands it over: keyed by column name. */
function makeRow(index: number): Record<string, unknown> {
  return {
    id: index,
    publicId: `c${index}aaaaaaaaaaaaaaaaaaaa`,
    name: `User ${index}`,
    email: `user-${index}@x.test`,
    emailVerifiedAt: null,
    verificationToken: null,
    locale: "en-US",
    globalRole: 2,
    password: null,
    organizationId: null,
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    deletedAt: null,
  };
}

const rows = Array.from({ length: 1000 }, (_, index) => makeRow(index));

/** Parallel arrays instead of an array of objects: one load per column, not three. */
function buildFlatShaper() {
  const keys = fields.map((field) => field.name);
  const columns = fields.map((field) => field.column);
  const decoders = fields.map((field) => dialect.needsDecode(field));
  const width = keys.length;

  return (input: unknown[]) => {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < input.length; i++) {
      const row = input[i] as Record<string, unknown>;
      const shaped: Record<string, unknown> = {};
      for (let j = 0; j < width; j++) {
        const value = row[columns[j]];
        shaped[keys[j]] = decoders[j]
          ? dialect.decode(value, fields[j])
          : (value ?? null);
      }
      out.push(shaped);
    }
    return out;
  };
}

/**
 * `new Function`, emitting one object literal with every key spelled out.
 *
 * The keys come from the generated schema and nowhere else, which is the same
 * property that makes the SQL compiler safe — but it is worth being explicit
 * that this is a code-generation path and its inputs must never widen to
 * anything a caller controls.
 */
function buildCompiledShaper() {
  const parts = fields.map((field, index) => {
    const key = JSON.stringify(field.name);
    const column = JSON.stringify(field.column);
    return dialect.needsDecode(field)
      ? `${key}: d.decode(row[${column}], f[${index}])`
      : `${key}: row[${column}] ?? null`;
  });

  const body = `
    return function shape(input) {
      const out = [];
      for (let i = 0; i < input.length; i++) {
        const row = input[i];
        out.push({ ${parts.join(", ")} });
      }
      return out;
    };
  `;

  // eslint-disable-next-line no-new-func
  return new Function("d", "f", body)(dialect, fields) as (
    input: unknown[],
  ) => Record<string, unknown>[];
}

// The *interpreted* shaper is the baseline, deliberately — `buildRowShaper`
// returns the compiled one since this measurement justified making it the
// default, so using it here would compare the winner against itself. Naming the
// baseline explicitly keeps the number reproducible after the default changed.
const current = buildInterpretedShaper(fields, dialect);
// ...and this asserts the default really is the compiled path, so a future
// change that silently reverts it shows up here rather than as a slow query.
const viaDefault = buildRowShaper(fields, dialect);
const flat = buildFlatShaper();
const compiled = buildCompiledShaper();

// Correctness before speed: a faster shaper that produces a different object is
// not a candidate. Compared as JSON so key *order* is compared too, since that
// is observable to a caller and the differential harness compares it.
const expected = JSON.stringify(current(rows));
for (const [name, shaper] of [
  ["flat", flat],
  ["compiled", compiled],
  ["default", viaDefault],
] as const) {
  const actual = JSON.stringify(shaper(rows));
  if (actual !== expected) {
    console.error(`${name} produces a different result — not a candidate.`);
    console.error(`  expected: ${expected.slice(0, 200)}`);
    console.error(`  actual:   ${actual.slice(0, 200)}`);
    process.exit(1);
  }
}

const results: Array<[string, number, number]> = [];
for (const [name, shaper] of [
  ["interpreted (closure, dynamic keys)", current],
  ["flat (parallel arrays)", flat],
  ["compiled (new Function, literal)", compiled],
  ["buildRowShaper default", viaDefault],
] as const) {
  const timing = await time(() => shaper(rows), { runs: 300 });
  results.push([name, timing.p50, timing.p95]);
}

const baseline = results[0][1];

console.log(`\n1000 User rows, 13 columns, SQLite dialect, ${300} runs\n`);
console.log("| Variant | p50 µs | p95 µs | vs current |");
console.log("| --- | --: | --: | --: |");
for (const [name, p50, p95] of results) {
  const delta = ((baseline - p50) / baseline) * 100;
  console.log(
    `| ${name} | ${p50.toFixed(1)} | ${p95.toFixed(1)} | ` +
      `${delta > 0 ? "+" : ""}${delta.toFixed(0)}% |`,
  );
}
console.log("");
