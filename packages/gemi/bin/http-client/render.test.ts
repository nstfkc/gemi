import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, expect, test } from "vitest";
import { loadTypeScript } from "../ai-client/extract";
import { extractHttpApi } from "./extract";
import type { HttpApiModel } from "./model";
import { renderHttpKotlin, renderHttpSwift } from "./render";

const cwd = path.join(import.meta.dirname, "../..");
const file = "bin/http-client/__fixtures__/notes.ts";
let api: HttpApiModel;

beforeAll(async () => {
  api = extractHttpApi(await loadTypeScript(cwd), { file, exportName: "default" }, { cwd });
  expect(api.warnings).toEqual([]);
  expect(api.routes.map((route) => route.key)).toEqual(["PATCH:/notes/:id"]);
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
