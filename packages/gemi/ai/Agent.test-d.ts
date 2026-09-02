/**
 * Type-level tests for the agent surface.
 *
 * Every claim this module makes about types is made through conditional and
 * mapped types — the schema builder inferring a tool's input, a namespace
 * flattening into tool names, the tool tuple surviving the trip through
 * `AgentRoute` and `RPC` into the browser. None of it is exercised by a runtime
 * test, and the module's own files carry `@ts-nocheck`, so without these
 * assertions the inference can stop working and nothing says so.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import { Agent, AgentTool, Skill, ToolNamespace, type ToolShapesOf } from "./Agent";
import { AgentController, type AgentRouteRPC } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s, type Infer } from "./Schema";
import type {
  AgentMessage,
  FinishReason,
  NestedRun,
  PendingToolCall,
  ToolCallPart,
  ToolShapes,
} from "./types";

/**
 * `toEqualTypeOf<never>()` is not a test — `never` is assignable to everything,
 * so it passes against a type that is merely empty as well as against the one
 * that is actually `never`. Wrapping in a tuple defeats the distribution and
 * turns the claim into one that can fail.
 */
type IsNever<T> = [T] extends [never] ? true : false;

const bash = AgentTool.create({
  name: "bash",
  description: "Execute a bash command",
  inputSchema: s.object({ command: s.string(), cwd: s.string().optional() }),
  outputSchema: s.object({ output: s.string() }),
  requiresApproval: true,
  execute: async (input) => ({ output: input.command }),
});

const listOrders = AgentTool.create({
  name: "listOrders",
  description: "List a customer's recent orders",
  inputSchema: s.object({ customerId: s.string() }),
  outputSchema: s.object({ orderIds: s.array(s.string()) }),
  execute: async () => ({ orderIds: [] as string[] }),
});

const refundOrder = AgentTool.create({
  name: "refundOrder",
  description: "Refund an order in full",
  inputSchema: s.object({ orderId: s.string() }),
  outputSchema: s.object({ refundId: s.string() }),
  requiresApproval: true,
  execute: async () => ({ refundId: "rf_1" }),
});

const ask = AgentTool.create({
  name: "ask",
  description: "Ask the customer something",
  inputSchema: s.object({ question: s.string() }),
  outputSchema: s.object({ answer: s.string() }),
  answeredBy: "client",
});

/**
 * The generator form. Nothing here writes the progress type down: it is read
 * off the yields, and this tool exists to prove that it survives the trip
 * through the namespace, `ToolShapesOf` and into the browser's vocabulary.
 */
const research = AgentTool.create({
  name: "research",
  description: "Look something up, slowly",
  inputSchema: s.object({ topic: s.string() }),
  outputSchema: s.object({ summary: s.string() }),
  execute: async function* (input) {
    yield { stage: "searching" };
    yield { stage: "reading" };
    return { summary: input.topic };
  },
});

const crm = ToolNamespace.create({
  name: "crm",
  description: "Customer records, orders and refunds",
  deferred: true,
  tools: [listOrders, refundOrder],
});

const support = Agent.create({
  name: "support",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [bash, ask, research, crm],
  skills: [
    Skill.create({
      name: "refund-policy",
      description: "How refunds are decided",
      instructions: "…",
    }),
  ],
});

class SupportController extends AgentController<typeof support> {
  agent = support;
}

type Shapes = ToolShapesOf<typeof support.tools>;

describe("the schema builder", () => {
  test("infers the object type it describes", () => {
    const schema = s.object({ command: s.string(), cwd: s.string().optional() });
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{ command: string; cwd?: string }>();
  });

  test("types a tool's execute argument from its input schema", () => {
    AgentTool.create({
      name: "grep",
      description: "Search",
      inputSchema: s.object({ pattern: s.string() }),
      outputSchema: s.object({ matches: s.array(s.string()) }),
      execute: async (input, ctx) => {
        expectTypeOf(input).toEqualTypeOf<{ pattern: string }>();
        expectTypeOf(ctx.runId).toEqualTypeOf<string>();
        return { matches: [] as string[] };
      },
    });
  });
});

describe("a tool definition", () => {
  test("requires an implementation, or a client to answer it", () => {
    // @ts-expect-error a server tool without `execute` is nothing at all
    AgentTool.create({
      name: "noop",
      description: "…",
      inputSchema: s.object({}),
      outputSchema: s.object({}),
    });
  });

  test("refuses an implementation for a tool the client answers", () => {
    // @ts-expect-error the browser answers this one; the server cannot
    AgentTool.create({
      name: "askTwice",
      description: "…",
      inputSchema: s.object({ question: s.string() }),
      outputSchema: s.object({ answer: s.string() }),
      answeredBy: "client",
      execute: async () => ({ answer: "" }),
    });
  });

  test("refuses approval on a client tool, where answering is the approval", () => {
    // @ts-expect-error nothing to approve — the client already answered
    AgentTool.create({
      name: "askThrice",
      description: "…",
      inputSchema: s.object({ question: s.string() }),
      outputSchema: s.object({ answer: s.string() }),
      answeredBy: "client",
      requiresApproval: true,
    });
  });
});

describe("an agent's tools", () => {
  test("carry no namespace of their own, because a tool is a singleton", () => {
    // The same tool may be grouped one way by one agent and another way by the
    // next, so a field on the tool naming its group can only report whichever
    // namespace was constructed last — to every agent sharing it. Where a tool
    // sits is a property of the agent, and this is what keeps that true.
    expectTypeOf(refundOrder).not.toHaveProperty("namespace");
  });

  test("flatten out of their namespaces, keyed by tool name", () => {
    expectTypeOf<keyof Shapes>().toEqualTypeOf<
      "bash" | "ask" | "research" | "listOrders" | "refundOrder"
    >();
  });

  test("keep their payload types through the flattening", () => {
    expectTypeOf<Shapes["bash"]["input"]>().toEqualTypeOf<{ command: string; cwd?: string }>();
    expectTypeOf<Shapes["refundOrder"]["output"]>().toEqualTypeOf<{ refundId: string }>();
  });

  test("reach the client through the route, not a second augmentation", () => {
    expectTypeOf<AgentRouteRPC<typeof SupportController>["tools"]>().toEqualTypeOf<Shapes>();
  });
});

describe("a tool's progress type", () => {
  test("is inferred from an async generator's yields, unwritten by the author", () => {
    // The tool's own type first — if `AgentTool.create` did not pick the yield
    // type up, `ToolShapesOf` has nothing to carry and the assertion below
    // would be testing the mapped type against a default rather than a fact.
    expectTypeOf(research).toEqualTypeOf<
      AgentTool<"research", { topic: string }, { summary: string }, { stage: string }>
    >();
    expectTypeOf<Shapes["research"]["progress"]>().toEqualTypeOf<{ stage: string }>();
  });

  test("is `never` for a tool that resolves once, and for one the client answers", () => {
    // The claim that matters: a tool with no way to yield does not quietly get
    // `unknown`, which would type a progress log the tool can never fill and
    // hand the browser a datum it must narrow by hand.
    expectTypeOf<IsNever<Shapes["bash"]["progress"]>>().toEqualTypeOf<true>();
    expectTypeOf<IsNever<Shapes["ask"]["progress"]>>().toEqualTypeOf<true>();
    expectTypeOf<IsNever<Shapes["research"]["progress"]>>().toEqualTypeOf<false>();
  });

  test("types the progress log on the tool call it accumulates on", () => {
    const part = {} as ToolCallPart<Shapes>;
    if (part.name === "research") {
      expectTypeOf(part.progress).toEqualTypeOf<{ stage: string }[]>();
    }
  });

  test("leaves a hand-written shapes map with no `progress` member compiling", () => {
    // `ToolShape.progress` is optional for exactly this: an app that spelled
    // its own shapes out before the field existed — or a test fixture that
    // still does — must keep working, and `T[K][\"progress\"]` must resolve for
    // it rather than fail to instantiate.
    type Legacy = { echo: { input: { text: string }; output: { text: string } } };
    expectTypeOf<Legacy>().toMatchTypeOf<ToolShapes>();
    const part = {} as ToolCallPart<Legacy>;
    if (part.name === "echo") {
      expectTypeOf(part.input).toEqualTypeOf<{ text: string }>();
    }
  });
});

describe("a pending tool call", () => {
  test("narrows its input on the tool's name", () => {
    const pending = {} as PendingToolCall<Shapes>;
    if (pending.name === "refundOrder") {
      expectTypeOf(pending.input).toEqualTypeOf<{ orderId: string }>();
    }
    if (pending.name === "ask") {
      expectTypeOf(pending.input).toEqualTypeOf<{ question: string }>();
    }
  });

  test("carries the signature that makes answering it trustworthy", () => {
    expectTypeOf<PendingToolCall<Shapes>["signature"]>().toEqualTypeOf<string>();
  });

  test("still narrows on name once it can carry a nesting path", () => {
    // `path` is a new member of every arm of the union, so it is exactly the
    // kind of addition that turns a discriminated union into a mush — the
    // narrowing below is what says it did not.
    const pending = {} as PendingToolCall<Shapes>;
    expectTypeOf(pending.path).toEqualTypeOf<string[]>();
    if (pending.name === "refundOrder") {
      expectTypeOf(pending.input).toEqualTypeOf<{ orderId: string }>();
      expectTypeOf(pending.path).toEqualTypeOf<string[]>();
    }
    if (pending.name === "research") {
      expectTypeOf(pending.input).toEqualTypeOf<{ topic: string }>();
    }
  });
});

describe("AgentTool.ask", () => {
  test("is a client tool whose input is the prompt itself", () => {
    const askName = AgentTool.ask({
      name: "askName",
      description: "Ask the customer their name",
      outputSchema: s.object({ name: s.string() }),
    });
    expectTypeOf(askName).toEqualTypeOf<AgentTool<"askName", { question: string }, { name: string }>>();
  });
});

describe("a skill", () => {
  test("keeps its name a literal, so a registry of them stays discriminable", () => {
    const skill = Skill.create({
      name: "refund-policy",
      description: "How refunds are decided",
      instructions: () => "…",
    });
    expectTypeOf(skill).toEqualTypeOf<Skill<"refund-policy">>();
  });
});

describe("a run", () => {
  test("carries the tool shapes all the way into its result", () => {
    const run = support.stream({} as any);
    type Result = Awaited<ReturnType<typeof run.result>>;
    expectTypeOf<Result["runId"]>().toEqualTypeOf<string>();

    const part = {} as Result["messages"][number]["content"][number];
    if (part.type === "tool-result" && part.name === "listOrders" && part.status === "ok") {
      expectTypeOf(part.output).toEqualTypeOf<{ orderIds: string[] }>();
    }
    if (part.type === "tool-call" && part.name === "bash") {
      expectTypeOf(part.input).toEqualTypeOf<{ command: string; cwd?: string }>();
    }
  });
});

describe("ctx.runAgent", () => {
  test("hands a tool the nesting state and a typed sub-run result", () => {
    // Written as a tool rather than against `ToolContext` directly, because the
    // context a tool is *given* is the only place these types matter, and it
    // arrives through `ToolExecute`'s second parameter rather than by
    // annotation.
    AgentTool.create({
      name: "delegate",
      description: "Hand the question to a specialist",
      inputSchema: s.object({ topic: s.string() }),
      outputSchema: s.object({ summary: s.string() }),
      execute: async (input, ctx) => {
        expectTypeOf(ctx.depth).toEqualTypeOf<number>();
        expectTypeOf(ctx.resumed).toEqualTypeOf<boolean>();

        const run = await ctx.runAgent(support, { prompt: input.topic, label: "delegating" });
        expectTypeOf(run.runId).toEqualTypeOf<string>();
        expectTypeOf(run.agent).toEqualTypeOf<string>();
        expectTypeOf(run.finishReason).toEqualTypeOf<FinishReason>();
        // The sub-agent's tools are not this agent's, so the nested transcript
        // is the unparameterised one. Typing it with the parent's shapes would
        // name tool calls the sub-agent cannot make.
        expectTypeOf(run.messages).toEqualTypeOf<AgentMessage[]>();
        expectTypeOf(run.nested).toEqualTypeOf<NestedRun>();
        return { summary: String(run.output ?? "") };
      },
    });
  });

  test("takes maxDepth on the agent, beside the other run limits", () => {
    const bounded = Agent.create({
      name: "bounded",
      provider: OpenAIProvider.model("gpt-5.4"),
      maxDepth: 1,
    });
    expectTypeOf(bounded.maxDepth).toEqualTypeOf<number>();
  });
});
