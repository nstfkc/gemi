import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, expect, test } from "vitest";
import { loadTypeScript } from "../ai-client/extract";
import { swiftString } from "../ai-client/swift";
import { extractHttpApi } from "./extract";
import type { HttpApiModel } from "./model";
import { renderHttpKotlin, renderHttpSwift } from "./render";

const cwd = path.join(import.meta.dirname, "../..");
const file = "bin/http-client/__fixtures__/notes.ts";
let api: HttpApiModel;

beforeAll(async () => {
  api = extractHttpApi(await loadTypeScript(cwd), { file, exportName: "default" }, { cwd });
  expect(api.warnings).toEqual([expect.stringContaining("createdAt")]);
  expect(api.routes.map((route) => route.key)).toEqual(["PATCH:/notes/:id", "POST:/notes"]);
}, 60_000);

const kotlinPackage = "dev.gemijs.chat.generated";
test.each([
  ["../gemi-swift/Tests/GemiChatTests/Generated/NotesApi.swift", renderHttpSwift],
  [
    "../gemi-kotlin/gemi-chat/src/test/kotlin/dev/gemijs/chat/generated/NotesApi.kt",
    (model: HttpApiModel) => renderHttpKotlin(model, kotlinPackage),
  ],
] as const)("checked-in HTTP models match the router in %s", (relative, render) => {
  const target = path.resolve(cwd, relative);
  const source = render(api);
  if (process.env.GEMI_UPDATE_FIXTURES === "1") writeFileSync(target, source);
  expect(source, `${relative} is stale. Rerun with GEMI_UPDATE_FIXTURES=1.`).toBe(
    readFileSync(target, "utf8"),
  );
});

test("escapes Swift wire strings as Unicode scalars", () => {
  expect(swiftString("\b\f\u0000\\u0000😀")).toBe('"\\u{8}\\u{c}\\u{0000}\\\\u0000😀"');
  expect(() => swiftString("\ud800")).toThrow("lone surrogate");
});

test("an object with ordinary keys imports only Serializable in Kotlin", () => {
  const type = api.types.find((type) => type.name === "PATCHNotesIdInput")!;
  const source = renderHttpKotlin({ ...api, types: [type] }, kotlinPackage);
  expect(source.match(/^import .*$/gm)).toEqual(["import kotlinx.serialization.Serializable"]);
});

test("a union with a raw variant preserves the complete JSON payload", () => {
  const model: HttpApiModel = {
    ...api,
    types: [
      {
        kind: "union",
        name: "Event",
        discriminant: "kind",
        variants: [{ value: "custom", type: { kind: "json" } }],
      },
    ],
  };
  expect(renderHttpSwift(model)).toContain("public typealias Event = JSONValue");
  expect(renderHttpKotlin(model, kotlinPackage)).toContain("public typealias Event = JsonElement");
});
