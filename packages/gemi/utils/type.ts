export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

type PluralSuffix = "s" | "es" | "ies";
export type Plural = `${string}${PluralSuffix}`;
export type ToSingular<T extends Plural> = T extends `${infer R}${PluralSuffix}`
  ? R
  : T;

export type WithId<T extends string> = `${T}Id`;

export type Prettify<T> = {
  [P in keyof T as T[P] extends never ? never : P]: T[P];
} & {};

export type IsEmptyObject<T> = T extends Record<string, never> ? true : false;

export type ParseTranslationParams<T extends string> =
  T extends `${infer _Start}{{${infer Param}}}${infer Rest}`
    ? Param extends `${infer Key}:${infer Type}`
      ? {
          [K in Key]: Type extends "number" ? number : string;
        } & ParseTranslationParams<Rest>
      : { [K in Param]: string } & ParseTranslationParams<Rest>
    : Record<string, never>;

type JSONValue =
  | string
  | number
  | boolean
  | null
  | Partial<JSONLike>
  | JSONValue[];

export type JSONLike = {
  [key: string]: JSONValue;
};

export type UnNullable<T> = T extends null | undefined ? never : T;

export type NestedUnNullable<T extends JSONLike> = {
  [K in keyof T]: T[K] extends JSONLike
    ? NestedUnNullable<T[K]>
    : UnNullable<T[K]>;
};
