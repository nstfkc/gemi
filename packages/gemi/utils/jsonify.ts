/**
 * What a value of type `T` is after `JSON.parse(JSON.stringify(value))`: the
 * type the browser holds for something the server sent as JSON (#1107).
 *
 * - `toJSON` is honoured: a `Date` is a `string`, and so is anything whose
 *   `toJSON()` returns one. A member whose `toJSON()` may answer `undefined`
 *   is optional, and gone when it always does.
 * - Object members that are `undefined`, functions or symbols are dropped; a
 *   member that may be `undefined` (or is `void`) is optional. Symbol keys are
 *   dropped.
 * - In arrays, those values become `null`, as `JSON.stringify` writes them.
 * - At the top level, `undefined` and `void` stay `undefined`:
 *   `JSON.stringify(undefined)` is `undefined`, and a tool output that may be
 *   missing is still one that may be missing (`Jsonify<Foo | undefined>` is
 *   `Jsonify<Foo> | undefined`).
 * - Getters are kept and class instances are read as their public members.
 *   At run time `JSON.stringify` writes only own enumerable properties, so an
 *   `Error` arrives as `{}`; give such types a `toJSON` if they cross.
 * - `Map` and `Set` have no own enumerable members and arrive as `{}`.
 * - `bigint` cannot be serialised (`JSON.stringify` throws) and is `never`.
 * - A type that is already JSON (assignable to `JsonValue`) is returned as
 *   it is, so its name survives in hovers and in errors.
 *
 * `any` stays `any` and `unknown` stays `unknown`. `NaN` and the infinities
 * become `null` at run time, which no type can see, so `number` stays `number`.
 */
export type Jsonify<T> = 0 extends 1 & T
  ? any
  : unknown extends T
    ? // Without `strictNullChecks`, `unknown` is assignable to a weak type
      // (every member optional, such as `{ a?: string }`), so this alone
      // would read those as `unknown`. Only a type with no keys is.
      [keyof T] extends [never]
      ? unknown
      : JsonifyKnown<T>
    : JsonifyKnown<T>;

type JsonifyKnown<T> = [T] extends [JsonSafe]
  ? T
  :
      // `undefined` (and `void`) at the top level is kept: `JSON.stringify`
      // answers `undefined` for it, so an output that may be missing stays
      // one that may be missing. Only inside objects and arrays is it
      // dropped or written as `null`.
      | JsonifyMember<Exclude<T, undefined | void>>
      | ([Extract<T, undefined | void>] extends [never] ? never : undefined);

/** What `JSON.stringify` drops from an object and writes as `null` in an array. */
type JsonDropped = undefined | void | symbol | ((...args: any[]) => unknown);

/** A member whose every value is dropped, so the key itself is gone. `void`
 *  is not here: a `void` member may still hold a value, so it is optional. */
type JsonGone = undefined | symbol | ((...args: any[]) => unknown);

type IsAny<T> = 0 extends 1 & T ? true : false;

/** The same union as `JsonValue` in `ai/Schema.ts`, kept here so `utils` does
 *  not import the ai module. */
type JsonSafe = string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe };

// Distributive: each member of a union is serialised on its own.
type JsonifyMember<T> = T extends string | number | boolean | null
  ? T
  : T extends JsonDropped | bigint
    ? never
    : T extends { toJSON(...args: any[]): infer J }
      ? Jsonify<J>
      : T extends readonly unknown[]
        ? { [I in keyof T]: JsonifyElement<T[I]> }
        : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
          ? Record<string, never>
          : T extends object
            ? JsonifyObject<T>
            : never;

type JsonifyElement<E> = [Extract<E, JsonDropped>] extends [never]
  ? Jsonify<E>
  : Jsonify<Exclude<E, JsonDropped>> | null;

/** A string or number index signature, which has no optional form. */
type IsIndexKey<K> = string extends K ? true : number extends K ? true : false;

/** A member's value in JSON. */
type MemberJson<T, K extends keyof T> = Jsonify<Exclude<T[K], JsonDropped>>;

/** What a member's `toJSON()` can answer, `never` without one (distributive,
 *  so `Date | Custom` reads `Custom`'s). */
type ToJsonResult<V> = V extends { toJSON(...args: any[]): infer J } ? J : never;

/** The key is gone: every value is dropped, or its `toJSON()` always answers
 *  `undefined`. */
type IsGone<T, K extends keyof T> = [Exclude<T[K], JsonGone>] extends [never]
  ? true
  : IsAny<T[K]> extends true
    ? false
    : [Exclude<T[K], JsonDropped>] extends [never]
      ? false // only `void` left: optional, not gone
      : // Every value has a `toJSON()`, and all of them answer `undefined`.
        [Exclude<T[K], JsonDropped>] extends [{ toJSON(...args: any[]): unknown }]
        ? [ToJsonResult<Exclude<T[K], JsonDropped>>] extends [undefined | void]
          ? true
          : false
        : false;

/** The key may be missing: declared optional, a value that is dropped, or a
 *  `toJSON()` that may answer `undefined`. */
type MayBeMissing<T, K extends keyof T> =
  {} extends Pick<T, K>
    ? true
    : IsAny<T[K]> extends true
      ? false
      : [Extract<T[K], JsonDropped>] extends [never]
        ? [Extract<ToJsonResult<T[K]>, undefined | void>] extends [never]
          ? false
          : true
        : true;

/** Kept and required. An `any` member is kept as it is. Index signatures have
 *  no optional form, so they are always here. */
type RequiredKey<T, K extends keyof T> = K extends symbol
  ? never
  : IsGone<T, K> extends true
    ? never
    : IsIndexKey<K> extends true
      ? K
      : MayBeMissing<T, K> extends true
        ? never
        : K;

/** Kept and optional. */
type OptionalKey<T, K extends keyof T> = K extends symbol
  ? never
  : IsGone<T, K> extends true
    ? never
    : IsIndexKey<K> extends true
      ? never
      : MayBeMissing<T, K> extends true
        ? K
        : never;

type JsonifyObject<T> = Flatten<
  { [K in keyof T as RequiredKey<T, K>]-?: MemberJson<T, K> } & {
    [K in keyof T as OptionalKey<T, K>]?: MemberJson<T, K>;
  }
>;

type Flatten<T> = { [K in keyof T]: T[K] };
