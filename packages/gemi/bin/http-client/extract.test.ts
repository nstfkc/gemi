import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type * as TS from "typescript";
import { compilerOptions, loadTypeScript } from "../ai-client/extract";
import type { TypeRef } from "../ai-client/model";
import { extractHttpApi } from "./extract";
import type { HttpApiModel } from "./model";

const cwd = path.join(import.meta.dirname, "../..");
const file = "bin/http-client/__fixtures__/api.ts";
let ts: typeof TS;
let api: HttpApiModel;
const read = (exportName = "default") => extractHttpApi(ts, { file, exportName }, { cwd });
const route = (key: string) => api.routes.find((route) => route.key === key)!;
function properties(ref: TypeRef | { kind: "none" }) {
  if (ref.kind !== "named") throw new Error(`Expected named type, got ${ref.kind}`);
  const type = api.types.find((type) => type.name === ref.name)!;
  if (type.kind !== "object") throw new Error("Expected object");
  return type.properties;
}

beforeAll(async () => {
  ts = await loadTypeScript(cwd);
  api = read();
}, 60_000);

describe("type-only HTTP extraction", () => {
  test("fixture has no TypeScript errors", () => {
    const absolute = path.join(cwd, file);
    const program = ts.createProgram({
      rootNames: [absolute],
      options: compilerOptions(ts, absolute),
    });
    const source = program.getSourceFile(absolute)!;
    expect(
      program
        .getSemanticDiagnostics(source)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
  }, 60_000);
  test("reads a throwing module and preserves source and sorted RPC keys", () => {
    expect(api.source).toBe(`${file}#default`);
    const keys = api.routes.map((route) => route.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "DELETE:/resources/:id",
      "GET:/controller",
      "GET:/errors",
      "GET:/files/:path*",
      "GET:/maybe-empty",
      "GET:/maybe-undefined",
      "GET:/maybe-void",
      "GET:/mismatch/:noteId",
      "GET:/nested/ping",
      "GET:/notes-list",
      "GET:/notes/list",
      "GET:/null",
      "GET:/raw-response",
      "GET:/resources",
      "GET:/resources/:id",
      "GET:/result",
      "GET:/search/:org/:cursor?",
      "GET:/unsupported",
      "GET:/verbs",
      "PATCH:/verbs",
      "POST:/download",
      "POST:/notes",
      "POST:/resources",
      "POST:/upload",
      "POST:/void",
      "PUT:/resources/:id",
    ]);
  });
  test("GET query keeps optional and nullable distinct, with path params", () => {
    const search = route("GET:/search/:org/:cursor?");
    expect(search.input.location).toBe("query");
    expect(search.pathParameters).toEqual([
      { name: "org", optional: false, catchAll: false },
      { name: "cursor", optional: true, catchAll: false },
    ]);
    expect(properties(search.params)).toEqual([
      { key: "org", optional: false, type: { kind: "string" } },
      { key: "cursor", optional: true, type: { kind: "string" } },
    ]);
    expect(properties(search.input.type)).toEqual([
      { key: "query", optional: false, type: { kind: "string" } },
      { key: "limit", optional: true, type: { kind: "number" } },
      {
        key: "nullable",
        optional: false,
        type: { kind: "nullable", inner: { kind: "string" } },
      },
      {
        key: "both",
        optional: true,
        type: { kind: "nullable", inner: { kind: "string" } },
      },
    ]);
    expect(search.response.kind).toBe("array");
    expect(search.error).toEqual({ kind: "never" });
  });
  test("POST body, awaited success and typed client errors", () => {
    const post = route("POST:/notes");
    expect(post.input.location).toBe("body");
    expect(properties(post.input.type)).toEqual([
      { key: "title", optional: false, type: { kind: "string" } },
      {
        key: "text",
        optional: true,
        type: { kind: "nullable", inner: { kind: "string" } },
      },
    ]);
    expect(properties(post.response as TypeRef)).toEqual([
      { key: "id", optional: false, type: { kind: "string" } },
    ]);
    expect(properties(post.error).map((p) => [p.key, p.type.kind])).toEqual([
      ["kind", "string"],
      ["message", "string"],
      ["status", "number"],
    ]);
  });
  test("resource inputs and verb-map routes are read through CreateRPC", () => {
    expect(route("GET:/resources").input.location).toBe("query");
    expect(properties(route("GET:/resources").input.type)[0]?.key).toBe("page");
    expect(properties(route("PUT:/resources/:id").input.type)[0]?.optional).toBe(true);
    expect(route("PATCH:/verbs").input.location).toBe("body");
    expect(route("GET:/nested/ping").path).toBe("/nested/ping");
  });
  test("void is explicit; Date, bigint, tuple and void unions are diagnosed", () => {
    expect(route("POST:/void").response).toEqual({ kind: "void" });
    expect(route("GET:/maybe-undefined").response).toEqual({ kind: "json" });
    expect(route("GET:/maybe-void").response).toEqual({ kind: "json" });
    expect(properties(route("GET:/unsupported").response as TypeRef).map((p) => p.type)).toEqual([
      { kind: "json" },
      { kind: "json" },
      { kind: "json" },
    ]);
    for (const where of [
      "response.date",
      "response.count",
      "response.pair",
      "GET:/maybe-void response",
    ]) {
      expect(api.warnings.some((warning) => warning.includes(where))).toBe(true);
    }
  });
  test("catch-all names and empty response status survive extraction", () => {
    expect(route("GET:/files/:path*").pathParameters).toEqual([
      { name: "path", optional: false, catchAll: true },
    ]);
    expect(route("DELETE:/resources/:id").response).toEqual({ kind: "void" });
    expect(route("GET:/null").response).toEqual({ kind: "null" });
    expect(route("GET:/maybe-empty").response).toEqual({ kind: "json" });
    expect(api.warnings.some((w) => w.includes("GET:/maybe-empty response"))).toBe(true);
    expect(properties(route("GET:/raw-response").response as TypeRef)).toEqual([
      { key: "id", optional: false, type: { kind: "string" } },
    ]);
    expect(api.warnings.some((w) => w.includes("DELETE:/resources/:id response"))).toBe(false);
  });
  test("normalizes absent input and diagnoses params and type collisions", () => {
    for (const key of ["GET:/nested/ping", "GET:/files/:path*", "GET:/null"]) {
      expect(route(key).input.type).toEqual({ kind: "none" });
    }
    expect(route("POST:/notes").params).toEqual({ kind: "none" });
    expect(api.warnings.some((w) => w.includes("GET:/mismatch/:noteId params"))).toBe(true);
    expect(
      api.warnings.some((w) => w.includes("HTTP type name collision: GETNotesListResponse")),
    ).toBe(true);
  });
  test("preserves single and multiple error literals and covers controller/File inputs", () => {
    expect(properties(route("POST:/notes").error).find((p) => p.key === "kind")?.type).toEqual({
      kind: "string",
      literal: "gone",
    });
    expect(properties(route("POST:/notes").error).find((p) => p.key === "status")?.type).toEqual({
      kind: "number",
      literal: 410,
    });
    const ref = route("GET:/errors").error;
    if (ref.kind !== "named") throw new Error("Expected union");
    const union = api.types.find((t) => t.name === ref.name)!;
    if (union.kind !== "union") throw new Error("Expected union");
    expect(union.variants.map((v) => v.value).sort()).toEqual(["conflict", "gone"]);
    for (const variant of union.variants) {
      expect(properties(variant.type).find((p) => p.key === "kind")?.type).toEqual({
        kind: "string",
        literal: variant.value,
      });
    }
    expect(properties(route("GET:/controller").input.type)[0]?.key).toBe("page");
    expect(api.warnings.some((w) => w.includes("POST:/upload input.file"))).toBe(true);
  });
  test("preserves boolean tags, nullable literals and unrestricted booleans", () => {
    const result = route("GET:/result");
    expect(properties(result.input.type).map((p) => p.type)).toEqual([
      { kind: "nullable", inner: { kind: "boolean", literal: false } },
      { kind: "boolean" },
    ]);
    const ref = result.response;
    if (ref.kind !== "named") throw new Error("Expected named response");
    const union = api.types.find((t) => t.name === ref.name);
    if (union?.kind !== "union") throw new Error("Expected tagged result");
    expect(union.discriminant).toBe("ok");
    expect(union.variants.map((v) => v.value).sort()).toEqual([false, true]);
    for (const { value, type } of union.variants) {
      expect(properties(type).find((p) => p.key === "ok")?.type).toEqual({
        kind: "boolean",
        literal: value,
      });
    }
    expect(route("GET:/errors").response).toEqual({ kind: "never" });
    expect(api.warnings.some((w) => w.includes("no raw output"))).toBe(false);
  });
  test("warns for a missing raw output and preserves a handler that always throws", () => {
    const partial = extractHttpApi(
      ts,
      {
        file: "bin/http-client/__fixtures__/partial/http/ApiRouter.ts",
        exportName: "default",
      },
      { cwd },
    );
    expect(partial.routes.map(({ key, response }) => [key, response])).toEqual([
      ["GET:/missing", { kind: "json" }],
      ["GET:/throws", { kind: "never" }],
    ]);
    expect(partial.warnings).toEqual([
      "GET:/missing response: CreateRPC has a route but no raw output was found; kept as raw JSON.",
    ]);
  }, 60_000);
  test("reads older app routers that only export the web RPC types", () => {
    const legacy = extractHttpApi(
      ts,
      {
        file: "bin/http-client/__fixtures__/legacy/http/ApiRouter.ts",
        exportName: "default",
      },
      { cwd },
    );
    expect(legacy.routes.map(({ key, response }) => [key, response])).toEqual([
      ["GET:/items/:id", { kind: "string" }],
      ["POST:/empty", { kind: "json" }],
    ]);
    expect(legacy.warnings).toEqual([
      "POST:/empty response: this version of gemi cannot distinguish a 204 from JSON null.",
    ]);
  }, 60_000);
  test("repeated extraction is byte-identical", () => {
    expect(JSON.stringify(read())).toBe(JSON.stringify(api));
  }, 60_000);
  test("supports named class and instance exports, and empty routers", () => {
    expect(read("Api").routes).toEqual(api.routes);
    expect(read("instance").routes).toEqual(api.routes);
    expect(read("Empty").routes).toEqual([]);
  }, 60_000);
  test("invalid file, missing export and non-router exports fail clearly", () => {
    expect(() =>
      extractHttpApi(ts, { file: "missing-api.ts", exportName: "default" }, { cwd }),
    ).toThrow("does not exist");
    expect(() =>
      extractHttpApi(ts, { file: "bin/http-client/README.md", exportName: "default" }, { cwd }),
    ).toThrow("not a TypeScript module");
    expect(() => read("missing")).toThrow('no export named "missing"');
    expect(() => read("notRouter")).toThrow("not an ApiRouter");
  }, 60_000);
});
