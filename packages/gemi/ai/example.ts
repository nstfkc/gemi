// Not part of the module's public surface, and not imported by it: the same
// end-to-end shape the RFC promised, kept so the ergonomics can be read without
// assembling them from six files.
//
// It is typechecked, which is the point. This file is the acceptance test for
// the module — if the usage the RFC advertised does not compile against the
// real implementations, the implementations are wrong, not the example.
import { Auth } from "../facades";
import { ApiRouter, type CreateRPC } from "../http";
import type { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool, Skill, ToolNamespace } from "./Agent";
import { AgentController, type AgentHookContext, MemoryAgentStore } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import type { AgentMessage, PendingToolCall } from "./types";
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

const chargeTool = AgentTool.create({
  name: "charge",
  description: "Charge the customer's saved payment method",
  inputSchema: s.object({ amountCents: s.number(), reason: s.string() }),
  outputSchema: s.object({ receiptId: s.string() }),
  requiresApproval: true,
  // `ctx.req` is the request this run started from, which is what lets a tool
  // read the caller. The identity itself comes off the `Auth` facade, the same
  // way every other gemi controller reads it — `HttpRequest` has no `user()`.
  execute: async (input, ctx) => {
    ctx.signal.throwIfAborted();
    const user = await Auth.user();
    return { receiptId: `rc_${user.id}_${input.amountCents}` };
  },
});

const listOrdersTool = AgentTool.create({
  name: "listOrders",
  description: "List a customer's recent orders",
  inputSchema: s.object({ customerId: s.string() }),
  outputSchema: s.object({ orderIds: s.array(s.string()) }),
  execute: async (input) => ({ orderIds: [] }),
});

const orderDetailTool = AgentTool.create({
  name: "orderDetail",
  description: "Read one order in full",
  inputSchema: s.object({ orderId: s.string() }),
  outputSchema: s.object({ totalCents: s.number(), status: s.string() }),
  execute: async (input) => ({ totalCents: 0, status: "paid" }),
});

const refundOrderTool = AgentTool.create({
  name: "refundOrder",
  description: "Refund an order in full",
  inputSchema: s.object({ orderId: s.string() }),
  outputSchema: s.object({ refundId: s.string() }),
  requiresApproval: true,
  execute: async (input) => ({ refundId: "rf_1" }),
});

// A group the model searches rather than reads. Every schema in here is
// withheld until it decides it wants one, which is what keeps a long tail of
// rarely-used tools from costing anything on the turns that never touch them.
const crm = ToolNamespace.create({
  name: "crm",
  description: "Customer records, orders and refunds",
  deferred: true,
  tools: [listOrdersTool, orderDetailTool, refundOrderTool],
});

// Answered by the person, not the server. Same mechanism as an approval.
const askTool = AgentTool.ask({
  name: "ask",
  description: "Ask the customer for something you need before continuing",
  outputSchema: s.object({ answer: s.string() }),
});

const refunds = Skill.create({
  name: "refund-policy",
  description: "How refunds are decided, and the wording to use when declining one",
  instructions: () => Bun.file("./app/skills/refunds.md").text(),
});

// --- A tool that runs another agent -----------------------------------------
//
// The headline of the nesting slice, kept here for the same reason as
// everything above it: if the shape the RFC advertised does not compile against
// the real `ToolContext`, the runtime is wrong and this file is how we find out.

const searchDocsTool = AgentTool.create({
  name: "searchDocs",
  description: "Search the public documentation",
  inputSchema: s.object({ query: s.string() }),
  outputSchema: s.object({ excerpts: s.array(s.string()) }),
  execute: async (input) => ({ excerpts: [`docs matching ${input.query}`] }),
});

// A sub-agent is an ordinary agent. It is not registered on a route and has no
// controller of its own — the only thing that makes it a sub-agent is that a
// tool runs it. Its own `ask` is what makes the escalation below real: a
// sub-agent that can never ask can never escalate, and the interesting case is
// the one where the question comes from a run the user never started.
const researchAgent = Agent.create({
  name: "research",
  instructions: "You research a question and answer it in one paragraph.",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [searchDocsTool, askTool],
  maxSteps: 6,
});

const researchTool = AgentTool.create({
  name: "research",
  description: "Hand a question to the research agent and return what it found",
  inputSchema: s.object({ question: s.string() }),
  outputSchema: s.object({ summary: s.string(), turns: s.number() }),
  execute: async (input, ctx) => {
    // READ THIS BEFORE COPYING THE SHAPE. If the sub-agent asks the user
    // something, this tool call is not resolved and returned to — the whole
    // body is re-entered from the top on the turn that answers, because a JS
    // async generator cannot suspend across a turn boundary. So everything
    // above the `runAgent` runs twice. `ctx.resumed` is how a body tells the
    // second pass from the first; the alternative is to put side effects
    // *after* the call, or make them idempotent.
    if (!ctx.resumed) {
      // first-attempt-only work goes here — an audit row, a rate-limit tick
    }

    const run = await ctx.runAgent(researchAgent, {
      prompt: input.question,
      // Shown on the nested block in the UI, so the user reads "researching
      // pricing" rather than an unlabelled second transcript.
      label: `researching ${input.question}`,
    });

    // `run.nested` is the very object recorded on this call's
    // `ToolCallPart.nested` and rendered by the client — not a second
    // representation of it — so a tool that wants to summarize what its
    // sub-agent did reads what the user is already looking at.
    ctx.signal.throwIfAborted();
    const summary = run.nested.messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");

    return { summary, turns: run.messages.length };
  },
});

// The autonomous variant: `onPending: "deny"` refuses the sub-agent's questions
// in place, so this tool always returns rather than escalating. Inherited all
// the way down, so a grandchild cannot ask either — which is the only way the
// promise "nothing from this subtree reaches the user" is worth making.
const triageTool = AgentTool.create({
  name: "triage",
  description: "Classify a ticket without ever asking the customer anything",
  inputSchema: s.object({ ticket: s.string() }),
  outputSchema: s.object({ verdict: s.string() }),
  execute: async (input, ctx) => {
    const run = await ctx.runAgent(researchAgent, {
      prompt: `Classify: ${input.ticket}`,
      onPending: "deny",
    });
    return { verdict: run.finishReason };
  },
});

const supportAgent = Agent.create({
  name: "support",
  instructions: "You are a support agent for an invoicing product.",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [grepTool, bashTool, chargeTool, askTool, researchTool, triageTool, crm],
  skills: [refunds],
  maxSteps: 12,
  reasoning: "medium",
  // How deep `ctx.runAgent` may go below this run. Read from the agent at the
  // ROOT and carried down, so a sub-agent raising its own cannot deepen a tree
  // it did not start — and a cycle (an agent whose tool runs itself) fails with
  // a sentence naming the chain instead of exhausting the stack.
  maxDepth: 2,
});

// Module scope, NOT `store = new MemoryAgentStore()` in the class body. A
// controller is constructed fresh for every request, so a store built in a
// field is an empty store on every turn and a threaded conversation reads back
// nothing — silently, because an empty history is a legal one. `AgentController`
// already defaults to a process-wide instance; this is what overriding it
// correctly looks like.
const supportStore = new MemoryAgentStore();

class SupportAgentController extends AgentController<typeof supportAgent> {
  agent = supportAgent;
  store = supportStore;

  // Typed rather than left implicit: the package compiles with `strict: false`,
  // so an untyped parameter is `any` and an override with the wrong shape would
  // still compile — which would make this file agree with a mistake instead of
  // catching one.
  instructions(req: HttpRequest<any, any>) {
    return `Today is ${new Date().toDateString()}.`;
  }

  protected async onMessage(message: AgentMessage, ctx: AgentHookContext) {
    // persistence point
  }

  protected async onAwaitingInput(pending: PendingToolCall[], ctx: AgentHookContext) {
    // e.g. notify an approver who is not the person watching the stream
  }
}

class Api extends ApiRouter {
  routes = {
    "/support": this.agent(SupportAgentController).middleware({
      stream: "auth",
      attach: "auth",
      stop: "auth",
      upload: "auth",
    }),
  };
}

/**
 * What an app's generated `gemi.d.ts` writes for it, spelled out here because
 * this file is not an app.
 *
 * `useChat` takes its path from `RPC` — the same interface `useQuery` reads —
 * so without this the key `"/support"` does not exist and the hook is
 * uncallable. Writing it by hand is what makes the rest of `Chat` below a real
 * test of the claim that the agent's tool types ride along on the route: the
 * `part.output.matches` and `call.input.amountCents` further down are inferred
 * through `Agent` -> `AgentRoute` -> `CreateRPC` -> `useChat`, and if any link
 * erased them this file would stop compiling.
 *
 * It does not escape: nothing imports this file, and `exports` does not publish
 * a `gemi/ai/example` subpath, so the emitted declaration is unreachable from
 * an application and `"/support"` never appears in a real app's `RPC`.
 */
declare module "../client/rpc" {
  interface RPC extends CreateRPC<Api> {}
}

// The app's own transcript component, stubbed. The point of the signature is
// that the nested walk below hands it `run.messages` and it compiles: a sub-run
// is rendered by whatever already renders a run.
declare function renderTranscript(messages: AgentMessage[]): null;

function Chat({ threadId }: { threadId: string }) {
  // Reattaches on mount if a run is still going on this thread.
  const { messages, sendMessage, status, pending, approve, answer, loadedTools } = useChat(
    "/support",
    { threadId },
  );

  // What the model has pulled out of a deferred namespace so far this run —
  // somewhere to put "…looking for the right tool" instead of an unexplained
  // pause. Run-scoped, not transcript: empty again on the next run, so it is
  // not something to persist beside `messages`.
  loadedTools.join(", ");

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-result" && part.name === "grep" && part.status === "ok") {
        part.output.matches; // string[]
      }

      // A generator tool's yields, typed by what its `execute` actually yields
      // rather than as `unknown`. `bash` yields `{ line: string }`, so this is
      // `{ line: string }[] | undefined` — and a tool that never yields gets
      // `never[]`, which is what stops a UI writing a progress renderer for a
      // tool that can have none.
      if (part.type === "tool-call" && part.name === "bash") {
        part.progress?.map((entry) => entry.line); // string[]
      }

      // The sub-agent runs this tool drove. Each is an ordinary
      // `AgentMessage[]` with a name and a label, so the component that renders
      // `messages` renders this too — which is the whole reason nesting reuses
      // the transcript shape instead of inventing a second one.
      if (part.type === "tool-call" && part.name === "research") {
        for (const run of part.nested ?? []) {
          run.label ?? run.agent; // what to title the block with
          run.finishReason; // undefined while it is still going
          renderTranscript(run.messages);
        }
      }
    }
  }

  if (status === "awaiting-input") {
    for (const call of pending) {
      if (call.kind === "approval" && call.name === "charge") {
        call.input.amountCents; // number
        approve(call.toolCallId, true);
      }
      if (call.kind === "question") {
        // A question the RESEARCH agent asked arrives in this same list, with
        // `path` naming the chain of tool calls it is nested under. Answering
        // it is the identical call — the hook carries the signature and the
        // path back untouched — so a UI reads `path` only to say who is asking,
        // never to route the answer.
        const asker = call.path?.length ? "the research agent" : "support";
        answer(call.toolCallId, { answer: `the invoice from March (for ${asker})` });
      }
    }
  }

  // An answer can also ride along with text, in one ordinary turn:
  //   sendMessage({ text: "yes, but only half", toolResults: [...] })
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
