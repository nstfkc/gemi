// The agent `ai:generate-client` is tested against. Every tool is here for a
// shape the generator has to map, and the comment on each says which.
//
// Not an app: nothing runs this file, the generator only reads its types. It
// imports gemi by relative path so the checker resolves the same `Agent.ts`
// the rest of the package compiles, which is the copy an app would have.
import { Agent, AgentTool, OpenAIProvider, s, ToolNamespace } from "../../../ai";

// Flat input and output, both from schemas.
const grep = AgentTool.create({
  name: "grep",
  description: "Search for a pattern in a file",
  inputSchema: s.object({ pattern: s.string(), filePath: s.string() }),
  outputSchema: s.object({ matches: s.array(s.string()) }),
  execute: async (input) => ({ matches: [input.pattern] }),
});

// A generator: its progress type exists only in TypeScript — no schema — and
// is the reason the generator reads types at all. The yield is a union of two
// shapes with a common `stage` literal, so it becomes a discriminated enum.
const bash = AgentTool.create({
  name: "bash",
  description: "Execute a bash command",
  inputSchema: s.object({ command: s.string(), timeoutSeconds: s.number().optional() }),
  outputSchema: s.object({ output: s.string(), exitCode: s.number() }),
  requiresApproval: true,
  execute: async function* (input) {
    yield { stage: "started" as const, pid: 42 };
    yield {
      stage: "line" as const,
      text: `$ ${input.command}`,
      stream: "stdout" as "stdout" | "stderr",
    };
    return { output: "", exitCode: 0 };
  },
});

// Nesting, enums, optional versus nullable, a record, and a discriminated
// union in the output.
const charge = AgentTool.create({
  name: "charge",
  description: "Charge the customer's saved payment method",
  inputSchema: s.object({
    amountCents: s.number(),
    currency: s.enum(["usd", "eur", "try"]),
    reason: s.string().nullable(),
    metadata: s
      .object({
        orderId: s.string(),
        lineItems: s.array(s.object({ sku: s.string(), qty: s.number() })),
      })
      .optional(),
  }),
  outputSchema: s.union([
    s.object({ status: s.literal("paid"), receiptId: s.string() }),
    s.object({ status: s.literal("declined"), declineCode: s.string(), retryable: s.boolean() }),
  ]),
  execute: async () => ({ status: "paid" as const, receiptId: "rc_1" }),
});

// No output schema: the output type is inferred from `execute`, and a record
// has no JSON Schema spelling at all.
const stats = AgentTool.create({
  name: "stats",
  description: "Counts by label",
  inputSchema: s.object({ since: s.string() }),
  execute: async () => ({ counts: {} as Record<string, number>, generatedAt: "now" }),
});

// Neither a schema nor a return worth typing: `unknown` output stays JSON.
const ping = AgentTool.create({
  name: "ping",
  description: "Nothing",
  inputSchema: s.object({}),
  execute: async (): Promise<unknown> => null,
});

// A question: answered by the app, so its output is what the app encodes.
const ask = AgentTool.ask({
  name: "ask",
  description: "Ask the customer something",
  outputSchema: s.object({ answer: s.string() }),
});

// A snake_case tool name and a keyword for a key, inside a namespace.
const refundOrder = AgentTool.create({
  name: "refund_order",
  description: "Refund an order in full",
  inputSchema: s.object({ orderId: s.string() }),
  outputSchema: s.object({ refundId: s.string(), default: s.boolean() }),
  execute: async () => ({ refundId: "rf_1", default: true }),
});

// Swift keywords everywhere a name can be one: the tool (`case \`default\``),
// and the keys of a struct that needs its own `encode` because one of them is
// a required nullable. And a union of number literals, which is a number.
const keywords = AgentTool.create({
  name: "default",
  description: "Keywords",
  inputSchema: s.object({ in: s.string().nullable(), for: s.string() }),
  execute: async () => ({ level: 1 as 1 | 2 | 3 }),
});

const crm = ToolNamespace.create({
  name: "crm",
  description: "Customer records",
  deferred: true,
  tools: [refundOrder],
});

export const supportAgent = Agent.create({
  name: "support",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [grep, bash, charge, stats, ping, ask, keywords, crm],
});

// A structured final answer.
export const classifier = Agent.create({
  name: "classifier",
  provider: OpenAIProvider.model("gpt-5.4"),
  output: s.object({
    sentiment: s.enum(["positive", "neutral", "negative"]),
    topics: s.array(s.string()),
  }),
});

export default classifier;

// Not an agent, for the error.
export const notAnAgent = { tools: [] };
