import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * `updates` and `useSetQueryData` (#897) are typed from the target path:
 * an entry without `data` only fits when the mutation's answer is the path's
 * data, and `data`'s `answer` and `current` are typed. Checked the way an
 * application checks them (`strict`, a real `RPC` augmentation), since this
 * package compiles with `strict: false`. See `useMutation.types.test.ts` for
 * the harness.
 */

const CLIENT = import.meta.dirname;

const prelude = `
import type { ApiRouterHandler } from "../http/ApiRouter";
import { usePost } from "./useMutation";
import { useSetQueryData } from "./useSetQueryData";
type Assets = { files: { id: string; name: string }[] };
type Todo = { id: string; title: string };
declare module "./rpc" {
  interface RPC {
    "GET:/pages/:pageId/assets": ApiRouterHandler<{}, Promise<Assets>, {}>;
    "POST:/pages/:pageId/assets/move": ApiRouterHandler<{ id: string }, Promise<Assets>, {}>;
    "GET:/todos": ApiRouterHandler<{ query?: string }, Promise<Todo[]>, {}>;
    "POST:/todos": ApiRouterHandler<{ title: string }, Promise<Todo>, {}>;
  }
}
`;

const snippets = {
  sameShape: `
    export function f(pageId: string) {
      return usePost("/pages/:pageId/assets/move", { params: { pageId } }, {
        updates: [{ path: "/pages/:pageId/assets", params: { pageId } }],
      });
    }`,
  otherShapeNeedsData: `
    export function f() {
      return usePost("/todos", {}, { updates: [{ path: "/todos" }] });
    }`,
  dataTyped: `
    export function f() {
      return usePost("/todos", {}, {
        updates: [
          {
            path: "/todos",
            search: (search) => !search.has("query"),
            data: (created, todos) => [...todos, { id: created.id, title: created.title }],
          },
        ],
      });
    }`,
  dataWrongReturn: `
    export function f() {
      return usePost("/todos", {}, {
        updates: [{ path: "/todos", data: (created) => created }],
      });
    }`,
  unknownPath: `
    export function f() {
      return usePost("/todos", {}, { updates: [{ path: "/nope", data: (x: any) => x }] });
    }`,
  setQueryData: `
    export function f(pageId: string, assets: Assets) {
      const setQueryData = useSetQueryData();
      setQueryData({ path: "/pages/:pageId/assets", params: { pageId } }, assets);
      setQueryData({ path: "/todos", search: () => true }, (todos) => todos.filter((t) => t.id !== "1"));
    }`,
  setQueryDataWrongValue: `
    export function f() {
      const setQueryData = useSetQueryData();
      setQueryData({ path: "/todos" }, { files: [] });
    }`,
};

type Snippet = keyof typeof snippets;
let diagnostics: Record<Snippet, string[]>;

beforeAll(() => {
  const files = new Map(
    Object.entries(snippets).map(([name, body]) => [
      path.join(CLIENT, `__setquerydata_${name}__.ts`),
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
          program.getSourceFile(path.join(CLIENT, `__setquerydata_${name}__.ts`)),
        )
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  ) as Record<Snippet, string[]>;
}, 60_000);

describe("updates and useSetQueryData types", () => {
  test("an answer that is the path's data needs no `data`", () => {
    expect(diagnostics.sameShape).toEqual([]);
  });

  test("an answer of another shape needs `data`", () => {
    expect(diagnostics.otherShapeNeedsData).toEqual([
      expect.stringMatching(/Property 'data' is missing/),
    ]);
  });

  test("`data` gets the typed answer and cached value", () => {
    expect(diagnostics.dataTyped).toEqual([]);
  });

  test("`data` must return the path's data", () => {
    expect(diagnostics.dataWrongReturn).toEqual([
      expect.stringMatching(/Type 'Todo' is not assignable/),
    ]);
  });

  test("the path must be a GET route", () => {
    expect(diagnostics.unknownPath).toEqual([
      expect.stringMatching(/'"\/nope"' is not assignable/),
    ]);
  });

  test("useSetQueryData is typed from the path", () => {
    expect(diagnostics.setQueryData).toEqual([]);
    expect(diagnostics.setQueryDataWrongValue).toEqual([
      expect.stringMatching(/'files' does not exist/),
    ]);
  });
});
