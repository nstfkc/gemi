import { Agent, AgentController, MemoryAgentStore, OpenAIProvider } from "gemi/ai";
import type { AgentHookContext, AgentMessage, PendingToolCall } from "gemi/ai";
import type { HttpRequest } from "gemi/http";
import { billingNamespace } from "@/app/agents/billing";
import { researchTool } from "@/app/agents/research";
import { refundPolicySkill } from "@/app/agents/skills";
import {
  askTool,
  issueRefundTool,
  lookupOrdersTool,
  orderDetailTool,
  runDiagnosticsTool,
} from "@/app/agents/tools";

/**
 * The one agent this app mounts.
 *
 * Everything it can do arrives as an entry in `tools`: plain calls, one that
 * asks before it runs, one that reports progress while it runs, the question
 * tool the customer answers, a tool that runs a second agent, and a whole
 * namespace whose schemas are not sent until the model goes looking for them.
 * The skill is loaded the same way — on demand, when the conversation turns to
 * refunds — which is why the policy is a markdown file rather than another
 * paragraph in `instructions` that every unrelated turn pays for.
 */
export const supportAgent = Agent.create({
  name: "support",
  instructions:
    "You are a support agent for an invoicing product. Look up the facts before you answer, load the refund policy before you promise a refund, and ask the customer rather than guessing at an order number.",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [
    lookupOrdersTool,
    orderDetailTool,
    issueRefundTool,
    runDiagnosticsTool,
    askTool,
    researchTool,
    billingNamespace,
  ],
  skills: [refundPolicySkill],
  maxSteps: 12,
  reasoning: "medium",
  // How deep `ctx.runAgent` may go below this run. Read from the agent at the
  // root and carried down, so a sub-agent raising its own cannot deepen a tree
  // it did not start, and a cycle fails with a sentence naming the chain rather
  // than exhausting the stack.
  maxDepth: 2,
});

/**
 * Module scope, and not `store = new MemoryAgentStore()` in the class body.
 *
 * A controller is constructed fresh for every request, so a store built in a
 * field is a brand-new empty store on every turn: `createThread` hands out an
 * id that the next request's store has never heard of, and the history reads
 * back as nothing. That failure is silent, because an empty conversation is a
 * legal one — the second turn simply forgets the first and the model answers
 * as if the customer had just arrived. Anything that outlives the request will
 * do; this one lasts as long as the process, which is what a template wants
 * and not what a deployment with more than one server does.
 */
export const supportStore = new MemoryAgentStore();

export class SupportAgentController extends AgentController<typeof supportAgent> {
  agent = supportAgent;
  store = supportStore;

  /**
   * Appended to the agent's static instructions for this request only — the
   * per-request half of the prompt, which is why it lives here and not on
   * `Agent.create`: this is the object that has the request.
   *
   * `req` is typed rather than left implicit so a wrong override is a compile
   * error instead of a silently `any` parameter that agrees with the mistake.
   */
  instructions(req: HttpRequest<any, any>) {
    void req;
    return `Today is ${new Date().toDateString()}.`;
  }

  /**
   * Fires for every completed message, the customer's turns as well as the
   * agent's, and it is where an app that is not relying on `store` writes them
   * down. A hook that throws is reported and the run carries on, so this is
   * safe to point at a database that may be having a bad day — the answer the
   * customer is already reading is not lost to a failed INSERT.
   */
  protected async onMessage(message: AgentMessage, ctx: AgentHookContext) {
    console.log(`[support] ${message.role} message on run ${ctx.runId}`);
  }

  /**
   * Fires just before the stream ends `awaiting-input`. It is the place to
   * reach whoever has to answer when that is not the person watching the
   * stream: a refund approval that needs a supervisor is an email or a Slack
   * ping from here, because the pending call is durable and the browser tab
   * that started it may already be closed.
   */
  protected async onAwaitingInput(pending: PendingToolCall[], ctx: AgentHookContext) {
    for (const call of pending) {
      console.log(`[support] run ${ctx.runId} is waiting on ${call.kind} for ${String(call.name)}`);
    }
  }
}
