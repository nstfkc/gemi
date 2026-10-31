/**
 * What a value of type `T` is after `JSON.parse(JSON.stringify(value))`: the
 * type the browser holds for something the server sent as JSON (#1107).
 *
 * - `toJSON` is honoured: a `Date` is a `string`, and so is anything whose
 *   `toJSON()` returns one.
 * - Object members that are `undefined`, functions or symbols are dropped; a
 *   member that may be `undefined` is optional. Symbol keys are dropped.
 * - In arrays, those values become `null`, as `JSON.stringify` writes them.
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
    ? unknown
    : [T] extends [JsonSafe]
      ? T
      : JsonifyMember<T>;

/** What `JSON.stringify` drops from an object and writes as `null` in an array. */
type JsonDropped = undefined | symbol | ((...args: any[]) => unknown);

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

/** Kept and required: some member value survives, and none is dropped. */
type RequiredKey<T, K extends keyof T> = K extends symbol
  ? never
  : [Exclude<T[K], JsonDropped>] extends [never]
    ? never
    : IsIndexKey<K> extends true
      ? K
      : {} extends Pick<T, K>
        ? never
        : [Extract<T[K], JsonDropped>] extends [never]
          ? K
          : never;

/** Kept and optional: declared optional, or its value can be dropped. */
type OptionalKey<T, K extends keyof T> = K extends symbol
  ? never
  : [Exclude<T[K], JsonDropped>] extends [never]
    ? never
    : IsIndexKey<K> extends true
      ? never
      : {} extends Pick<T, K>
        ? K
        : [Extract<T[K], JsonDropped>] extends [never]
          ? never
          : K;

type JsonifyObject<T> = Flatten<
  { [K in keyof T as RequiredKey<T, K>]-?: Jsonify<Exclude<T[K], JsonDropped>> } & {
    [K in keyof T as OptionalKey<T, K>]?: Jsonify<Exclude<T[K], JsonDropped>>;
  }
>;

type Flatten<T> = { [K in keyof T]: T[K] };
