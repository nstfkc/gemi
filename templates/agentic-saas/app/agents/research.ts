import { Agent, AgentTool, OpenAIProvider, s } from "gemi/ai";
import { askTool } from "@/app/agents/tools";

/**
 * Canned, like every tool in this template: the point here is the API, not a
 * search index. Nothing below touches the database or the network, so the
 * template runs with an `OPENAI_API_KEY` and nothing else.
 */
const searchDocsTool = AgentTool.create({
  name: "searchDocs",
  description: "Search the public help centre for an answer",
  inputSchema: s.object({
    query: s.string().describe("What to look for, in the customer's own words"),
  }),
  outputSchema: s.object({ excerpts: s.array(s.string()) }),
  execute: async (input) => ({
    excerpts: [
      `Help centre — "${input.query}": refunds are issued to the original payment method.`,
      `Help centre — "${input.query}": a refund settles within five business days.`,
    ],
  }),
});

/**
 * A sub-agent is an ordinary agent. It is not mounted on a route and has no
 * controller — the only thing that makes it a sub-agent is that a tool runs it.
 *
 * It carries `askTool` on purpose. A sub-agent that can never ask can never
 * escalate, and the interesting case in this template is exactly the one where
 * the question the customer is shown comes from a run they never started.
 */
export const researchAgent = Agent.create({
  name: "research",
  instructions:
    "You research one support question against the help centre and answer it in a single paragraph. Ask the customer only when the answer genuinely depends on something you were not told.",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [searchDocsTool, askTool],
  maxSteps: 6,
});

export const researchTool = AgentTool.create({
  name: "research",
  description: "Hand a question to the research agent and return what it found",
  inputSchema: s.object({
    question: s.string().describe("One self-contained question for the research agent"),
  }),
  outputSchema: s.object({ summary: s.string(), turns: s.number() }),
  execute: async (input, ctx) => {
    // READ THIS BEFORE COPYING THE SHAPE. If the research agent asks the
    // customer something, this call is not paused and resumed where it stood —
    // the whole body is re-entered from the top on the turn that answers,
    // because a JS async generator cannot suspend across a turn boundary.
    // Everything above the `runAgent` therefore runs twice, and `ctx.resumed`
    // is the only way a body can tell the second pass from the first. So a side
    // effect that must happen once — an audit row, a rate-limit tick — goes
    // behind this guard, or after the `runAgent`, or is made idempotent.
    if (!ctx.resumed) {
      console.log(`[support] research requested on run ${ctx.runId}: ${input.question}`);
    }

    const run = await ctx.runAgent(researchAgent, {
      prompt: input.question,
      // Titles the nested block in the UI, so the customer reads "researching
      // the refund window" rather than an unexplained second transcript.
      label: `researching ${input.question}`,
    });

    // A stop() on the parent reaches the sub-run through the inherited signal,
    // so by here the run may have been abandoned; returning a summary from an
    // aborted run would report work nobody waited for.
    ctx.signal.throwIfAborted();

    // `run.nested` is the very record written to this call's
    // `ToolCallPart.nested` and rendered by the client, not a second copy of
    // it, so this summary is built out of what the customer is already looking
    // at.
    const summary = run.nested.messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");

    return { summary, turns: run.messages.length };
  },
});
