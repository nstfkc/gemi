import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type * as TS from "typescript";
import { loadTypeScript } from "../ai-client/extract";
import type { TypeRef } from "../ai-client/model";
import { extractHttpApi } from "./extract";
import type { HttpApiModel } from "./model";

const cwd = path.join(import.meta.dirname, "../..");
const file = "bin/http-client/__fixtures__/api.ts";
let ts: typeof TS;
let api: HttpApiModel;
const read = (exportName = "default") => extractHttpApi(ts, { file, exportName }, { cwd });
const route = (key: string) => api.routes.find((route) => route.key === key)!;
function properties(ref: TypeRef) {
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
  test("reads a throwing module and preserves source and sorted RPC keys", () => {
    expect(api.source).toBe(`${file}#default`);
    const keys = api.routes.map((route) => route.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "DELETE:/resources/:id",
      "GET:/maybe-undefined",
      "GET:/maybe-void",
      "GET:/nested/ping",
      "GET:/resources",
      "GET:/resources/:id",
      "GET:/search/:org/:cursor?",
      "GET:/unsupported",
      "GET:/verbs",
      "PATCH:/verbs",
      "POST:/download",
      "POST:/notes",
      "POST:/resources",
      "POST:/void",
      "PUT:/resources/:id",
    ]);
  });
  test("GET query keeps optional and nullable distinct, with path params", () => {
    const search = route("GET:/search/:org/:cursor?");
    expect(search.input.location).toBe("query");
    expect(search.pathParameters).toEqual([
      { name: "org", optional: false },
      { name: "cursor", optional: true },
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
