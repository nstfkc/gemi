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

import type { AnyNullValue, DbNullValue, JsonNullValue } from "./json-null";

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
export type JsonInput = Exclude<JsonValue, null> | DbNullValue | JsonNullValue;

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
 * `Payload` asks `A extends { select: infer S }` and friends, and `unknown`
 * matches none of them, so it lands on the default selection. `{}` would too,
 * but only because an empty object type happens not to satisfy a required
 * property — a coincidence to rely on rather than a statement of intent.
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
 */
type RelationCountPayload<M extends ModelTypeInfo, A> = "select" extends keyof A
  ? { [K in Requested<NonNullable<A["select"]>> & keyof Relations<M>]: number }
  : { [K in keyof Relations<M>]: number };

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
 * leaves the relation's arguments in a shape that is *assignable* to
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

type OrderingFilter<V> =
  NonNullable<V> extends Comparable
    ? {
        lt?: NonNullable<V>;
        lte?: NonNullable<V>;
        gt?: NonNullable<V>;
        gte?: NonNullable<V>;
      }
    : NoKeys;

type StringFilter<V> =
  NonNullable<V> extends string
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
 * The filters that apply to a **scalar list** — `tags String[]`.
 *
 * A different set on a different left-hand side, mirroring `LIST_FILTERS` in
 * the where compiler. Postgres only: `SqliteDialect.listFilters` refuses the
 * column outright, because SQLite has no array type.
 */
type ListFilter<E> = {
  equals?: E[];
  has?: E;
  hasEvery?: E[];
  hasSome?: E[];
  isEmpty?: boolean;
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
 */
type JsonFilter = {
  equals?: JsonValue | DbNullValue | JsonNullValue | AnyNullValue;
  not?: JsonValue | DbNullValue | JsonNullValue | AnyNullValue;
};

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
    ? JsonValue | DbNullValue | JsonNullValue | JsonFilter
    : [NonNullable<V>] extends [Array<infer E>]
      ? E[] | ListFilter<E>
      : V | NestedFilter<V>;

type RelationFilter<R extends RelationInfo> = R["kind"] extends "many"
  ? {
      some?: WhereInput<R["target"]>;
      every?: WhereInput<R["target"]>;
      none?: WhereInput<R["target"]>;
    }
  : /**
       * A to-one takes the nested `where` directly — `{ user: { email } }` means
       * `is` — and takes `null` for "there is no related row". `readOperators` in
       * the where compiler folds the two spellings together.
       */
      | WhereInput<R["target"]>
      | {
          is?: WhereInput<R["target"]> | null;
          isNot?: WhereInput<R["target"]> | null;
        }
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

export type OrderByInput<M extends ModelTypeInfo> = {
  [K in keyof Scalars<M>]?: SortOrder;
} & {
  [K in keyof Relations<M>]?:
    | { _count?: SortOrder }
    | OrderByInput<Relations<M>[K]["target"]>;
};

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
  _count?: boolean | { select?: { [K in keyof Relations<M>]?: boolean } };
};

export type IncludeInput<M extends ModelTypeInfo> = {
  [K in keyof Relations<M>]?: boolean | RelationArgs<Relations<M>[K]>;
} & {
  _count?: boolean | { select?: { [K in keyof Relations<M>]?: boolean } };
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
 * The nested write statements, from `SUPPORTED` in `compile/nested-writes.ts`.
 *
 * A to-one cannot take the collection-shaped ones, which is the only structural
 * difference between the two sides.
 */
type NestedCreate<R extends RelationInfo> = R["kind"] extends "many"
  ? {
      create?: CreateInput<R["target"]> | CreateInput<R["target"]>[];
      createMany?: {
        data: CreateInput<R["target"]>[];
        skipDuplicates?: boolean;
      };
      connect?: WhereUniqueInput<R["target"]> | WhereUniqueInput<R["target"]>[];
      connectOrCreate?:
        | ConnectOrCreate<R["target"]>
        | ConnectOrCreate<R["target"]>[];
    }
  : {
      create?: CreateInput<R["target"]>;
      connect?: WhereUniqueInput<R["target"]>;
      connectOrCreate?: ConnectOrCreate<R["target"]>;
    };

interface ConnectOrCreate<M extends ModelTypeInfo> {
  where: WhereUniqueInput<M>;
  create: CreateInput<M>;
}

type NestedUpdate<R extends RelationInfo> = NestedCreate<R> &
  (R["kind"] extends "many"
    ? {
        set?: WhereUniqueInput<R["target"]> | WhereUniqueInput<R["target"]>[];
        disconnect?:
          | WhereUniqueInput<R["target"]>
          | WhereUniqueInput<R["target"]>[];
        delete?:
          | WhereUniqueInput<R["target"]>
          | WhereUniqueInput<R["target"]>[];
        deleteMany?: WhereInput<R["target"]> | WhereInput<R["target"]>[];
        update?: NestedUpdateOne<R["target"]> | NestedUpdateOne<R["target"]>[];
        updateMany?:
          | NestedUpdateMany<R["target"]>
          | NestedUpdateMany<R["target"]>[];
        upsert?: NestedUpsert<R["target"]> | NestedUpsert<R["target"]>[];
      }
    : {
        disconnect?: boolean | WhereUniqueInput<R["target"]>;
        delete?: boolean | WhereUniqueInput<R["target"]>;
        update?: UpdateInput<R["target"]> | NestedUpdateOne<R["target"]>;
        upsert?: Omit<NestedUpsert<R["target"]>, "where">;
      });

interface NestedUpdateOne<M extends ModelTypeInfo> {
  where: WhereUniqueInput<M>;
  data: UpdateInput<M>;
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

export interface GroupByArgs<M extends ModelTypeInfo> extends Omit<
  AggregateArgs<M>,
  "orderBy"
> {
  by: (keyof Scalars<M> & string)[] | (keyof Scalars<M> & string);
  having?: WhereInput<M>;
  orderBy?: OrderByInput<M> | OrderByInput<M>[];
}

type GroupedKeys<A> = A extends { by: infer B }
  ? B extends readonly (infer K)[]
    ? K
    : B
  : never;

export type GroupByPayload<M extends ModelTypeInfo, A> = ({
  [K in GroupedKeys<A> & keyof Scalars<M>]: Scalars<M>[K];
} & AggregatePayload<M, A>)[];
