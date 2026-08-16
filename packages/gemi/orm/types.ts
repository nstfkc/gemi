// The ORM's argument and result types, derived from a per-model descriptor the
// generator emits.
//
// **Why these are gemi's own rather than Prisma's.** The generated model bases
// used to `import type { Prisma } from "@prisma/client"` and build every
// signature out of `Prisma.<M>FindManyArgs`, `Prisma.<M>GetPayload<T>` and
// friends. That single type-only import is what forced an app to install
// `@prisma/client` — 74MB, plus the 23MB client `prisma generate` then wrote —
// for types that are erased at build. Nothing in Prisma's schema, migration or
// generator machinery needs the package; the import was the whole of the
// coupling.
//
// It was also describing the wrong library. Prisma's argument types describe
// what *Prisma's* query engine accepts, and gemi executes its own SQL. The two
// disagree, and the disagreements were invisible: `Prisma.<M>FindManyArgs`
// admits `distinct` and `cursor`, both of which gemi refuses permanently and by
// design (see `compile/read.ts`), so the old types type-checked code that threw
// at runtime. These types describe what gemi actually does.
//
// ## The division of labour
//
// The generator emits *facts* it can read straight off the DMMF — the concrete
// TypeScript type of every column, which relations point where, which key
// combinations are unique. This file supplies the *combinators* over them:
// `select` narrowing, filter grammars, argument shapes. That split is what keeps
// the emitted file small and keeps the rules in one place, versioned with the
// runtime that enforces them.
//
// Concretely, an app's `models.ts` emits one of these per model:
//
//     export interface UserTypes extends ModelTypeInfo {
//       scalars: { id: number; email: string | null; plan: "free" | "pro" };
//       relations: { accounts: { kind: "many"; nullable: false; target: AccountTypes } };
//       unique: { id: number } | { email: string };
//     }
//
// and every signature on `UserModel` is a combinator applied to it.
//
// ## What bounds the recursion, and what does not
//
// **`Payload` is bounded by the caller's literal.** It recurses through `select`
// and `include`, which reads like an unbounded walk over a cyclic relation graph
// and is not: a relation is descended into only when the caller's own argument
// object names it, so the depth of the instantiation is the depth of the literal
// that was written. A self-referential `include: { manager: true }` bottoms out
// immediately, because `true` means "that model's scalars" and asks for nothing
// further.
//
// **The input types are not, and it is worth being exact about why they are
// still finite.** `WhereInput`, `OrderByInput`, `SelectInput` and `IncludeInput`
// name each other and themselves through the relation graph unconditionally —
// `WhereInput<User>` mentions `WhereInput<Account>`, which mentions
// `WhereInput<User>` again, whatever the caller passes. They typecheck because
// TypeScript defers resolution of an object type's properties until something
// asks for one, not because anything bounds them. That is a real property and a
// stable one, but it is a different property, and a change that made any of them
// eagerly evaluated — mapping over `keyof` at the top level, say, or wrapping one
// in a conditional that has to resolve the whole shape — would turn a cyclic
// schema into an instantiation-depth error rather than a slow compile.
//
// **The operator grammars below map over a tuple, and that is not the mapping
// the paragraph above warns about.** All six of them — `ListFilter`,
// `JsonPathFilter`, `HavingComparison`, `RelationFilter`, `NestedCreate` and
// `NestedUpdate` — are `[K in a fixed tuple of literals]`, not `[K in keyof M]`:
// the key set is decided by the compiler's own list and is the same size
// whatever the schema is, and the property types are deferred exactly as an
// interface's are. (The sizes differ per grammar — two to eleven keys — and
// none of them is a function of the model.) Measured rather than assumed: the
// template's fourteen mutually recursive models typecheck in the same time they
// did before (1.6–1.8s, warm, either way).

import type {
  AnyNullValue,
  DbNullValue,
  JsonNullValue,
} from "./json-null";
// The operator and statement names below are **the compiler's own lists**, not
// copies of them. Each filter grammar here used to spell its operators a second
// time, in a file the compiler neither imports nor is imported by, so the two
// could differ with nothing failing: #326, #333, #336 and #337 are four
// instances of exactly that, and every one of them ran the same way — the
// compiler answered a query the type had no spelling for. Mapping over the
// runtime tuple turns the next such drift into a compile error here.
//
// `import type`, so this is erased entirely: no runtime edge is created from
// the type layer into the compiler, and `orm/index.js` is unchanged.
import type { HavingOperator } from "./compile/group-by";
import type {
  CollectionOnlyStatement,
  ExistingRowStatement,
  NestedWriteStatement,
} from "./compile/nested-writes";
import type { JsonFilterName, ListFilterName } from "./compile/where";
import type {
  ManyRelationOperator,
  OneRelationOperator,
} from "./relation-filters";

/**
 * Any value a `Json` column can hold, on either dialect.
 *
 * Recursive through its array and object members, which TypeScript defers, so
 * this is a finite type despite naming itself.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * What a `Json` column accepts on a write.
 *
 * The two sentinels are the column's two empty states — SQL NULL and the JSON
 * value `null` — and a bare `null` is not among them: the choice is the whole
 * reason they exist, and guessing between them is what silently stores the
 * wrong one of two legal answers.
 *
 * **`null` is excluded explicitly**, because `JsonValue` contains it. That is
 * correct of `JsonValue` — a `Json` column really can hold the JSON value
 * `null`, and a nested one is untouched by this: `{ a: [1, null] }` still
 * type-checks. It is only the *top-level* `null` that has to go, which is the
 * distinction Prisma draws too with `InputJsonValue`. Without the `Exclude`,
 * `metadata: null` compiled while `docs/orm.md` said in this same change that
 * it does not.
 */
export type JsonInput =
  | Exclude<JsonValue, null>
  | DbNullValue
  | JsonNullValue;

/**
 * Is this column a `Json` one?
 *
 * Asked as "does every JSON value fit here", which is true of a `Json` column
 * and of nothing else: a `String` column does not accept a number, and a
 * `String[]` does not accept a bare object. Wrapped in tuples to stop the
 * conditional distributing over `JsonValue`'s own union — the check is about
 * the union as a whole.
 *
 * **Both sides drop `null`, and the left side has to.** `JsonValue` *includes*
 * `null`, because a `Json` column can hold the JSON value `null` whether or not
 * the column is nullable. So `NonNullable<JsonValue | null>` is `JsonValue`
 * *minus* `null`, and comparing plain `JsonValue` against it answered `false`
 * for every nullable `Json` column — which sent `metadata` to the scalar branch,
 * where `{ equals: JsonNull }` is not a filter it accepts.
 */
type IsJson<V> = [Exclude<JsonValue, null>] extends [NonNullable<V>]
  ? true
  : false;

/** One relation, as the generated descriptor describes it. */
export interface RelationInfo {
  kind: "one" | "many";
  /** A to-one whose foreign key is nullable resolves to `T | null`. */
  nullable: boolean;
  target: ModelTypeInfo;
}

/**
 * What the generator emits per model, and the only thing every type here reads.
 *
 * `scalars` is concrete rather than derived from the schema literal. The
 * emitter already knows a column's TypeScript type exactly — including enum
 * member unions and `String[]`, neither of which the runtime metadata records —
 * so deriving it a second time at the type level would be a second definition
 * free to disagree with the first.
 */
export interface ModelTypeInfo {
  scalars: Record<string, unknown>;
  relations: Record<string, RelationInfo>;
  /** The union of the model's unique selectors: `@id`, `@unique`, `@@unique`. */
  unique: unknown;
  /**
   * The scalar half of `create`'s `data`, with the required/optional split
   * already applied.
   *
   * Which columns are optional is not derivable from `scalars`: a column is
   * omissible when it is nullable, carries a `@default`, or is an `@updatedAt`,
   * and only the first of those is visible in the column's type. The generator
   * reads all three off the DMMF, so it emits the answer rather than leaving a
   * rule here to re-derive it from information it does not have.
   */
  create: Record<string, unknown>;
}

type Scalars<M extends ModelTypeInfo> = M["scalars"];
type Relations<M extends ModelTypeInfo> = M["relations"];

/**
 * Excess-property rejection for a generic argument.
 *
 * `T` is inferred from the literal the caller wrote, so any key outside `U`
 * collapses to `never` and the call fails at that key rather than being quietly
 * accepted. Prisma's own generated client carries the same helper under the same
 * name; it was previously copied into every emitted `models.ts`.
 */
export type Subset<T, U> = {
  [key in keyof T]: key extends keyof U ? T[key] : never;
};

/**
 * The same, kept as a distinct name because `count`'s `select` decides the
 * *result* type as well as validating the input, and the two uses read
 * differently at the call site.
 */
export type SelectSubset<T, U> = Subset<T, U>;

/** Keys of a select/include object the caller actually asked for. */
type Requested<S> = {
  [K in keyof S]-?: S[K] extends false | undefined ? never : K;
}[keyof S];

/**
 * `true` in an `include` means "that model's scalars, nothing further".
 *
 * `unknown` rather than `{}` for the no-arguments case: every branch of
 * `Payload` asks whether a key is in `keyof A`, and `keyof unknown` is `never`,
 * so `unknown` answers no to all of them and lands on the default selection.
 * `{}` would too, but only because an empty object type happens to have no
 * keys — a coincidence to rely on rather than a statement of intent.
 *
 * (This read `A extends { select: infer S }` until #326, when that form turned
 * out to disagree with assignability for arguments inferred through `Subset`.
 * The conclusion is unchanged; the reason it holds is now the key check.)
 */
type ArgsOf<A> = A extends true ? unknown : A;

type RelationPayload<R extends RelationInfo, A> = R["kind"] extends "many"
  ? Payload<R["target"], ArgsOf<A>>[]
  : R["nullable"] extends true
    ? Payload<R["target"], ArgsOf<A>> | null
    : Payload<R["target"], ArgsOf<A>>;

/**
 * `_count` inside a `select` or an `include`: the number of related rows, per
 * relation named.
 *
 * The second branch is the `_count: true` shorthand, which names none and
 * therefore returns every **to-many** relation — the set `countableRelations`
 * hands the compiler and the policy walk. It said `keyof Relations<M>` while the
 * shorthand was refused, which was unreachable and wrong in the same breath: a
 * to-one is skipped by the expansion, so promising `number` for one would have
 * typed a key that is never on the row the moment #394 made the shorthand
 * reachable.
 */
type RelationCountPayload<M extends ModelTypeInfo, A> = "select" extends keyof A
  ? { [K in Requested<NonNullable<A["select"]>> & keyof Relations<M>]: number }
  : {
      [K in keyof Relations<M> as Relations<M>[K]["kind"] extends "many"
        ? K
        : never]: number;
    };

type SelectPayload<M extends ModelTypeInfo, S> = {
  [K in Requested<S>]: K extends keyof Scalars<M>
    ? Scalars<M>[K]
    : K extends keyof Relations<M>
      ? RelationPayload<Relations<M>[K], S[K]>
      : K extends "_count"
        ? RelationCountPayload<M, S[K]>
        : never;
};

type IncludePayload<M extends ModelTypeInfo, I> = {
  [K in Requested<I>]: K extends keyof Relations<M>
    ? RelationPayload<Relations<M>[K], I[K]>
    : K extends "_count"
      ? RelationCountPayload<M, I[K]>
      : never;
};

/** `omit: { email: true }` removes the column from the default selection. */
type OmitPayload<M extends ModelTypeInfo, O> = Omit<Scalars<M>, Requested<O>>;

/**
 * The result of an operation, narrowed by the arguments it was given.
 *
 * The `select` branch is checked before `include` because a query carrying both
 * follows its `select`. That pairing type-checks and is refused at runtime by
 * `resolveSelection` — parity with Prisma, whose generated args accept it too,
 * and asserted in the template's `select.test-d.ts`.
 *
 * ### Why these ask `"k" extends keyof A` rather than `A extends { k: infer V }`
 *
 * The structural form is the one you would write, and it was what #326 was: a
 * relation carrying `orderBy` (or `where`, `take`, `skip`) stopped resolving its
 * own nested relations, coming back as the target's bare scalars. The row was
 * there at runtime; only the type fell back, so a filtered, ordered list read —
 * the products of this list in order, each with its product row — could not be
 * spelled in a way that typed, in `select` or in `include`.
 *
 * The arguments reach here through `Subset`, the excess-property guard the
 * generated signatures wrap them in. Inferring `T` through that mapped type
 * leaves a relation's arguments in a shape that is *assignable* to
 * `{ select: unknown }` — a value of it type-checks against that annotation —
 * while `A extends { select: unknown }` is false. Assignability and the
 * conditional's `extends` disagree, and the conditional took its else branch and
 * returned the default selection. Only relations carrying arguments were
 * affected: `{ select: … }` on its own never went through that path.
 *
 * Asking whether the key exists and then indexing avoids the disagreement
 * entirely — `A["select"]` resolves correctly in exactly the cases where the
 * `extends` did not. The `[…] extends [undefined]` guards were already here for
 * an explicitly-`undefined` key and still are; `NonNullable` is what an optional
 * key needs once it is reached by indexing rather than by inference.
 *
 * Dropping `Subset` also fixes it, and costs more than it saves: it is what
 * rejects `orderBey` inside a relation's arguments, which nothing else catches.
 */
export type Payload<M extends ModelTypeInfo, A> = "select" extends keyof A
  ? [A["select"]] extends [undefined]
    ? DefaultPayload<M, A>
    : SelectPayload<M, NonNullable<A["select"]>>
  : DefaultPayload<M, A>;

type DefaultPayload<M extends ModelTypeInfo, A> = "omit" extends keyof A
  ? [A["omit"]] extends [undefined]
    ? WithInclude<M, A, Scalars<M>>
    : WithInclude<M, A, OmitPayload<M, NonNullable<A["omit"]>>>
  : WithInclude<M, A, Scalars<M>>;

type WithInclude<M extends ModelTypeInfo, A, Base> = "include" extends keyof A
  ? [A["include"]] extends [undefined]
    ? Base
    : Base & IncludePayload<M, NonNullable<A["include"]>>
  : Base;

/** Every column of the model, which is what `wrap` demands and `include` keeps. */
export type Row<M extends ModelTypeInfo> = Scalars<M>;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * The scalar operators, from `compile/where.ts`'s own table.
 *
 * Split by operand type rather than offered on everything: `contains` on a
 * `String` asks about a substring and on a `Date` asks nothing, and a filter
 * grammar that accepts a question the compiler will refuse is the failure these
 * types exist to stop.
 */
type Comparable = number | bigint | Date | string;

type BaseFilter<V> = {
  equals?: V;
  not?: V | NestedFilter<V>;
  in?: NonNullable<V>[];
  notIn?: NonNullable<V>[];
};

/**
 * The identity for intersection: an object type with no keys.
 *
 * **Not `Record<string, never>`**, which is not an empty object — it is
 * `{ [k: string]: never }`, an index signature whose every value is `never`. It
 * poisons every sibling property of an intersection, because each of them then
 * has to satisfy the index signature too. `NestedFilter` is
 * `BaseFilter & OrderingFilter & StringFilter`, and on any non-`String` column
 * at least one of the latter two takes its false branch — so `equals`, `not`,
 * `in`, `notIn`, `gt`, `gte` and the rest all had to be assignable to `never`,
 * and the operator-object form was gone from every `Int`, `Float`, `BigInt`,
 * `DateTime`, `Boolean` and `Bytes` column. Only the bare-value shorthand and
 * `String`'s own operators survived.
 *
 * `Record<never, never>` says what was meant: no keys at all. `keyof` it is
 * `never`, so it contributes nothing to the intersection and costs none of the
 * precision the split exists for — `{ id: { contains: "x" } }` on an `Int` is
 * still an error, as `filters.test-d.ts` asserts.
 */
type NoKeys = Record<never, never>;

type OrderingFilter<V> = NonNullable<V> extends Comparable
  ? {
      lt?: NonNullable<V>;
      lte?: NonNullable<V>;
      gt?: NonNullable<V>;
      gte?: NonNullable<V>;
    }
  : NoKeys;

type StringFilter<V> = NonNullable<V> extends string
  ? {
      contains?: string;
      startsWith?: string;
      endsWith?: string;
      /** Postgres only; `SqliteDialect` refuses it, naming the dialect. */
      mode?: "default" | "insensitive";
    }
  : NoKeys;

type NestedFilter<V> = BaseFilter<V> & OrderingFilter<V> & StringFilter<V>;

/**
 * What each scalar-list filter compares against.
 *
 * `has` asks about one element and `isEmpty` about the array's length; the
 * other three take a whole array. Split out so {@link ListFilter} can be a
 * mapped type — the operand still has to be stated per operator, but *which
 * operators exist* is no longer stated twice.
 */
type ListFilterOperand<K extends ListFilterName, E> = K extends "has"
  ? E
  : K extends "isEmpty"
    ? boolean
    : E[];

/**
 * The filters that apply to a **scalar list** — `tags String[]`.
 *
 * A different set on a different left-hand side, and the set is
 * `LIST_FILTER_NAMES` in the where compiler — read from there rather than
 * mirrored, which is what this comment used to claim it did. Postgres only:
 * `SqliteDialect.listFilters` refuses the column outright, because SQLite has
 * no array type.
 */
type ListFilter<E> = {
  [K in ListFilterName]?: ListFilterOperand<K, E>;
};

/**
 * `Json` filters, which are a comparison against one of the column's empty
 * states as often as against a value.
 *
 * `AnyNull` is accepted here and nowhere else: it asks "either kind of empty",
 * which is a question rather than a value, and the write paths refuse it.
 *
 * **`equals: null` is refused at runtime and cannot be refused here.** A `Json`
 * column has two empty states and the filter has to say which, so the compiler
 * raises `InvalidArgumentError` naming the explicit form — but the type cannot
 * express it, because `JsonValue` minus `null` still contains
 * `{ [key: string]: JsonValue }`, and `{ equals: null }` is itself a valid JSON
 * object. Prisma has the same gap. Stated rather than papered over: a comment
 * claiming the type rejects it would be read as a guarantee.
 *
 * **This is the filter on the *column*, which is why `path` is excluded.** A
 * `path` sends the whole operand to `compileJsonFilter`, where the sentinels are
 * refused — `#>>` cannot tell an absent key from a JSON `null`. Without the
 * `path?: never`, `{ path: […], equals: DbNull }` landed here instead of on
 * `JsonPathFilter`, because a union ignores a property one member declares and
 * excess-property checking counts it known if *any* member has it.
 *
 * **`equals` and `not` are asymmetric, and the compiler is what makes them so.**
 * `equals` binds its operand as a *value*, so an object under it is a document
 * — `{ equals: { a: 1 } }` compiles to `"metadata" = $1::text::jsonb`. `not`
 * delegates to `compileNot`, which sends any object operand back through
 * `compileFieldFilter` as a *nested filter*: `{ not: { equals: { a: 1 } } }`
 * compiles, `{ not: { path: […], equals: 1 } }` compiles to a negated path
 * filter, and `{ not: { a: 1 } }` raises on the key `a`. So `not` recurses here
 * and `equals` does not. Measured against `compileRead`, not inferred.
 */
type JsonFilter = {
  path?: never;
  equals?: JsonValue | DbNullValue | JsonNullValue | AnyNullValue;
  not?:
    | JsonValueOperand
    | DbNullValue
    | JsonNullValue
    | AnyNullValue
    | JsonFilter
    | JsonPathFilter;
};

/**
 * `JsonValue`'s object member, named so that `JsonValueOperand` can subtract it.
 */
type JsonObject = { [key: string]: JsonValue };

/**
 * Where inside the document to look — and it is **one union covering two
 * dialects**, which each refuse the other's half at runtime.
 *
 * Postgres takes `["a", "b"]` and refuses a string; SQLite takes `"$.a.b"` and
 * refuses an array. That is Prisma's own split, measured on both through a
 * generated client, and `assertPathShape` reproduces it with a message naming
 * which form *this* database wants.
 *
 * **Typed flat rather than per-dialect, deliberately.** The generated artifact
 * is dialect-agnostic — `ModelTypeInfo` records no dialect, and the dialect is
 * chosen from `DATABASE_URL` at connect time — so there is nothing for a
 * dialect-shaped type to read, and shaping it would mean threading a parameter
 * the generator does not know through every model, every `WhereInput` and every
 * call site. It is also how this file already handles the same divergence
 * elsewhere: `mode: "insensitive"` is Postgres-only and is a flat property with
 * a comment, and `ListFilter` is offered on both dialects though SQLite has no
 * array type to answer it with. The dialect refusal stays where it can name the
 * dialect and say "it works on postgres".
 *
 * **Every segment is a string, and #371 is what settled that.** This type
 * briefly read `readonly (string | number)[]`, because `assertPathShape`
 * accepted a numeric segment and a type-only change could not remove a superset
 * the compiler had. `assertPathShape` refuses one now — Prisma's generated
 * `path` is `string[]` and its client refuses a number at run time too
 * (*"Argument `path`: Invalid value provided. Expected String, provided Int."*,
 * measured on 6.19.2) — so the two agree again, and they agree on the narrow
 * side for the reason this file gives everywhere else: answering a query the
 * oracle cannot is "precisely where a differential test stops being able to
 * check anything". Nothing is lost, because `["items", "0"]` reaches the same
 * array element on Postgres: `#>` takes a `text[]`, so the segment arrives as
 * text either way.
 *
 * **`readonly`, because a path is the natural thing to hoist.**
 * `const PATH = ["operation"] as const` and a whole filter object written
 * `as const` both produce a `readonly` tuple. `assertPathShape` uses
 * `Array.isArray` and `.findIndex`, which a frozen array answers, and the path
 * is bound rather than mutated. A mutable array still assigns to a `readonly`
 * parameter, so nothing that compiled before stops.
 */
type JsonPath = string | readonly string[];

/**
 * A scalar a JSON path filter can be compared against.
 *
 * `assertJsonOperand`'s rule: `equals`, `not` and the four comparisons compile
 * to one bound value against one extracted value, so an object or array operand
 * "would bind as '[object Object]' and match nothing" and is refused. That is a
 * refusal rather than a gap — answering it properly needs the `#> … ::jsonb`
 * form, which is Postgres-only — so the type says the same thing rather than
 * offering a query only one dialect could answer.
 *
 * **The sentinels are absent, and their absence is the point.** `DbNull`,
 * `JsonNull` and `AnyNull` are refused at a path by `compileJsonFilter`, because
 * `#>>` yields SQL NULL for an absent key and for a JSON `null` alike — the
 * distinction the sentinels exist to draw is gone before the comparison
 * happens. They stay on `JsonFilter`, which compiles against the column, where
 * the distinction survives.
 *
 * **`null` is absent too, and the compiler now agrees — #371.** This comment
 * used to record it as the one place the type went further than the runtime:
 * `assertJsonOperand` let `null` through and `{ path: […], equals: null }`
 * compiled to `("metadata" #>> $1) = $2` bound to NULL, which is NULL rather
 * than true on both dialects — a predicate no row can satisfy. It is an
 * `InvalidArgumentError` now, so a `null` arriving dynamically is refused
 * rather than silently answered wrong.
 *
 * The refusal is a *divergence*, not a gap in the type. Prisma extracts with
 * `#>` and compares as `jsonb`, so it reads `equals: null` as the JSON value
 * `null` and returns the rows holding one — measured on 6.19.2, identical SQL
 * and identical rows to `equals: Prisma.JsonNull`. gemi extracts with `#>>`,
 * which yields SQL NULL for an absent key and a JSON null alike, so the
 * question cannot be asked at a path here at all — the same collapse that
 * keeps the sentinels off this type.
 */
type JsonPathScalar = string | number | boolean;

/**
 * `where: { metadata: { path: …, equals: … } }` — a filter on a value *inside*
 * the document rather than on the column.
 *
 * The operator set **is** `JSON_FILTER_NAMES` in `compile/where.ts`, all ten of
 * them — mapped over rather than copied, so the compiler's list is this type's
 * list (#369). The operand types are `assertJsonOperand`'s. `array_contains` is
 * the one that takes a document, because containment is the operator that means
 * one.
 *
 * **`path` is required, and that is what makes the union above discriminate.**
 * `compileFieldFilter` dispatches on `filter.path !== undefined`: an operand
 * carrying a `path` *is* a path filter to the compiler, whatever else is in it.
 * A JSON document with a top-level `path` key therefore has to be written
 * `{ equals: { path: … } }` — which is the only spelling that ever worked, since
 * an object operand is a filter here and never a document.
 *
 * Every operator is optional, so `{ path: ["a"] }` alone still type-checks and
 * still raises Prisma's *"A JSON path cannot be set without a scalar filter."*
 * Requiring one would mean a ten-way union in the position where the compiler
 * reports a misspelled operator, and the runtime message already names the whole
 * set. Prisma's generated input has the same shape for the same reason.
 *
 * **Writing `undefined` is writing nothing**, on every operator, which is what
 * `?:` already says and what `compileJsonFilter` now does — a key holding
 * `undefined` is dropped before the bare-path check, so
 * `{ path: ["a"], equals: undefined }` raises the same refusal as
 * `{ path: ["a"] }`. That is Prisma's answer to both, measured.
 */
type JsonPathFilter = { path: JsonPath } & {
  [K in JsonFilterName]?: JsonPathOperand<K>;
};

/**
 * What each JSON path operator compares the extracted value against, which is
 * `assertJsonOperand`'s rule restated as a type.
 *
 * Three answers for ten operators: the `string_*` three build a `like` pattern
 * and so need a string; `array_contains` is the one operator whose operand is a
 * *document*, because containment is the question that means one; the remaining
 * six compare one bound scalar against one extracted value.
 *
 * The default arm is `JsonPathScalar` rather than `never` deliberately. An
 * eleventh operator added to `JSON_FILTER_NAMES` lands here with the operand
 * type five of the current six have, which is the likeliest right answer and is
 * in any case *usable* — where a `never` would give the new operator a key
 * nothing can be passed under, which is a quieter kind of wrong than the one
 * this change removes.
 *
 * **`array_contains` takes a document but not a bare `null`.** It is the one
 * operator `assertJsonOperand` waves through without a scalar check, so a bare
 * `null` reaches `dialect.jsonArrayContains` and binds as SQL NULL — and
 * `x @> NULL` is NULL, not false, so the filter silently matches no row rather
 * than asking anything. A `null` *inside* the document is fine and stays
 * expressible; only the top-level operand is excluded. (#380 found this and
 * narrows the same property on the hand-written literal this mapped type
 * replaces; the narrowing lives on the arm here so the two do not resolve to
 * whichever side of the merge is taken.)
 */
type JsonPathOperand<K extends JsonFilterName> = K extends "array_contains"
  ? Exclude<JsonValue, null>
  : K extends "string_contains" | "string_starts_with" | "string_ends_with"
    ? string
    : JsonPathScalar;

/**
 * The bare-value half of a `Json` column's filter — **`JsonValue` with its
 * object member removed**, and that removal is the whole fix for #336, not the
 * operators.
 *
 * `JsonValue` contains `{ [key: string]: JsonValue }`, so before this any object
 * literal at all satisfied the value arm, a union permits a property present in
 * any member, and excess-property checking never fired. Adding `path` and the
 * operators to a sibling arm does nothing on its own: `{ path: 123, notAFilter:
 * true }` is a perfectly good JSON *document* and would go on compiling. The
 * union has to stop being able to absorb it.
 *
 * **The object member is not merely absorbing — it was never true.** `where` has
 * no bare-document branch for a `Json` column. `isFilterObject` reports any
 * non-`Date`, non-array object as a filter, so `{ metadata: { a: 1 } }` reaches
 * the scalar operator loop and raises *"A scalar filter takes contains,
 * endsWith, equals, …"* on the key `a`. Only scalars and arrays fall through to
 * `equals`, which is exactly what is left here. Measured against `compileRead`
 * on Postgres, not read off the code:
 *
 * | operand | compiler |
 * | --- | --- |
 * | `{ metadata: "s" }`, `{ metadata: [1, 2] }` | `"metadata" = $1::text::jsonb` |
 * | `{ metadata: { equals: { a: 1 } } }` | `"metadata" = $1::text::jsonb` |
 * | `{ metadata: { a: 1 } }` | `InvalidArgumentError` on `where.metadata.a` |
 *
 * So the document goes under `equals`, which is the only spelling `docs/orm.md`
 * has ever shown. An earlier draft of this type kept the object member with
 * `path?: never` intersected onto it — clever, and its entire effect was to go
 * on admitting operands that always throw.
 */
type JsonValueOperand = Exclude<JsonValue, JsonObject>;

/**
 * A filter on one column.
 *
 * The bare value is accepted alongside the operator object because
 * `{ email: "a@b.c" }` is how a filter is usually written; the compiler reads it
 * as `equals`.
 *
 * `Json` is tested before the list branch and not after it, because `JsonValue`
 * *includes* arrays — a `Json` column reaching the list branch would be offered
 * `has` and `hasEvery`, which the compiler answers for a `String[]` and refuses
 * here.
 */
export type FieldFilter<V> =
  IsJson<V> extends true
    ?
        | JsonValueOperand
        | DbNullValue
        | JsonNullValue
        | JsonFilter
        | JsonPathFilter
    : [NonNullable<V>] extends [Array<infer E>]
      ? E[] | ListFilter<E>
      : V | NestedFilter<V>;

/**
 * The operator names are `relation-filters.ts`'s two tuples, which is the same
 * pair `readOperators` iterates and `isOperatorForm` tests against — so the
 * grammar the caller may write and the grammar the compiler recognises are one
 * list (#369).
 *
 * `relation-filters.ts` already existed to stop the where compiler and the
 * policy walk disagreeing about this shape; the type was the third party to
 * that agreement and was not in it.
 */
type RelationFilter<R extends RelationInfo> = R["kind"] extends "many"
  ? { [K in ManyRelationOperator]?: WhereInput<R["target"]> }
  : /**
     * A to-one takes the nested `where` directly — `{ user: { email } }` means
     * `is` — and takes `null` for "there is no related row". `readOperators` in
     * the where compiler folds the two spellings together.
     */
    | WhereInput<R["target"]>
      | { [K in OneRelationOperator]?: WhereInput<R["target"]> | null }
      | (R["nullable"] extends true ? null : never);

export type WhereInput<M extends ModelTypeInfo> = {
  AND?: WhereInput<M> | WhereInput<M>[];
  OR?: WhereInput<M>[];
  NOT?: WhereInput<M> | WhereInput<M>[];
} & {
  [K in keyof Scalars<M>]?: FieldFilter<Scalars<M>[K]>;
} & {
  [K in keyof Relations<M>]?: RelationFilter<Relations<M>[K]>;
};

/**
 * `findUnique`'s `where`: at least one unique selector, plus any further filter.
 *
 * The union comes from the generator, which reads `@id`, `@unique` and
 * `@@unique` off the DMMF — including the compound spelling Prisma exposes as a
 * single key, `provider_providerId`, which `compile/unique.ts` resolves.
 */
export type WhereUniqueInput<M extends ModelTypeInfo> = M["unique"] &
  Partial<WhereInput<M>>;

// ---------------------------------------------------------------------------
// Ordering and selection
// ---------------------------------------------------------------------------

export type SortOrder = "asc" | "desc";

/** Where nulls sort, relative to every non-null value. */
export type NullsOrder = "first" | "last";

/**
 * A direction, or a direction that says where nulls go.
 *
 * The long form was parsed and compiled long before it could be written:
 * `parseOrderBy` has always accepted `{ sort, nulls }`, `compileOrderBy` emits
 * the standard `nulls first` / `nulls last` on both dialects, and `reverse()`
 * flips the placement along with the direction for a negative `take`. This type
 * said `"asc" | "desc"` and was the only thing refusing it (#337) — the same
 * divergence as the filtered `_count` two sections down.
 *
 * It is worth writing even where the dialect's default already agrees. Postgres
 * sorts nulls above every non-null, so `asc` already means `nulls last` and the
 * emitted SQL is equivalent — but the query is then resting on that default
 * rather than saying what it means, and under `desc` the same default means the
 * opposite. Saying it makes the intent survive a reordering.
 */
export type SortOrderInput = SortOrder | { sort: SortOrder; nulls?: NullsOrder };

/**
 * Ordering, one level.
 *
 * The relation arm's `_count` is offered only on a to-many, for the reason
 * `CountSelection` gives and reusing its type so the two say the same thing:
 * `relationOrderExpression` throws for a to-one, since ordering by a count of
 * 0 or 1 is ordering by the relation's own nullability. The runtime error names
 * the fields to order by instead.
 */
export type OrderByInput<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]?: SortOrderInput;
} & {
  [K in keyof Relations<M>]?:
    | {
        _count?: Relations<M>[K]["kind"] extends "many"
          ? SortOrderInput
          : ToOneRelationsCannotBeCounted;
      }
    | OrderByInput<Relations<M>[K]["target"]>;
};

/**
 * What `_count` accepts per relation: `true`, or a filter over the rows counted.
 *
 * The filter half was emitted long before it could be written. `compileRelationCount`
 * reaches for `_count.select.<relation>.where` and ANDs it into the correlated
 * subquery, so the SQL for a filtered count has always been correct; this type
 * said `boolean` and was the only thing refusing it (#333). The gap mattered
 * because the wrong answer is silent — a card counting soft-deleted rows renders
 * a number that is simply wrong, not one that fails.
 *
 * Shared by `SelectInput` and `IncludeInput` rather than written twice, because
 * the two spellings of the same argument disagreeing is how it went unnoticed.
 *
 * A to-one is refused, because `countPlan` throws `UnsupportedQueryError` for
 * one: the answer is 0 or 1, which the relation's own nullability already says.
 * That is the same type-does-not-describe-the-compiler gap as the `where` above,
 * in the other direction — accepting what the runtime rejects rather than
 * rejecting what it accepts.
 *
 * **Why the branded type rather than dropping the key.** Remapping the to-one
 * keys to `never` reads better and gives a better message, and it has a hole: a
 * model whose relations are *all* to-one maps to `{}`, and every object literal
 * is assignable to `{}` — so on exactly the models where counting is most
 * obviously wrong, nothing is checked. Keeping the key and making its value
 * uninhabitable holds either way. The alias exists only so the error names the
 * reason; `never` alone prints as "not assignable to type 'undefined'", which
 * sends the reader looking for a missing value rather than a bad key.
 */
type ToOneRelationsCannotBeCounted = {
  "counting a to-one relation can only answer 0 or 1": never;
};

type CountSelection<M extends ModelTypeInfo> = {
  [K in keyof Relations<M>]?: Relations<M>[K]["kind"] extends "many"
    ? boolean | { where?: WhereInput<Relations<M>[K]["target"]> }
    : ToOneRelationsCannotBeCounted;
};

/**
 * The relation names `_count: true` expands to — the type-level statement of
 * `countableRelations`, which the compiler and the policy walk derive at runtime.
 */
type CountableRelationNames<M extends ModelTypeInfo> = {
  [K in keyof Relations<M>]: Relations<M>[K]["kind"] extends "many" ? K : never;
}[keyof Relations<M>];

/**
 * The same device as {@link ToOneRelationsCannotBeCounted}, for the model that
 * has nothing to count at all rather than the relation that cannot be counted.
 */
type ThereIsNothingToCount = {
  "this model has no to-many relations, so there is nothing to count": never;
};

/**
 * What the `_count: true` shorthand accepts, per model.
 *
 * `readCountSelection` throws when the model has no to-many relation, so the key
 * has to be refused here or the shorthand becomes exactly the defect it was
 * implemented to close: valid TypeScript that raises on every call. #394 is a
 * report of that shape — a controller ported from Prisma type-checked, passed
 * review and 500'd on every request — and closing it only for models that do
 * have a to-many would have moved the trap rather than removed it. Prisma refuses
 * the same call structurally: it emits no `_count` key in the input type for such
 * a model.
 *
 * `false` stays legal either way. `planRelationCounts` short-circuits on it
 * before ever reaching the throw, so a caller toggling a count off with a flag is
 * writing something that works, on every model.
 *
 * `[…] extends […]` rather than a bare conditional, because a naked type
 * parameter distributes over the union of relation names and would answer per
 * relation instead of once per model.
 */
type CountShorthand<M extends ModelTypeInfo> = [
  CountableRelationNames<M>,
] extends [never]
  ? false | ThereIsNothingToCount
  : boolean;

/**
 * `select`, one level. Relations carry their own nested arguments, so the type
 * is mutually recursive with the operation args — bounded, as ever, by what the
 * caller wrote.
 */
export type SelectInput<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]?: boolean;
} & {
  [K in keyof Relations<M>]?: boolean | RelationArgs<Relations<M>[K]>;
} & {
  _count?: CountShorthand<M> | { select?: CountSelection<M> };
};

export type IncludeInput<M extends ModelTypeInfo> = {
  [K in keyof Relations<M>]?: boolean | RelationArgs<Relations<M>[K]>;
} & {
  _count?: CountShorthand<M> | { select?: CountSelection<M> };
};

export type OmitInput<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]?: boolean;
};

/**
 * The arguments a relation accepts inside a `select` or an `include`.
 *
 * A to-many takes the paging and filtering surface; a to-one takes only the
 * selection, since there is at most one row to shape.
 */
type RelationArgs<R extends RelationInfo> = R["kind"] extends "many"
  ? {
      select?: SelectInput<R["target"]>;
      include?: IncludeInput<R["target"]>;
      omit?: OmitInput<R["target"]>;
      where?: WhereInput<R["target"]>;
      orderBy?: OrderByInput<R["target"]> | OrderByInput<R["target"]>[];
      take?: number;
      skip?: number;
    }
  : {
      select?: SelectInput<R["target"]>;
      include?: IncludeInput<R["target"]>;
      omit?: OmitInput<R["target"]>;
    };

// ---------------------------------------------------------------------------
// Read arguments
//
// The key sets mirror `READ_ARGS` in `compile/read.ts` exactly. `distinct` and
// `cursor` are absent on purpose and permanently: both are refused at runtime
// with a message explaining what to reach for instead, and Prisma's types
// admitting them is precisely the kind of type-checked-but-throws divergence
// owning these types removes.
// ---------------------------------------------------------------------------

interface Selection<M extends ModelTypeInfo> {
  select?: SelectInput<M>;
  include?: IncludeInput<M>;
  omit?: OmitInput<M>;
}

export interface FindManyArgs<M extends ModelTypeInfo> extends Selection<M> {
  where?: WhereInput<M>;
  orderBy?: OrderByInput<M> | OrderByInput<M>[];
  skip?: number;
  take?: number;
}

export type FindFirstArgs<M extends ModelTypeInfo> = FindManyArgs<M>;
export type FindFirstOrThrowArgs<M extends ModelTypeInfo> = FindManyArgs<M>;

export interface FindUniqueArgs<M extends ModelTypeInfo> extends Selection<M> {
  where: WhereUniqueInput<M>;
}

export type FindUniqueOrThrowArgs<M extends ModelTypeInfo> = FindUniqueArgs<M>;

// ---------------------------------------------------------------------------
// Write arguments
// ---------------------------------------------------------------------------

/**
 * The statements a nested write may name **under a `create`**, which is
 * `SUPPORTED` minus `EXISTING_ROW_ONLY` in `compile/nested-writes.ts` —
 * subtracted rather than listed again, so the two files cannot answer
 * differently (#369). Concretely: `connect`, `connectOrCreate`, `create`,
 * `createMany`.
 *
 * The subtraction is the compiler's own reasoning, not an approximation of it.
 * `assertNestedOperand` refuses an `EXISTING_ROW_ONLY` key whenever the
 * operation is a `create`, because there is nothing linked to a row that does
 * not exist yet.
 */
type NestedCreateStatement = Exclude<NestedWriteStatement, ExistingRowStatement>;

/**
 * What each statement's operand is on a **to-many**.
 *
 * The `| T[]` on nearly every arm is Prisma's own shape and the compiler's:
 * `listOf` accepts a single object or an array of them everywhere a collection
 * is being written.
 *
 * A statement added to `SUPPORTED_STATEMENTS` with no arm here resolves to
 * {@link NestedStatementHasNoOperandType}, whose one property is a sentence —
 * the same device `AggregateNeedsArithmetic` uses two sections down, and for
 * the same reason: an optional `never` reports *"not assignable to type
 * 'undefined'"*, which says nothing about what went wrong.
 */
type ManyNestedOperand<
  K extends NestedWriteStatement,
  M extends ModelTypeInfo,
> = K extends "create"
  ? CreateInput<M> | CreateInput<M>[]
  : K extends "createMany"
    ? { data: CreateInput<M>[]; skipDuplicates?: boolean }
    : K extends "connect" | "set" | "disconnect" | "delete"
      ? WhereUniqueInput<M> | WhereUniqueInput<M>[]
      : K extends "connectOrCreate"
        ? ConnectOrCreate<M> | ConnectOrCreate<M>[]
        : K extends "deleteMany"
          ? WhereInput<M> | WhereInput<M>[]
          : K extends "update"
            ? NestedUpdateOne<M> | NestedUpdateOne<M>[]
            : K extends "updateMany"
              ? NestedUpdateMany<M> | NestedUpdateMany<M>[]
              : K extends "upsert"
                ? NestedUpsert<M> | NestedUpsert<M>[]
                : NestedStatementHasNoOperandType;

/**
 * ...and on a **to-one**, where four statements do not exist at all and none of
 * the rest takes an array — there is one related row, so there is nothing for a
 * list of operands to address, and `planForeignSide` refuses one by name.
 *
 * Three differ in more than that. `disconnect` and `delete` take a boolean —
 * "the link, whatever it points at" — where a to-many has to say *which* rows;
 * and `update` takes the bare `data` as well as `{ where?, data }`, because the
 * parent's key already names the row.
 */
type OneNestedOperand<
  K extends Exclude<NestedWriteStatement, CollectionOnlyStatement>,
  M extends ModelTypeInfo,
> = K extends "create"
  ? CreateInput<M>
  : K extends "connect"
    ? WhereUniqueInput<M>
    : K extends "connectOrCreate"
      ? ConnectOrCreate<M>
      : K extends "disconnect" | "delete"
        ? boolean | WhereInput<M>
        : K extends "update"
          ? UpdateInput<M> | NestedUpdateToOne<M>
          : K extends "upsert"
            ? NestedUpsertToOne<M>
            : NestedStatementHasNoOperandType;

/** @see {@link ManyNestedOperand} */
type NestedStatementHasNoOperandType = {
  "this nested-write statement is in SUPPORTED_STATEMENTS but has no operand type here": never;
};

/**
 * The nested write statements a `create`'s `data` may carry.
 *
 * A to-one cannot take the collection-shaped ones, which is the only structural
 * difference between the two sides — and `COLLECTION_ONLY_STATEMENTS` is the
 * list both planners refuse there, subtracted rather than restated.
 */
type NestedCreate<R extends RelationInfo> = R["kind"] extends "many"
  ? { [K in NestedCreateStatement]?: ManyNestedOperand<K, R["target"]> }
  : {
      [K in Exclude<
        NestedCreateStatement,
        CollectionOnlyStatement
      >]?: OneNestedOperand<K, R["target"]>;
    };

interface ConnectOrCreate<M extends ModelTypeInfo> {
  where: WhereUniqueInput<M>;
  create: CreateInput<M>;
}

/**
 * An `update`'s `data` carries the whole of `SUPPORTED_STATEMENTS`, so this is
 * the unsubtracted set rather than `NestedCreate` intersected with the rest.
 *
 * Stated as one mapped type for a reason beyond brevity: written as an
 * intersection, the create-half and the update-half were two places a
 * statement's operand could be given, and a statement listed in both with
 * different operands would silently intersect to something neither file meant.
 */
type NestedUpdate<R extends RelationInfo> = R["kind"] extends "many"
  ? { [K in NestedWriteStatement]?: ManyNestedOperand<K, R["target"]> }
  : {
      [K in Exclude<
        NestedWriteStatement,
        CollectionOnlyStatement
      >]?: OneNestedOperand<K, R["target"]>;
    };

interface NestedUpdateOne<M extends ModelTypeInfo> {
  where: WhereUniqueInput<M>;
  data: UpdateInput<M>;
}

/**
 * The to-one forms of `update` and `upsert`, which are **not** the to-many ones
 * with a key made optional.
 *
 * Both take a `WhereInput` rather than a `WhereUniqueInput`, and on both it is
 * optional. That is Prisma's own split, read off a generated client:
 * `UpdateToOneWithWhereWithoutUserInput` is `{ where?: ProfileWhereInput, data }`
 * and `ProfileUpsertWithoutUserInput` is `{ update, create, where? }`, where
 * their to-many siblings require a unique key. The parent's key already names
 * the row here, so the filter only narrows it — and typing it as a unique key
 * would refuse `update: { where: { bio: "x" }, data }`, which the compiler
 * accepts and Prisma answers.
 */
interface NestedUpdateToOne<M extends ModelTypeInfo> {
  where?: WhereInput<M>;
  data: UpdateInput<M>;
}

interface NestedUpsertToOne<M extends ModelTypeInfo> {
  where?: WhereInput<M>;
  create: CreateInput<M>;
  update: UpdateInput<M>;
}

interface NestedUpdateMany<M extends ModelTypeInfo> {
  where: WhereInput<M>;
  data: UpdateInput<M>;
}

interface NestedUpsert<M extends ModelTypeInfo> {
  where: WhereUniqueInput<M>;
  create: CreateInput<M>;
  update: UpdateInput<M>;
}

/**
 * `create`'s `data`: the generator's scalar split, with the relation half laid
 * over it.
 */
export type CreateInput<M extends ModelTypeInfo> = M["create"] & {
  [K in keyof Relations<M>]?: NestedCreate<Relations<M>[K]>;
};

/** Numeric columns accept Prisma's atomic update operators. */
type AtomicNumber = {
  set?: number;
  increment?: number;
  decrement?: number;
  multiply?: number;
  divide?: number;
};

type UpdateField<V> =
  IsJson<V> extends true
    ? JsonInput
    : [NonNullable<V>] extends [number]
      ? V | AtomicNumber
      : [NonNullable<V>] extends [Array<infer E>]
        ? E[] | { set?: E[]; push?: E | E[] }
        : V | { set?: V };

export type UpdateInput<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]?: UpdateField<Scalars<M>[K]>;
} & {
  [K in keyof Relations<M>]?: NestedUpdate<Relations<M>[K]>;
};

export interface CreateArgs<M extends ModelTypeInfo> extends Selection<M> {
  data: CreateInput<M>;
}

export interface UpdateArgs<M extends ModelTypeInfo> extends Selection<M> {
  data: UpdateInput<M>;
  where: WhereUniqueInput<M>;
}

export interface DeleteArgs<M extends ModelTypeInfo> extends Selection<M> {
  where: WhereUniqueInput<M>;
}

export interface UpsertArgs<M extends ModelTypeInfo> extends Selection<M> {
  where: WhereUniqueInput<M>;
  create: CreateInput<M>;
  update: UpdateInput<M>;
}

export interface CreateManyArgs<M extends ModelTypeInfo> {
  data: CreateInput<M> | CreateInput<M>[];
  skipDuplicates?: boolean;
}

export interface UpdateManyArgs<M extends ModelTypeInfo> {
  data: UpdateInput<M>;
  where?: WhereInput<M>;
}

export interface DeleteManyArgs<M extends ModelTypeInfo> {
  where?: WhereInput<M>;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/** `_sum` and `_avg` need arithmetic — `NUMERIC` in `compile/aggregate.ts`. */
type NumericKeys<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]: NonNullable<Scalars<M>[K]> extends number | bigint
    ? K
    : never;
}[keyof Scalars<M>];

/** `_min` / `_max` need an ordering, which `Json` and `Bytes` have on neither dialect. */
type OrderableKeys<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]: NonNullable<Scalars<M>[K]> extends Comparable
    ? K
    : never;
}[keyof Scalars<M>];

type CountSelect<M extends ModelTypeInfo> = { _all?: true } & {
  [K in keyof Scalars<M>]?: true;
};

export interface AggregateArgs<M extends ModelTypeInfo> {
  where?: WhereInput<M>;
  orderBy?: OrderByInput<M> | OrderByInput<M>[];
  skip?: number;
  take?: number;
  _count?: true | CountSelect<M>;
  _avg?: { [K in NumericKeys<M>]?: true };
  _sum?: { [K in NumericKeys<M>]?: true };
  _min?: { [K in OrderableKeys<M>]?: true };
  _max?: { [K in OrderableKeys<M>]?: true };
}

/**
 * Every aggregate over an empty set is `null` — per field, inside its object —
 * except `_count`, which is `0`. `compile/aggregate.ts` says the same from the
 * runtime side, and it is why each member below carries `| null`.
 */
type CountResult<A> = A extends true ? number : { [K in Requested<A>]: number };

/** `avg` is a division, so it is a float whatever the column was. */
type AvgResult<A> = { [K in Requested<A>]: number | null };

/** `_sum`, `_min` and `_max` keep the column's own type, minus its nullability. */
type FieldwiseResult<M extends ModelTypeInfo, A> = {
  [K in Requested<A> & keyof Scalars<M>]: NonNullable<Scalars<M>[K]> | null;
};

export type AggregatePayload<M extends ModelTypeInfo, A> = {
  [K in keyof A &
    ("_count" | "_avg" | "_sum" | "_min" | "_max")]: K extends "_count"
    ? CountResult<A[K]>
    : K extends "_avg"
      ? AvgResult<A[K]>
      : FieldwiseResult<M, A[K]>;
};

/**
 * `count`'s object form: the caller's `select` mapped to numbers.
 *
 * Prisma spells this `GetScalarType<T["select"], <M>CountAggregateOutputType>`;
 * the shape is the same and the second parameter carries no information the
 * first does not, so it takes one.
 */
export type CountPayload<S> = { [K in Requested<S>]: number };

export interface CountArgs<M extends ModelTypeInfo> {
  where?: WhereInput<M>;
  orderBy?: OrderByInput<M> | OrderByInput<M>[];
  skip?: number;
  take?: number;
  select?: CountSelect<M>;
}

/**
 * `groupBy`'s ordering grammar, which is a different grammar from `findMany`'s
 * rather than a wider one — which is why #340 could not be closed the way #337
 * was, by widening the type the two share.
 *
 * Two arms:
 *
 * - a **column**, ordered as anywhere else;
 * - an **aggregate** — `orderBy: { _count: { role: "desc" } }`, the
 *   top-N-by-count query `groupBy` mostly exists for. `findMany` has no notion
 *   of one, so putting this on `OrderByInput` would have offered an ordering
 *   there that `compileOrderBy` throws on.
 *
 * Which fields each kind takes is `assertAggregable`'s rule, reusing
 * `AggregateArgs`' own key sets so the two cannot drift: `count` applies to
 * anything, `_sum`/`_avg` need arithmetic, `_min`/`_max` need an ordering both
 * dialects agree on. `_all` is `_count`'s alone — it compiles to `count(*)`,
 * which names no column.
 *
 * Relations are absent because the compiler has no arm for them: an `orderBy`
 * key here is looked up in `schema.fields`, and a relation is not one, so it is
 * refused as an unknown field. `OrderByInput` accepted them.
 *
 * What this deliberately does not say is that a column has to be one of the
 * `by` ones. That depends on the `by` literal rather than on `M`, and
 * `bin/orm/emit.ts` records the reason it stays a runtime refusal: the
 * type-level form reports a mapped type, where `compile/group-by.ts` names the
 * field and says why. A worse-worded compile error is not an improvement.
 */
export type GroupByOrderByInput<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]?: SortOrderInput;
} & {
  _count?: { _all?: SortOrderInput } & {
    [K in keyof Scalars<M>]?: SortOrderInput;
  };
  _avg?: { [K in NumericKeys<M>]?: SortOrderInput };
  _sum?: { [K in NumericKeys<M>]?: SortOrderInput };
  _min?: { [K in OrderableKeys<M>]?: SortOrderInput };
  _max?: { [K in OrderableKeys<M>]?: SortOrderInput };
};

/**
 * The six comparisons a `having` operand takes, which **is** `OPERATORS` in
 * `compile/group-by.ts` and nothing else — its keys, mapped over, rather than
 * the same six names written out again beside a comment saying they match
 * (#369).
 *
 * Narrower than a `where`'s on purpose, because the compiler is: `having` walks
 * its own operand reader, so `contains`, `in`, `startsWith` and `mode` are not
 * offered here and throw *"A 'having' filter takes equals, gt, gte, lt, lte,
 * not"* if written. A bare value is `equals`, the shorthand `where` accepts too,
 * and `null` under `equals` / `not` becomes `is null` / `is not null` — which is
 * why those two alone widen by `null`, and the four orderings do not.
 */
type HavingComparison<V> = {
  [K in HavingOperator]?: K extends "equals" | "not" ? V | null : V;
};

type HavingFilter<V> = V | HavingComparison<V>;

type AggregateNeedsArithmetic = {
  "_sum and _avg need a number, and this column is not one": never;
};

type AggregateNeedsAnOrdering = {
  "_min and _max need an ordering both dialects have": never;
};

/**
 * A `having` filter on an aggregate *of* a column, rather than on the column.
 *
 * `count` and `avg` answer in their own type whatever the column was — a count
 * is an integer and an average is a division — so those compare against a
 * number. `_sum`, `_min` and `_max` keep the column's, which is `AggregatePayload`'s
 * rule from the other direction.
 *
 * The two refusals are named types rather than absent keys because a `never`
 * under an optional key reports *"not assignable to type 'undefined'"*, which
 * says nothing about arithmetic. This prints the sentence.
 */
type HavingAggregates<M extends ModelTypeInfo, K extends keyof Scalars<M>> = {
  _count?: HavingFilter<number>;
  _avg?: K extends NumericKeys<M>
    ? HavingFilter<number>
    : AggregateNeedsArithmetic;
  _sum?: K extends NumericKeys<M>
    ? HavingFilter<NonNullable<Scalars<M>[K]>>
    : AggregateNeedsArithmetic;
  _min?: K extends OrderableKeys<M>
    ? HavingFilter<NonNullable<Scalars<M>[K]>>
    : AggregateNeedsAnOrdering;
  _max?: K extends OrderableKeys<M>
    ? HavingFilter<NonNullable<Scalars<M>[K]>>
    : AggregateNeedsAnOrdering;
};

/**
 * `having`, which was the same divergence as `orderBy` one line below it.
 *
 * It borrowed `WhereInput`, and `compileHaving` is a second predicate compiler
 * rather than `compileWhere` with a flag — so the borrowed type was wrong in
 * three directions at once. It refused the aggregate filter that is the whole
 * point of a `having`:
 *
 *     having: { email: { _count: { gt: 1 } } }   // was TS2353, compiles and runs
 *
 * offered operators this compiler does not have (`contains`, `in`, `mode`), and
 * offered a relation arm, where a `having` key is resolved against
 * `schema.fields` and a relation is refused — *"aggregate its own model
 * instead"*.
 *
 * **Prisma's rule is an `or`**, and it is why the two arms are a union rather
 * than a choice made per field: *"every field used in `having` filters must
 * either be an aggregation filter or be included in the selection of the
 * query"*. A plain comparison needs its column in `by`; an aggregate one does
 * not, because `count(email)` has one value per group whether or not `email` is
 * grouped. Which of those applies depends on the operand, so it is `havingField`
 * that decides it at runtime — the same `by`-dependence `GroupByOrderByInput`
 * leaves alone, for the reason recorded there.
 *
 * One shape this still admits and the compiler still refuses: mixing the arms
 * under one key, `having: { role: { gt: 0, _count: { gt: 1 } } }`. TypeScript
 * relaxes excess-property checking against a union, so both keys are known to
 * *some* member and the literal passes. Prisma's query engine panics on that
 * shape rather than answering it, so `assertPureAggregate` refuses it by name
 * and says to spell it as an `AND`. Stated rather than papered over.
 */
export type GroupByHavingInput<M extends ModelTypeInfo> = {
  AND?: GroupByHavingInput<M> | GroupByHavingInput<M>[];
  OR?: GroupByHavingInput<M>[];
  NOT?: GroupByHavingInput<M> | GroupByHavingInput<M>[];
} & {
  [K in keyof Scalars<M>]?:
    | HavingFilter<Scalars<M>[K]>
    | HavingAggregates<M, K>;
};

export interface GroupByArgs<M extends ModelTypeInfo>
  extends Omit<AggregateArgs<M>, "orderBy"> {
  by: (keyof Scalars<M> & string)[] | (keyof Scalars<M> & string);
  having?: GroupByHavingInput<M>;
  orderBy?: GroupByOrderByInput<M> | GroupByOrderByInput<M>[];
}

type GroupedKeys<A> = A extends { by: infer B }
  ? B extends readonly (infer K)[]
    ? K
    : B
  : never;

export type GroupByPayload<M extends ModelTypeInfo, A> = ({
  [K in GroupedKeys<A> & keyof Scalars<M>]: Scalars<M>[K];
} & AggregatePayload<M, A>)[];
