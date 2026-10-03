import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Issue #665: typed non-2xx answers. A handler's `HttpResponse.error(status,
 * body)` / `httpError` — or an `HttpResponse.json` with a literal 4xx/5xx
 * status — leaves the route's success type and becomes its typed error, which
 * `onError` and `error` receive as `MutationError | E`. A raw `Response` in a
 * union with typed returns leaves the success type too.
 *
 * Checked under `strict`, the way an application compiles, with the harness of
 * `HttpResponse.types.test.ts`.
 */

const HTTP = import.meta.dirname;

const prelude = `
import { createElement } from "react";
import { ApiRouter, type CreateRPC } from "./ApiRouter";
import { HttpResponse, httpError } from "./HttpResponse";
import { useMutation, usePost } from "../client/useMutation";
import { Form } from "../client/Mutation";
import { isHttpError, type MutationError } from "../client/MutationError";
import { Query } from "../facades/Prefetch";

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
declare function assert<T extends true>(): void;
declare const flip: boolean;
declare const someStatus: number;

class Root extends ApiRouter {
  routes = {
    "/import": this.post(async () => {
      if (flip) return httpError(410, { kind: "gone", message: "Link has expired" });
      if (!flip) return HttpResponse.error(409, { kind: "taken", field: "slug" });
      return { catalogId: "c" };
    }),
    "/legacy-409": this.get(() => {
      if (flip) return HttpResponse.json({ error: { message: "Taken" } }, { status: 409 });
      return { id: "1" };
    }),
    "/dynamic": this.get(() => HttpResponse.json({ a: 1 }, { status: someStatus })),
    "/mixed-status": this.get(() => HttpResponse.json({ a: 1 }, { status: flip ? 200 : 410 })),
    "/raw": this.post(async () => {
      if (flip) return new Response("file");
      return { ok: true };
    }),
    "/raw-only": this.get(() => new Response("file")),
    "/plain": this.post(() => ({ a: 1 })),
  };
}

declare module "../client/rpc" {
  interface RPC extends CreateRPC<Root> {}
}
`;

const snippets = {
  successType: `
    export async function f() {
      const result = await usePost("/import").trigger();
      assert<Equal<typeof result, { catalogId: string } | undefined>>();
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/legacy-409">>>, { id: string }>>();
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/dynamic">>>, { a: number }>>();
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/mixed-status">>>, { a: number }>>();
    }`,
  onErrorNarrows: `
    export function f() {
      return usePost("/import", {}, {
        onError: (error) => {
          if (error instanceof Error) return;
          if (error.kind === "gone") {
            const message: string = error.message;
            const status: 410 = error.status;
            return [message, status];
          }
          if (error.kind === "taken") {
            const field: "slug" = error.field;
            return field;
          }
        },
      });
    }`,
  isHttpError: `
    export function f() {
      const { error } = useMutation("POST", "/import");
      if (isHttpError(error, 410)) {
        const kind: "gone" = error.kind;
        return kind;
      }
      if (isHttpError(error, 409)) {
        const field: "slug" = error.field;
        return field;
      }
      return null;
    }`,
  formOnError: `
    export const el = createElement(Form<"/import", "POST">, {
      action: "/import",
      onError: (error, form) => {
        if (isHttpError(error, 410)) console.log(error.message, form.id);
      },
    });`,
  legacyJsonError: `
    export function f() {
      return useMutation("GET" as never, "/legacy-409" as never);
    }
    type E = import("./HttpResponse").ResponseError<
      HttpResponse<{ error: { message: string } }, 409>
    >;
    assert<Equal<E["status"], 409>>();
    assert<Equal<E["message"], string>>();
    export const kind: E["kind"] = "form_error";`,
  rawResponse: `
    export async function f() {
      const result = await usePost("/raw").trigger();
      assert<Equal<typeof result, { ok: boolean } | undefined>>();
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/raw-only">>>, Response>>();
    }`,
  noTypedErrors: `
    export function f() {
      const { error } = usePost("/plain");
      assert<Equal<typeof error, MutationError | null>>();
    }`,
  oldHandlersCompile: `
    export function f() {
      usePost("/import", {}, { onError: (error: MutationError) => console.log(error) });
      return createElement(Form<"/import", "POST">, {
        action: "/import",
        onError: (error: MutationError) => console.log(error),
      });
    }`,
  errorStatusRange: `
    export const a = httpError(200, { kind: "x" });`,
};

type Snippet = keyof typeof snippets;
let diagnostics: Record<Snippet, string[]>;

beforeAll(() => {
  const files = new Map(
    Object.entries(snippets).map(([name, body]) => [
      path.join(HTTP, `__http_error_${name}__.ts`),
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
          program.getSourceFile(path.join(HTTP, `__http_error_${name}__.ts`)),
        )
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  ) as Record<Snippet, string[]>;
}, 60_000);

describe("typed errors (#665)", () => {
  test("typed errors and literal 4xx statuses leave the success type; a dynamic status does not", () => {
    expect(diagnostics.successType).toEqual([]);
  });

  test("onError is MutationError | the route's errors, and kind narrows it", () => {
    expect(diagnostics.onErrorNarrows).toEqual([]);
  });

  test("isHttpError narrows the hook's error by status", () => {
    expect(diagnostics.isHttpError).toEqual([]);
  });

  test("<Form onError> receives the route's typed errors", () => {
    expect(diagnostics.formOnError).toEqual([]);
  });

  test("an HttpResponse.json error body is typed the way the client reshapes it", () => {
    expect(diagnostics.legacyJsonError).toEqual([]);
  });

  test("a raw Response leaves a union, but a route that only returns one keeps it", () => {
    expect(diagnostics.rawResponse).toEqual([]);
  });

  test("a route without typed errors still has MutationError alone", () => {
    expect(diagnostics.noTypedErrors).toEqual([]);
  });

  test("handlers typed (error: MutationError) still compile", () => {
    expect(diagnostics.oldHandlersCompile).toEqual([]);
  });

  test("httpError compiles for any number; the range is checked at run time", () => {
    expect(diagnostics.errorStatusRange).toEqual([]);
  });
});
