// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.
//
// Not part of the module: the same end-to-end shape the sketch had, kept so the
// ergonomics can be read without assembling them from six files.
import { ApiRouter } from "../http";
import { Agent, AgentTool, Skill } from "./Agent";
import { AgentController } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
import { useChat } from "./useChat";

const grepTool = AgentTool.create({
  name: "grep",
  description: "Search for a pattern in a file",
  inputSchema: s.object({
    pattern: s.string().describe("A JavaScript regular expression"),
    filePath: s.string().describe("Path relative to the project root"),
  }),
  outputSchema: s.object({ matches: s.array(s.string()) }),
  execute: async (input, ctx) => {
    ctx.signal.throwIfAborted();
    return { matches: [`Found ${input.pattern} in ${input.filePath}`] };
  },
});

const bashTool = AgentTool.create({
  name: "bash",
  description: "Execute a bash command",
  inputSchema: s.object({ command: s.string() }),
  outputSchema: s.object({ output: s.string(), exitCode: s.number() }),
  requiresApproval: true,
  // Yields become `tool-progress` events, so the UI shows output as it lands.
  execute: async function* (input) {
    yield { line: `$ ${input.command}` };
    return { output: "", exitCode: 0 };
  },
});

// Declared here, implemented by the controller.
const chargeTool = AgentTool.create({
  name: "charge",
  description: "Charge the customer's saved payment method",
  inputSchema: s.object({ amountCents: s.number(), reason: s.string() }),
  outputSchema: s.object({ receiptId: s.string() }),
  deferred: true,
  requiresApproval: true,
});

const refunds = Skill.create({
  name: "refund-policy",
  description: "How refunds are decided, and the wording to use when declining one",
  instructions: () => Bun.file("./app/skills/refunds.md").text(),
});

const supportAgent = Agent.create({
  name: "support",
  instructions: "You are a support agent for an invoicing product.",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [grepTool, bashTool, chargeTool],
  skills: [refunds],
  maxSteps: 12,
  reasoning: "medium",
});

class SupportAgentController extends AgentController<typeof supportAgent> {
  agent = supportAgent;
  store = new MemoryAgentStore();

  tools = {
    charge: async (input, ctx) => {
      const user = await ctx.req.user();
      return { receiptId: `rc_${user.id}_${input.amountCents}` };
    },
  };

  instructions(req) {
    return `Today is ${new Date().toDateString()}.`;
  }

  protected async onMessage(message, ctx) {
    // persistence point
  }
}

class Api extends ApiRouter {
  routes = {
    "/support": this.agent(SupportAgentController).middleware({
      stream: "auth",
      resume: "auth",
      upload: "auth",
    }),
  };
}

function Chat() {
  const { messages, sendMessage, status, pendingApprovals, respond } = useChat("/support");

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-result" && part.name === "grep" && part.status === "ok") {
        part.output.matches; // string[]
      }
    }
  }

  // pendingApprovals[0].name === "charge" → .input is { amountCents, reason }
  return null;
}

// A one-shot structured extraction: same tools, but the answer is a schema.
const classifier = Agent.create({
  name: "classifier",
  provider: OpenAIProvider.model("gpt-5.4"),
  output: s.object({
    sentiment: s.enum(["positive", "neutral", "negative"]),
    topics: s.array(s.string()),
  }),
});
