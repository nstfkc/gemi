/**
 * Type-level tests for per-agent typed contexts (#1019): `Agent.withContext`,
 * a tool's `Ctx`, `ContextOf`, and the controller, `stream`, `runAgent` and
 * MCP surfaces that take it.
 *
 * This program compiles without `strict`, as the package does. The same
 * claims under `strict`, which is what an app sees, are in
 * `__fixtures__/agent-context/typed.ts` (compiled by `agentContext.test.ts`).
 * The errors that hold in both modes are repeated here; tsc fails on an unused
 * `@ts-expect-error`, so a check that stops biting fails too.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import {
  Agent,
  AgentTool,
  ToolNamespace,
  type AgentContext,
  type AnyAgentTool,
  type ContextOf,
  type ContextOfTools,
  type ToolContext,
  type ToolShapesOf,
} from "./Agent";
import { AgentController, defineAgentHooks } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
import { McpRouter } from "../http/McpRouter";

const provider = OpenAIProvider.model("gpt-5.4");

type PageContext = {
  pageId: string;
  edit(instruction: string): Promise<string>;
};
type PictureContext = {
  draw(prompt: string): Promise<{ attachmentId: string }>;
};

const page = Agent.withContext<PageContext>();
const pictures = Agent.withContext<PictureContext>();

const editTool = page.tool({
  name: "edit",
  description: "Edit the page",
  inputSchema: s.object({ instruction: s.string() }),
  outputSchema: s.object({ text: s.string() }),
  execute: async ({ instruction }, ctx) => ({ text: await ctx.context.edit(instruction) }),
});

const drawTool = pictures.tool({
  name: "draw",
  description: "Draw a picture",
  inputSchema: s.object({ prompt: s.string() }),
  execute: ({ prompt }, ctx) => ctx.context.draw(prompt),
});

const askTool = page.ask({ name: "askUser", description: "Ask", outputSchema: s.string() });

const plainTool = AgentTool.create({
  name: "plain",
  description: "Reads nothing",
  inputSchema: s.object({}),
  execute: async () => "ok",
});

const pageAgent = page.agent({ name: "page", provider, tools: [editTool, askTool] });
const pictureAgent = pictures.agent({ name: "pictures", provider, tools: [drawTool] });

describe("a tool's context", () => {
  test("the kit binds it", () => {
    expectTypeOf<Parameters<NonNullable<typeof editTool.execute>>[1]>().toEqualTypeOf<
      ToolContext<PageContext>
    >();
    expectTypeOf<Parameters<NonNullable<typeof editTool.execute>>[1]["context"]>().toEqualTypeOf<PageContext>();
  });

  test("an annotated `execute` infers it", () => {
    const annotated = AgentTool.create({
      name: "annotated",
      description: "Reads the page",
      inputSchema: s.object({}),
      execute: async (_input, ctx: ToolContext<PageContext>) => ctx.context.pageId,
    });
    expectTypeOf<ContextOfTools<[typeof annotated]>>().toEqualTypeOf<PageContext>();
  });

  test("a tool that declares nothing has the app's AgentContext", () => {
    expectTypeOf<Parameters<NonNullable<typeof plainTool.execute>>[1]["context"]>().toEqualTypeOf<AgentContext>();
    expectTypeOf<ContextOfTools<[typeof plainTool]>>().toEqualTypeOf<AgentContext>();
  });

  test("the context does not reach the client's tool shapes", () => {
    type Shapes = ToolShapesOf<typeof pageAgent.tools>;
    expectTypeOf<Shapes["edit"]["input"]>().toEqualTypeOf<{ instruction: string }>();
    expectTypeOf<Shapes["edit"]["output"]>().toEqualTypeOf<{ text: string }>();
    expectTypeOf<Shapes["askUser"]["input"]>().toEqualTypeOf<{ question: string }>();
  });
});

describe("an agent's context", () => {
  test("`withContext().agent` carries its Ctx", () => {
    expectTypeOf<ContextOf<typeof pageAgent>>().toEqualTypeOf<PageContext>();
    expectTypeOf<ContextOf<typeof pictureAgent>>().toEqualTypeOf<PictureContext>();
  });

  test("`Agent.create` infers it from the tools, namespaces included", () => {
    const both = Agent.create({
      name: "both",
      provider,
      tools: [editTool, ToolNamespace.create({ name: "art", description: "Art", tools: [drawTool] })],
    });
    expectTypeOf<ContextOf<typeof both>>().toEqualTypeOf<PageContext & PictureContext>();
  });

  test("an agent with no typed tools keeps the app's AgentContext", () => {
    const bare = Agent.create({ name: "bare", provider });
    const plain = Agent.create({ name: "plain", provider, tools: [plainTool] });
    expectTypeOf<ContextOf<typeof bare>>().toEqualTypeOf<AgentContext>();
    expectTypeOf<ContextOf<typeof plain>>().toEqualTypeOf<AgentContext>();
  });

  test("a question for the user (AgentTool.ask) needs no context", () => {
    const ask = AgentTool.ask({ name: "ask", description: "Ask", outputSchema: s.string() });
    expectTypeOf<ContextOfTools<[typeof ask]>>().toEqualTypeOf<AgentContext>();
    const mixed = Agent.create({ name: "mixed", provider, tools: [editTool, ask] });
    expectTypeOf<ContextOf<typeof mixed>>().toEqualTypeOf<PageContext>();
    page.agent({ name: "asks", provider, tools: [editTool, ask] });
  });

  test("an `any` tool (an untyped toAgentTools) adds no requirement", () => {
    const loose = Agent.create({
      name: "loose",
      provider,
      tools: [editTool, plainTool as AnyAgentTool],
    });
    expectTypeOf<ContextOf<typeof loose>>().toEqualTypeOf<PageContext>();
  });

  test("a tool needing more than the agent's Ctx is refused", () => {
    // @ts-expect-error drawTool needs PictureContext
    page.agent({ name: "wrong", provider, tools: [editTool, drawTool] });
    // A tool needing less is fine: the agent's context gives it what it reads.
    Agent.withContext<PageContext & PictureContext>().agent({
      name: "wide",
      provider,
      tools: [editTool, drawTool, plainTool],
    });
  });

  test("prepareStep sees it", () => {
    page.agent({
      name: "steps",
      provider,
      tools: [editTool],
      prepareStep: (step) => {
        expectTypeOf(step.context).toEqualTypeOf<PageContext>();
      },
    });
  });
});

describe("runs carry the agent's context", () => {
  test("stream requires it when it has required fields", () => {
    // @ts-expect-error PageContext has required fields
    pageAgent.stream({ messages: [] });
    pageAgent.stream({ messages: [], context: { pageId: "p", edit: async (i) => i } });
  });

  test("runAgent: inherited for the same Ctx, explicit for another", () => {
    page.tool({
      name: "illustrate",
      description: "Illustrate",
      inputSchema: s.object({ prompt: s.string() }),
      execute: async ({ prompt }, ctx) => {
        // @ts-expect-error the sub-agent's context must be given
        await ctx.runAgent(pictureAgent, { prompt });
        await ctx.runAgent(pictureAgent, {
          prompt,
          context: { draw: async () => ({ attachmentId: ctx.context.pageId }) },
        });
        await ctx.runAgent(pageAgent, { prompt });
        await ctx.runAgent(pageAgent);
        return "";
      },
    });
  });
});

describe("the controller builds it", () => {
  test("context() returns the agent's Ctx", () => {
    class PageChat extends AgentController<typeof pageAgent, { pageId: string }> {
      agent = pageAgent;
    }
    type Built = Awaited<ReturnType<PageChat["context"]>>;
    expectTypeOf<Built>().toEqualTypeOf<PageContext>();
  });

  test("an untyped agent's controller is unchanged", () => {
    const bare = Agent.create({ name: "bare", provider });
    class Chat extends AgentController<typeof bare> {
      agent = bare;
    }
    expectTypeOf<Awaited<ReturnType<Chat["context"]>>>().toEqualTypeOf<AgentContext>();
  });

  test("defineAgentHooks types a shared context hook by its Ctx", () => {
    const hooks = defineAgentHooks<{ pageId: string }, PageContext>({
      context: (_req, { body }) => ({ pageId: body.pageId, edit: async (i) => i }),
    });
    expectTypeOf<Awaited<ReturnType<NonNullable<typeof hooks.context>>>>().toEqualTypeOf<PageContext>();
  });
});

describe("MCP", () => {
  test("fromTool types remote.context by the tool's Ctx", () => {
    class Mcp extends McpRouter<any> {
      routes = {
        edit: this.fromTool(editTool, {
          remote: {
            context: () => ({ pageId: "p", edit: async (i: string) => i }),
          },
        }),
        // @ts-expect-error the remote context must be a PageContext
        broken: this.fromTool(editTool, { remote: { context: () => ({ siteId: 1 }) } }),
      };
    }
    void Mcp;
  });
});
