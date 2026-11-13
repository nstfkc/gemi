import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * `useMultipleQuery` infers each key's data, params and config from its own
 * route. Checked the way an application checks it (`strict`, a real `RPC`
 * augmentation), since this package compiles with `strict: false`. See
 * `useMutation.types.test.ts` for the harness.
 */

const CLIENT = import.meta.dirname;

const prelude = `
import type { ApiRouterHandler } from "../http/ApiRouter";
import { useMultipleQuery } from "./useMultipleQuery";
type Product = { id: string; price: number };
type Category = { id: number; name: string };
declare module "./rpc" {
  interface RPC {
    "GET:/products": ApiRouterHandler<{ q?: string }, Promise<Product[]>, {}>;
    "GET:/categories/:categoryId": ApiRouterHandler<{}, Promise<Category>, {}>;
    "POST:/products": ApiRouterHandler<{ name: string }, Promise<Product>, {}>;
  }
}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(_: T) {}
`;

const snippets = {
  inferred: `
    export function f() {
      const { data, loading, error, mutate, refetch } = useMultipleQuery({
        products: ["/products"],
        category: ["/categories/:categoryId", { params: { categoryId: 1 } }],
      });
      expectType<Equal<typeof data.products, { id: string; price: number }[]>>(true);
      expectType<Equal<typeof data.category, { id: number; name: string }>>(true);
      expectType<Equal<typeof loading, boolean>>(true);
      expectType<Equal<typeof error.products, Record<string, unknown> | null>>(true);
      mutate.products((items) => items.filter((p) => p.price > 0));
      mutate.category({ id: 2, name: "x" });
      refetch.category();
    }`,
  nullableWhenNotSuspending: `
    export function f() {
      const { data } = useMultipleQuery(
        {
          products: ["/products"],
          pinned: ["/categories/:categoryId", { params: { categoryId: 1 } }, { suspense: true }],
        },
        { suspense: false },
      );
      expectType<Equal<typeof data.products, { id: string; price: number }[] | undefined>>(true);
      expectType<Equal<typeof data.pinned, { id: number; name: string }>>(true);
    }`,
  perKeySuspenseFalse: `
    export function f() {
      const { data } = useMultipleQuery({
        products: ["/products", {}, { suspense: false }],
        category: ["/categories/:categoryId", { params: { categoryId: "1" } }],
      });
      expectType<Equal<typeof data.products, { id: string; price: number }[] | undefined>>(true);
      expectType<Equal<typeof data.category, { id: number; name: string }>>(true);
    }`,
  configTyped: `
    export function f() {
      useMultipleQuery({
        products: ["/products", { search: { q: "x" } }, { refetchUntil: (items, duration) => (items.length ? 0 : duration + 1000) }],
      });
    }`,
  wrongParam: `
    export function f() {
      useMultipleQuery({
        category: ["/categories/:categoryId", { params: { id: 1 } }],
      });
    }`,
  unknownPath: `
    export function f() {
      useMultipleQuery({ nope: ["/nope"] });
    }`,
  wrongMutate: `
    export function f() {
      const { mutate } = useMultipleQuery({ category: ["/categories/:categoryId", { params: { categoryId: 1 } }] });
      mutate.category({ files: [] });
    }`,
  noLazy: `
    export function f() {
      useMultipleQuery({ products: ["/products", {}, { lazy: true }] });
    }`,
};

type Snippet = keyof typeof snippets;
let diagnostics: Record<Snippet, string[]>;

beforeAll(() => {
  const files = new Map(
    Object.entries(snippets).map(([name, body]) => [
      path.join(CLIENT, `__multiplequery_${name}__.ts`),
      prelude + body,
    ]),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, version, ...rest) =>
    files.has(name)
      ? ts.createSourceFile(name, files.get(name)!, version)
      : getSourceFile.call(host, name, version, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (name) => files.has(name) || fileExists.call(host, name);

  const program = ts.createProgram([...files.keys()], options, host);
  diagnostics = Object.fromEntries(
    Object.keys(snippets).map((name) => [
      name,
      ts
        .getPreEmitDiagnostics(
          program,
          program.getSourceFile(
            path.join(CLIENT, `__multiplequery_${name}__.ts`),
          ),
        )
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  ) as Record<Snippet, string[]>;
}, 60_000);

describe("useMultipleQuery types", () => {
  test("each key infers its route's data, and mutate/refetch per key", () => {
    expect(diagnostics.inferred).toEqual([]);
  });

  test("a key that does not suspend has nullable data; per-key config wins", () => {
    expect(diagnostics.nullableWhenNotSuspending).toEqual([]);
    expect(diagnostics.perKeySuspenseFalse).toEqual([]);
  });

  test("a key's config is typed from its route's data", () => {
    expect(diagnostics.configTyped).toEqual([]);
  });

  test("params are checked against the route", () => {
    expect(diagnostics.wrongParam.length).toBeGreaterThan(0);
    expect(diagnostics.wrongParam.join("\n")).toMatch(/'id' does not exist/);
  });

  test("the path must be a GET route", () => {
    expect(diagnostics.unknownPath).toEqual([
      expect.stringMatching(/not assignable to type 'never'/),
    ]);
  });

  test("mutate takes the key's data", () => {
    expect(diagnostics.wrongMutate.join("\n")).toMatch(/'files' does not exist/);
  });

  test("lazy is not a key option", () => {
    expect(diagnostics.noLazy.join("\n")).toMatch(/'lazy' does not exist/);
  });
});
