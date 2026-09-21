import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as TS from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GenerateClientError, extractAgent, loadTypeScript, parseAgentReference } from "./extract";
import { generateClient } from "./generate";
import { type AgentModel, type NamedType, camelCase, pascalCase } from "./model";
import { renderSwift } from "./swift";

const PACKAGE = path.join(import.meta.dirname, "../..");
const FIXTURES = "bin/ai-client/__fixtures__";
/** Where the Swift test target keeps the generated files it compiles. */
const SWIFT_GENERATED = path.join(PACKAGE, "../gemi-swift/Tests/GemiChatTests/Generated");

// A program over gemi's own sources is a few seconds, so each agent is read
// once and shared.
let ts: typeof TS;
let support: AgentModel;
let classifier: AgentModel;
let odd: AgentModel;
let e2e: AgentModel;

const read = (file: string, exportName: string, name?: string) =>
  extractAgent(ts, { file: `${FIXTURES}/${file}`, exportName }, { cwd: PACKAGE, name });

beforeAll(async () => {
  ts = await loadTypeScript(PACKAGE);
  support = read("support.ts", "supportAgent");
  classifier = read("support.ts", "classifier");
  odd = read("unsupported.ts", "oddAgent");
  // The agent behind the Swift client's end-to-end server, whose generated
  // file those tests decode real traffic through.
  e2e = extractAgent(
    ts,
    { file: "../gemi-swift/e2e/server.ts", exportName: "e2eAgent" },
    { cwd: PACKAGE },
  );
}, 60_000);

function type(model: AgentModel, name: string): NamedType {
  const found = model.types.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no type ${name}; have ${model.types.map((t) => t.name).join(", ")}`);
  return found;
}

describe("the Swift the Swift tests compile", () => {
  // The Swift target compiles and exercises these files, so they are the
  // generator's output that is actually proven to work. This is what stops
  // the generator changing underneath them: regenerate, rerun `swift test`.
  test.each([
    ["SupportAgent.swift", () => support],
    ["Classifier.swift", () => classifier],
    // Everything in it is raw JSON somewhere, which must still compile.
    ["OddAgent.swift", () => odd],
    ["E2eAgent.swift", () => e2e],
  ])("%s is what the generator writes today", (file, model) => {
    const target = path.join(SWIFT_GENERATED, file);
    const rendered = renderSwift(model());
    if (process.env.GEMI_UPDATE_FIXTURES === "1") writeFileSync(target, rendered);
    expect(
      rendered,
      `${file} is stale: rerun with GEMI_UPDATE_FIXTURES=1, then \`swift test\` at the repo root`,
    ).toBe(readFileSync(target, "utf8"));
  });
});

describe("reading an agent's types", () => {
  test("every tool, in the order the agent lists them, namespaces flattened", () => {
    expect(support.tools.map((tool) => tool.name)).toEqual([
      "grep",
      "bash",
      "charge",
      "stats",
      "ping",
      "ask",
      "default",
      "refund_order",
    ]);
  });

  test("a tool that cannot yield has progress `never`, one that can has its yield type", () => {
    const tools = Object.fromEntries(support.tools.map((tool) => [tool.name, tool]));
    expect(tools.grep!.progress).toEqual({ kind: "never" });
    expect(tools.bash!.progress).toEqual({ kind: "named", name: "BashProgress" });
  });

  test("a union of yields with a common literal member is a discriminated union", () => {
    expect(type(support, "BashProgress")).toEqual({
      kind: "union",
      name: "BashProgress",
      discriminant: "stage",
      variants: [
        { value: "started", type: { kind: "named", name: "BashProgressStarted" } },
        { value: "line", type: { kind: "named", name: "BashProgressLine" } },
      ],
    });
  });

  test("the `?: undefined` TypeScript adds to each yield is not a field", () => {
    const started = type(support, "BashProgressStarted");
    expect(started.kind === "object" && started.properties.map((p) => p.key)).toEqual([
      "stage",
      "pid",
    ]);
  });

  test("nullable and optional stay apart, because the server tells them apart", () => {
    const input = type(support, "ChargeInput");
    const properties = input.kind === "object" ? input.properties : [];
    expect(properties.find((p) => p.key === "reason")).toEqual({
      key: "reason",
      optional: false,
      type: { kind: "nullable", inner: { kind: "string" } },
    });
    expect(properties.find((p) => p.key === "metadata")).toMatchObject({ optional: true });
  });

  test("a union of number literals is a number, as one of string literals would be an enum", () => {
    const output = type(support, "DefaultOutput");
    expect(output.kind === "object" && output.properties).toEqual([
      { key: "level", optional: false, type: { kind: "number" } },
    ]);
  });

  test("an output with no schema is read off `execute`, a record included", () => {
    const stats = type(support, "StatsOutput");
    expect(stats.kind === "object" && stats.properties[0]).toEqual({
      key: "counts",
      optional: false,
      type: { kind: "map", value: { kind: "number" } },
    });
  });

  test("`unknown` stays JSON, and says nothing — it is not a shape the generator failed", () => {
    expect(support.tools.find((tool) => tool.name === "ping")!.output).toEqual({ kind: "json" });
    expect(support.warnings).toEqual([]);
  });

  test("an agent with an output schema has a typed output; one without has `never`", () => {
    expect(classifier.output).toEqual({ kind: "named", name: "StructuredOutput" });
    expect(support.output).toEqual({ kind: "never" });
  });

  test("the type is named after the export, or after `--name`", () => {
    expect(support.name).toBe("SupportAgent");
    expect(read("support.ts", "supportAgent", "Help").name).toBe("Help");
  }, 60_000);

  test("a default export is named after what it exports", () => {
    expect(read("support.ts", "default").name).toBe("Classifier");
  }, 60_000);

  test("the source is recorded for the file header", () => {
    expect(support.source).toBe("bin/ai-client/__fixtures__/support.ts#supportAgent");
  });
});

describe("what it will not pretend to know", () => {
  test("each unmapped shape is JSON, with a warning that says where", () => {
    const output = type(odd, "OddOutput");
    expect(output.kind === "object" && output.properties.map((p) => [p.key, p.type])).toEqual([
      ["when", { kind: "json" }],
      ["pair", { kind: "json" }],
      ["either", { kind: "json" }],
      ["tree", { kind: "named", name: "OddOutputTree" }],
      ["node", { kind: "named", name: "OddOutputNode" }],
      ["fine", { kind: "number" }],
    ]);
    expect(odd.warnings).toEqual([
      "odd's output.when: `Date` is an object with methods (toString), so the client keeps it as raw JSON.",
      "odd's output.pair: `[string, number]` is a tuple, so the client keeps it as raw JSON.",
      "odd's output.either: `string | number` is a union that is not told apart by one string member, so the client keeps it as raw JSON.",
      "odd's output.tree.children[]: `Tree` is a recursive type, so the client keeps it as raw JSON.",
      'odd\'s output.node (branch).children[] (branch): `{ kind: "branch"; children: Node[]; }` is a recursive type, so the client keeps it as raw JSON.',
    ]);
  });

  test("a union variant that is raw JSON is a JSON case, not a type named after its tag", () => {
    const inner = type(odd, "OddOutputNodeBranchChildrenItem");
    expect(inner.kind === "union" && inner.variants).toEqual([
      { value: "leaf", type: { kind: "named", name: "OddOutputNodeBranchChildrenItemLeaf" } },
      { value: "branch", type: { kind: "json" } },
    ]);
    expect(renderSwift(odd)).toContain(
      'case "branch": self = .branch(try JSONValue(from: decoder))',
    );
  });
});

describe("pointing at the wrong thing", () => {
  test("an export that does not exist lists the ones that do", () => {
    expect(() => read("support.ts", "nope")).toThrow(
      'has no export named "nope". It exports: supportAgent, classifier, default, notAnAgent.',
    );
  }, 60_000);

  test("an export that is not an agent says what it is", () => {
    expect(() => read("support.ts", "notAnAgent")).toThrow(
      "#notAnAgent is not an Agent — it is `{ tools: never[]; }`",
    );
  }, 60_000);

  test("a file that does not exist", () => {
    expect(() => read("missing.ts", "agent")).toThrow(GenerateClientError);
  });

  test("the reference is <file>#<export>, and a bare file means the default export", () => {
    expect(parseAgentReference("app/agents/support.ts#supportAgent")).toEqual({
      file: "app/agents/support.ts",
      exportName: "supportAgent",
    });
    expect(parseAgentReference("app/agents/support.ts")).toEqual({
      file: "app/agents/support.ts",
      exportName: "default",
    });
    expect(() => parseAgentReference("app/agents/support.ts#")).toThrow(GenerateClientError);
  });
});

describe("the command", () => {
  const out = mkdtempSync(path.join(tmpdir(), "gemi-generate-client-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("writes <Name>.swift into --out, creating it", async () => {
    const target = path.join(out, "nested/dir");
    const { file, warnings } = await generateClient({
      agent: `${FIXTURES}/support.ts#supportAgent`,
      out: target,
      platform: "swift",
      cwd: PACKAGE,
    });
    expect(file).toBe(path.join(target, "SupportAgent.swift"));
    expect(readFileSync(file, "utf8")).toBe(renderSwift(support));
    expect(warnings).toEqual([]);
  }, 60_000);

  test("refuses a platform it does not know, before reading anything", async () => {
    await expect(
      generateClient({ agent: "nowhere.ts", out, platform: "java", cwd: PACKAGE }),
    ).rejects.toThrow('--platform must be one of swift, kotlin — got "java".');
  });

  test("says Kotlin is not ready rather than writing something that will not compile", async () => {
    await expect(
      generateClient({ agent: "nowhere.ts", out, platform: "kotlin", cwd: PACKAGE }),
    ).rejects.toThrow("--platform kotlin is not available yet");
  });
});

describe("names", () => {
  test.each([
    ["refund_order", "RefundOrder", "refundOrder"],
    ["max-steps", "MaxSteps", "maxSteps"],
    ["getURL", "GetURL", "getURL"],
    ["URLPath", "URLPath", "urlPath"],
    ["2fa", "_2fa", "_2fa"],
    ["", "Value", "value"],
  ])("%s", (text, pascal, camel) => {
    expect(pascalCase(text)).toBe(pascal);
    expect(camelCase(text)).toBe(camel);
  });
});
