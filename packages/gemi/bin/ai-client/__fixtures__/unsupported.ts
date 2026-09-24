// Shapes with no faithful Swift or Kotlin spelling. Each must come out as raw
// JSON with a warning naming where it was — never as a type that claims more
// than the wire promises.
import { Agent, AgentTool, OpenAIProvider, s } from "../../../ai";

type Tree = { label: string; children: Tree[] };
type Node = { kind: "leaf"; value: string } | { kind: "branch"; children: Node[] };

const odd = AgentTool.create({
  name: "odd",
  description: "Returns everything the generator cannot map",
  inputSchema: s.object({ id: s.string() }),
  execute: async () => ({
    // A class instance: what arrives is `JSON.stringify`'s string.
    when: new Date(),
    // A tuple.
    pair: ["a", 1] as [string, number],
    // A union with no string member to tell the halves apart.
    either: "text" as string | number,
    // A recursive type.
    tree: { label: "root", children: [] } as Tree,
    // A recursive tagged union: typed one level deep, then a variant that is
    // raw JSON inside a union that is not.
    node: { kind: "leaf", value: "a" } as Node,
    // Nothing wrong with this one, beside the others.
    fine: 1,
  }),
});

export const oddAgent = Agent.create({
  name: "odd",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [odd],
});
