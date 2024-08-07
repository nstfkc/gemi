export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

type PluralSuffix = "s" | "es" | "ies";
export type Plural = `${string}${PluralSuffix}`;
export type ToSingular<T extends Plural> = T extends `${infer R}${PluralSuffix}`
  ? R
  : T;

export type WithId<T extends string> = `${T}Id`;
