import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * A route that answers `HttpResponse.json(data)` is typed for the client as if
 * it had returned `data`: `useQuery`, `usePost` and friends, and
 * `Query.instant`/`Query.prefetch` all read the route's data type off the RPC
 * map, so the RPC map has to carry `T`, not `HttpResponse<T>`.
 *
 * Checked the way an application checks them — `strict`, and a real `RPC`
 * augmentation built with `CreateRPC` from an actual router — since this
 * package compiles with `strict: false`. See `useMutation.types.test.ts` for
 * the harness.
 */

const HTTP = import.meta.dirname;

const prelude = `
import { ApiRouter, type CreateRPC } from "./ApiRouter";
import { Controller, ResourceController } from "./Controller";
import { HttpResponse } from "./HttpResponse";
import { useQuery } from "../client/useQuery";
import { useMutation, usePost } from "../client/useMutation";
import { Query } from "../facades/Prefetch";

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
declare function assert<T extends true>(): void;

class ItemController extends Controller {
  async store() {
    return HttpResponse.json({ id: "1", created: true }, { status: 201 });
  }
  find() {
    if (Math.random() > 0.5) {
      return HttpResponse.json({ error: { message: "Not here" } }, { status: 404 });
    }
    return { id: "1" };
  }
}

class Items extends ResourceController {
  list() { return [{ id: "1" }]; }
  show() { return { id: "1" }; }
  async store() { return HttpResponse.json({ id: "2" }, { status: 201 }); }
  update() { return HttpResponse.json({ id: "1" }, { headers: { "X-Updated": "1" } }); }
  delete() { return { deleted: true }; }
}

class Nested extends ApiRouter {
  routes = {
    "/deep": this.get(() => HttpResponse.json({ deep: 1 })),
  };
}

class Root extends ApiRouter {
  routes = {
    "/plain": this.get(() => ({ a: 1 })),
    "/json": this.get(() => HttpResponse.json({ a: 1 }, { status: 201 })),
    "/async": this.get(async () => HttpResponse.json({ a: 1 }, { status: 201 })),
    "/union": this.get(async () => {
      if (Math.random() > 0.5) return { a: 1 };
      return HttpResponse.json({ b: "x" }, { status: 202 });
    }),
    "/created": this.post(() => HttpResponse.json({ a: 1 }, { status: 201 })),
    "/ctrl": this.post(ItemController, "store"),
    "/ctrl-find": this.get(ItemController, "find"),
    "/items/:id": this.resource(Items),
    "/nested": Nested,
  };
}

declare module "../client/rpc" {
  interface RPC extends CreateRPC<Root> {}
}
`;

const snippets = {
  instant: `
    export async function f() {
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/plain">>>, { a: number }>>();
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/json">>>, { a: number }>>();
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/async">>>, { a: number }>>();
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/nested/deep">>>, { deep: number }>>();
      Query.prefetch("/json");
    }`,
  union: `
    export async function f() {
      assert<
        Equal<Awaited<ReturnType<typeof Query.instant<"/union">>>, { a: number } | { b: string }>
      >();
      // A literal 404 is an error, not data, since #665: see HttpError.types.test.ts.
      assert<Equal<Awaited<ReturnType<typeof Query.instant<"/ctrl-find">>>, { id: string }>>();
    }`,
  useQuery: `
    export function f() {
      const { data } = useQuery("/json");
      const a: number = data.a;
      const back: typeof data = { a: 1 };
      return [a, back];
    }`,
  noEnvelope: `
    export function f() {
      const { data } = useQuery("/json");
      return data.status;
    }`,
  mutations: `
    export async function f() {
      const created = await usePost("/created").trigger();
      assert<Equal<typeof created, { a: number } | undefined>>();
      const ctrl = await usePost("/ctrl").trigger();
      assert<Equal<typeof ctrl, { id: string; created: boolean } | undefined>>();
      const stored = await usePost("/items").trigger();
      assert<Equal<typeof stored, { id: string } | undefined>>();
      const updated = await useMutation("PUT", "/items/:id", { params: { id: "1" } }).trigger();
      assert<Equal<typeof updated, { id: string } | undefined>>();
    }`,
};

type Snippet = keyof typeof snippets;
let diagnostics: Record<Snippet, string[]>;

beforeAll(() => {
  const files = new Map(
    Object.entries(snippets).map(([name, body]) => [
      path.join(HTTP, `__http_response_${name}__.ts`),
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
          program.getSourceFile(path.join(HTTP, `__http_response_${name}__.ts`)),
        )
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ]),
  ) as Record<Snippet, string[]>;
}, 60_000);

describe("HttpResponse's client types", () => {
  test("a route returning HttpResponse.json(data) is typed as data, sync, async or nested", () => {
    expect(diagnostics.instant).toEqual([]);
  });

  test("a union of a plain return and an HttpResponse is the union of their data", () => {
    expect(diagnostics.union).toEqual([]);
  });

  test("useQuery's data is the route's data", () => {
    expect(diagnostics.useQuery).toEqual([]);
  });

  test("the HttpResponse envelope does not leak into the client type", () => {
    expect(diagnostics.noEnvelope).toEqual([
      expect.stringMatching(/Property 'status' does not exist/),
    ]);
  });

  test("mutations on callback, controller and resource routes resolve the data", () => {
    expect(diagnostics.mutations).toEqual([]);
  });
});
