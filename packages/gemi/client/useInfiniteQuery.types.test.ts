import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * `useInfiniteQuery`'s item type is inferred — from the page when the page is
 * an array, from `getItems` otherwise — and the `useMutate` predicate form is
 * typed against the path's data. Checked the way an application checks them
 * (`strict`, a real `RPC` augmentation), since this package compiles with
 * `strict: false`. See `useMutation.types.test.ts` for the harness.
 */

const CLIENT = import.meta.dirname;

const prelude = `
import type { ApiRouterHandler } from "../http/ApiRouter";
import { useInfiniteQuery } from "./useInfiniteQuery";
import { useMutate } from "./useMutate";
type Row = { id: string; name: string };
declare module "./rpc" {
  interface RPC {
    "GET:/rows": ApiRouterHandler<{ page?: number; query?: string }, Promise<Row[]>, {}>;
    "GET:/feed": ApiRouterHandler<{ cursor?: string }, Promise<{ rows: Row[]; next: string | null }>, {}>;
  }
}
`;

const snippets = {
  arrayPage: `
    export function f() {
      const { items, pages } = useInfiniteQuery("/rows", {}, {
        getNextPage: (last, all) => (last.length === 48 ? all.length + 1 : null),
        getKey: (row) => row.id,
      });
      const names: string[] = items.map((row) => row.name);
      const firstPage: Row[] | undefined = pages[0];
      return [names, firstPage];
    }`,
  objectPage: `
    export function f() {
      const { items } = useInfiniteQuery("/feed", {}, {
        pageParam: "cursor",
        getNextPage: (last) => last.next,
        getItems: (page) => page.rows,
      });
      const names: string[] = items.map((row) => row.name);
      return names;
    }`,
  wrongKey: `
    export function f() {
      useInfiniteQuery("/rows", {}, {
        getNextPage: () => null,
        getKey: (row) => row.missing,
      });
    }`,
  mutatePredicate: `
    export function f() {
      const mutate = useMutate();
      mutate(
        { path: "/rows", search: (search) => search.has("query") },
        (rows) => rows.filter((row) => row.id !== "1"),
      );
    }`,
};

type Snippet = keyof typeof snippets;
let diagnostics: Record<Snippet, string[]>;

beforeAll(() => {
  const files = new Map(
    Object.entries(snippets).map(([name, body]) => [
      path.join(CLIENT, `__infinite_${name}__.ts`),
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
          program.getSourceFile(path.join(CLIENT, `__infinite_${name}__.ts`)),
        )
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  ) as Record<Snippet, string[]>;
}, 60_000);

describe("useInfiniteQuery's types", () => {
  test("an array page is its own item type", () => {
    expect(diagnostics.arrayPage).toEqual([]);
  });

  test("getItems names the item type of an object page", () => {
    expect(diagnostics.objectPage).toEqual([]);
  });

  test("getKey is checked against the item type", () => {
    expect(diagnostics.wrongKey).toEqual([
      expect.stringMatching(/Property 'missing' does not exist/),
    ]);
  });

  test("useMutate's search predicate keeps the data typed", () => {
    expect(diagnostics.mutatePredicate).toEqual([]);
  });
});
