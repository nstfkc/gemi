// `s.json()` is free-form on purpose, so the client keeps it as raw JSON and
// says nothing about it. An app type that happens to be called `JsonValue` is a
// different type and keeps the mapping it earns — the name is a common one.
import { Agent, AgentTool, OpenAIProvider, s } from "../../../ai";

// What Prisma and type-fest each export under this name, and what an app writes
// for itself. A set of string literals, which the generator gives an enum.
type JsonValue = "draft" | "published" | "archived";

const store = AgentTool.create({
  name: "store",
  description: "Store a document of any shape",
  inputSchema: s.object({ id: s.string() }),
  outputSchema: s.object({ definition: s.json() }),
  execute: async () => ({ definition: { anything: [1, true, null] } }),
});

const publish = AgentTool.create({
  name: "publish",
  description: "Publish a document",
  inputSchema: s.object({ id: s.string() }),
  execute: async () => ({ status: "draft" as JsonValue }),
});

export const jsonValueAgent = Agent.create({
  name: "jsonValue",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [store, publish],
});
