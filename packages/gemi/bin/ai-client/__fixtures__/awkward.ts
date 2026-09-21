// An agent whose names and wire strings collide with the language a client is
// written in. Nothing here is a shape the generator has not seen in
// `support.ts`; what it adds is names that a careless renderer would let
// shadow something, and strings it would let be read as code.
//
// Not an app, as with `support.ts`: the generator only reads its types.
import { Agent, AgentTool, OpenAIProvider, s } from "../../../ai";

// `$` starts a string template in Kotlin, and JSON Schema keys start with it:
// a key, an enum value and a union's discriminant, all on the wire as `$...`.
const lookup = AgentTool.create({
  name: "lookup",
  description: "Resolve a reference",
  inputSchema: s.object({ $ref: s.string(), mode: s.enum(["$all", "some"]) }),
  outputSchema: s.object({ found: s.boolean() }),
  execute: async function* () {
    yield { $type: "hit" as const, id: "a" };
    yield { $type: "miss" as const };
    return { found: true };
  },
});

// Each tool is a class inside the generated views, so these are named after
// what those views refer to: the standard types, one of this agent's own
// types (`lookup` + `_input`), a view, and the agent itself.
const list = AgentTool.create({
  name: "list",
  description: "List a directory",
  inputSchema: s.object({ dir: s.string() }),
  outputSchema: s.array(s.string()),
  execute: async () => ["a.ts"],
});

const string = AgentTool.create({
  name: "string",
  description: "Echo",
  inputSchema: s.object({ text: s.string() }),
  outputSchema: s.object({ text: s.string() }),
  execute: async (input) => ({ text: input.text }),
});

const map = AgentTool.create({
  name: "map",
  description: "Counts by label",
  inputSchema: s.object({}),
  execute: async () => ({}) as Record<string, number>,
});

const lookupInput = AgentTool.create({
  name: "lookup_input",
  description: "Nothing",
  inputSchema: s.object({}),
  outputSchema: s.number(),
  execute: async () => 1,
});

const toolCall = AgentTool.create({
  name: "tool_call",
  description: "Nothing",
  inputSchema: s.object({}),
  outputSchema: s.object({ ok: s.boolean() }),
  execute: async () => ({ ok: true }),
});

const sameAsTheAgent = AgentTool.create({
  name: "awkward_agent",
  description: "Nothing",
  inputSchema: s.object({}),
  outputSchema: s.object({ ok: s.boolean() }),
  execute: async () => ({ ok: true }),
});

// Always throws, so the checker says its output is `never`: a tool's output
// can be, not only its progress.
const fail = AgentTool.create({
  name: "fail",
  description: "Nothing",
  inputSchema: s.object({}),
  execute: async () => {
    throw new Error("no");
  },
});

export const awkwardAgent = Agent.create({
  name: "awkward",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [lookup, list, string, map, lookupInput, toolCall, sameAsTheAgent, fail],
});
