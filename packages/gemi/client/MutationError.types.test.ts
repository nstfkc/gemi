import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Issue #626: `<Form onError>` and the mutation hooks' `error` were `any`, so
 * nothing stopped an app reading a field the error did not have. They are
 * `MutationError` now, and the guards narrow it.
 *
 * Checked under `strict`, the way an application compiles, for the reason
 * `useMutation.types.test.ts` gives: this package's own `strict: false` lets
 * narrowing mistakes through. One program for every snippet.
 */

const CLIENT = import.meta.dirname;

const prelude = `
import { createElement } from "react";
import { Form } from "./Mutation";
import { useMutation, usePost } from "./useMutation";
import {
  isAuthenticationError,
  isNotFoundError,
  isPermissionError,
  isValidationError,
  mutationErrorKind,
  type MutationError,
} from "./MutationError";
const route = "/auth/sign-out" as const;
`;

const snippets = {
  formUnchecked: `
    export const el = createElement(Form<typeof route, "POST">, {
      action: route,
      onError: (error) => console.log(error.messages),
    });`,
  formNarrowed: `
    export const el = createElement(Form<typeof route, "POST">, {
      action: route,
      onError: (error, form) => {
        if (isValidationError(error)) {
          const messages: Record<string, string[]> = error.messages;
          console.log(messages, form.id);
        }
      },
    });`,
  formUnknownParam: `
    export const el = createElement(Form<typeof route, "POST">, {
      action: route,
      onError: (error: unknown) => console.log(error),
    });`,
  hookErrorUnchecked: `
    export function f() {
      const { error } = useMutation("POST", route);
      return error?.message;
    }`,
  hookErrorNarrowed: `
    export function f(): string | null {
      const { error } = usePost(route);
      if (!error) return null;
      if (isValidationError(error)) return Object.keys(error.messages).join();
      return error.message;
    }`,
  hookOnError: `
    export function f() {
      return usePost(route, {}, {
        onError: (error) => {
          const e: MutationError = error;
          return e;
        },
      });
    }`,
  guardsGiveMessageAndStatus: `
    export function f(error: MutationError): string {
      if (isAuthenticationError(error)) return error.message + error.status;
      if (isPermissionError(error)) {
        const kind: "permission" | "authorization" = error.kind;
        return kind + error.message + error.status;
      }
      if (isNotFoundError(error)) return error.message;
      return "";
    }`,
  neverAString: `
    export function f(error: MutationError) {
      const notString: string extends MutationError ? false : true = true;
      // @ts-expect-error a refusal is never a bare string since 0.88
      const s: string = error;
      return [notString, s];
    }`,
  exhaustiveKind: `
    export function f(error: MutationError): string {
      const kind = mutationErrorKind(error);
      switch (kind) {
        case "validation": case "form": case "authentication": case "permission":
        case "csrf": case "not_found": case "rate_limit": case "server":
        case "network": case "unknown":
          return kind;
        default: {
          const never: never = kind;
          return never;
        }
      }
    }`,
};

type Snippet = keyof typeof snippets;
let diagnostics: Record<Snippet, string[]>;

beforeAll(() => {
  const files = new Map(
    Object.entries(snippets).map(([name, body]) => [
      path.join(CLIENT, `__mutation_error_${name}__.ts`),
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
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
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
          program.getSourceFile(path.join(CLIENT, `__mutation_error_${name}__.ts`)),
        )
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  ) as Record<Snippet, string[]>;
}, 60_000);

describe("mutation errors under strict", () => {
  test("<Form onError> cannot read a field the error may not have", () => {
    expect(diagnostics.formUnchecked).toEqual([
      expect.stringMatching(/Property 'messages' does not exist/),
    ]);
  });

  test("<Form onError> can once a guard has narrowed it", () => {
    expect(diagnostics.formNarrowed).toEqual([]);
  });

  test("an onError that takes unknown still fits", () => {
    expect(diagnostics.formUnknownParam).toEqual([]);
  });

  test("the hooks' error cannot be read without narrowing", () => {
    expect(diagnostics.hookErrorUnchecked).toEqual([
      expect.stringMatching(/Property 'message' does not exist/),
    ]);
  });

  test("the hooks' error narrows by typeof and the guards", () => {
    expect(diagnostics.hookErrorNarrowed).toEqual([]);
  });

  test("the hooks' onError is given a MutationError", () => {
    expect(diagnostics.hookOnError).toEqual([]);
  });

  test("a refusal's guard gives its message and status (#673)", () => {
    expect(diagnostics.guardsGiveMessageAndStatus).toEqual([]);
  });

  test("a MutationError is never a string", () => {
    expect(diagnostics.neverAString).toEqual([]);
  });

  test("mutationErrorKind's answers can be switched over exhaustively", () => {
    expect(diagnostics.exhaustiveKind).toEqual([]);
  });
});
