import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Issue #623: `trigger` resolves `undefined` on a non-2xx response, a network
 * failure, a `cancel()` and a superseded request, and was typed `Promise<T>`,
 * so `const r = await trigger(); r.id` compiled and failed at run time.
 *
 * This is not a `.test-d.ts` because this package compiles with
 * `strict: false`, where `T | undefined` collapses to `T` and an assertion on
 * the return type passes against the old signature just as well — measured.
 * Applications compile with `strictNullChecks`, which is where the fix is
 * visible, so the snippets below are checked the way an application checks
 * them. One program for all of them: building it is most of the cost.
 */

const CLIENT = import.meta.dirname;

// A route the framework itself declares, so the snippets need no `RPC`
// augmentation; `T` is given explicitly so the data has a field to read.
const prelude = `
import { useMutation, usePost, useUpload } from "./useMutation";
type Created = { id: string };
const route = "/auth/sign-out" as const;
`;

const snippets = {
  mutationUnchecked: `
    export async function f() {
      const mutation = useMutation<"POST", typeof route, Created>("POST", route);
      const result = await mutation.trigger();
      return result.id;
    }`,
  mutationNarrowed: `
    export async function f(): Promise<string | undefined> {
      const mutation = useMutation<"POST", typeof route, Created>("POST", route);
      const result = await mutation.trigger();
      return result?.id;
    }`,
  postInferred: `
    export async function f() {
      const result = await usePost(route).trigger();
      const data: NonNullable<typeof result> = result;
      return data;
    }`,
  uploadUnchecked: `
    export async function f(file: File) {
      const upload = useUpload<typeof route, Created>(route);
      const result = await upload.trigger(file);
      return result.id;
    }`,
};

type Snippet = keyof typeof snippets;
let diagnostics: Record<Snippet, string[]>;

beforeAll(() => {
  const files = new Map(
    Object.entries(snippets).map(([name, body]) => [
      path.join(CLIENT, `__trigger_${name}__.ts`),
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
          program.getSourceFile(path.join(CLIENT, `__trigger_${name}__.ts`)),
        )
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  ) as Record<Snippet, string[]>;
}, 60_000);

describe("trigger's result under strictNullChecks", () => {
  test("useMutation's cannot be read without a check", () => {
    expect(diagnostics.mutationUnchecked).toEqual([
      expect.stringMatching(/possibly 'undefined'/),
    ]);
  });

  test("useMutation's can be read once narrowed", () => {
    expect(diagnostics.mutationNarrowed).toEqual([]);
  });

  test("usePost's inferred data carries the same contract", () => {
    expect(diagnostics.postInferred).toEqual([
      expect.stringMatching(/'undefined' is not assignable/),
    ]);
  });

  test("useUpload's cannot be read without a check", () => {
    expect(diagnostics.uploadUnchecked).toEqual([
      expect.stringMatching(/possibly 'undefined'/),
    ]);
  });
});
