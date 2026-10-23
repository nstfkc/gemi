/**
 * Per-agent typed contexts (#1019), compiled under `strict` as an app compiles
 * them. Compiled by `ai/agentContext.test.ts`, which expects no errors: every
 * line that must not compile carries a `@ts-expect-error`, and one that stops
 * failing is an error of its own.
 *
 * Its own program for the same reason as the other fixtures here, and because
 * the package's `*.test-d.ts` compile without `strict`: function parameters
 * are bivariant there, which is not what an app sees.
 */
import {
  Agent,
  AgentController,
  AgentTool,
  OpenAIProvider,
  defineAgentHooks,
  s,
  type AgentContext,
  type ContextOf,
  type ToolContext,
} from "gemi/ai";
import type { HttpRequest } from "gemi/http";

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
  execute: async ({ instruction }, ctx) => {
    const typed: PageContext = ctx.context;
    // @ts-expect-error not a field of PageContext
    void ctx.context.siteId;
    return typed.edit(instruction);
  },
  requiresApproval: (_input, ctx) => ctx.context.pageId === "locked",
  endsRun: (_output, ctx) => ctx.context.pageId,
});

const drawTool = pictures.tool({
  name: "draw",
  description: "Draw a picture",
  inputSchema: s.object({ prompt: s.string() }),
  execute: ({ prompt }, ctx) => ctx.context.draw(prompt),
});

const pictureAgent = pictures.agent({ name: "pictures", provider, tools: [drawTool] });

// --- the agent carries its context ---------------------------------------

const pageAgent = page.agent({
  name: "page",
  provider,
  tools: [editTool],
  prepareStep: (step) => {
    const typed: string = step.context.pageId;
    void typed;
  },
});
const pageCtx: PageContext = null as unknown as ContextOf<typeof pageAgent>;
void pageCtx;

// Inferred from the tools with plain `Agent.create`: what they need together.
const inferred = Agent.create({ name: "both", provider, tools: [editTool, drawTool] });
const both: PageContext & PictureContext = null as unknown as ContextOf<typeof inferred>;
void both;

// An agent whose tools declare nothing has the app's `AgentContext`, as before.
const untyped = Agent.create({ name: "untyped", provider });
const global: AgentContext = null as unknown as ContextOf<typeof untyped>;
void global;

// Inferred from an annotated `execute`.
const annotated = AgentTool.create({
  name: "annotated",
  description: "Reads the page",
  inputSchema: s.object({}),
  execute: async (_input, ctx: ToolContext<PageContext>) => ctx.context.pageId,
});
const fromAnnotation = Agent.create({ name: "annotated", provider, tools: [annotated] });
const annotatedCtx: PageContext = null as unknown as ContextOf<typeof fromAnnotation>;
void annotatedCtx;

// A tool needing more than the agent's context is refused.
// @ts-expect-error drawTool needs PictureContext, which PageContext does not give
page.agent({ name: "wrong", provider, tools: [editTool, drawTool] });

// --- stream takes the agent's context ---------------------------------------

// @ts-expect-error PageContext has required fields
pageAgent.stream({ messages: [] });
// @ts-expect-error a missing function
pageAgent.stream({ messages: [], context: { pageId: "p" } });
pageAgent.stream({
  messages: [],
  context: { pageId: "p", edit: async (instruction) => instruction },
});

// --- sub-runs ---------------------------------------------------------------

page.tool({
  name: "illustrate",
  description: "Illustrate the page",
  inputSchema: s.object({ prompt: s.string() }),
  execute: async ({ prompt }, ctx) => {
    // @ts-expect-error the sub-agent's context differs, so it must be given
    await ctx.runAgent(pictureAgent, { prompt });
    // @ts-expect-error and given as the sub-agent's type
    await ctx.runAgent(pictureAgent, { prompt, context: { pageId: ctx.context.pageId } });
    await ctx.runAgent(pictureAgent, {
      prompt,
      context: { draw: async () => ({ attachmentId: ctx.context.pageId }) },
    });
    // The same context: inherited, so nothing to pass.
    await ctx.runAgent(pageAgent, { prompt });
    await ctx.runAgent(pageAgent);
    return "done";
  },
});

// --- the controller builds the agent's context ------------------------------

class PageChat extends AgentController<typeof pageAgent, { pageId: string }> {
  agent = pageAgent;

  context(_req: HttpRequest<any, any>, { body }: { body: { pageId: string } }) {
    return { pageId: body.pageId, edit: async (instruction: string) => instruction };
  }
}
void PageChat;

class ForgetsAFunction extends AgentController<typeof pageAgent, { pageId: string }> {
  agent = pageAgent;

  // @ts-expect-error `edit` is missing from what the agent needs
  context(_req: HttpRequest<any, any>, { body }: { body: { pageId: string } }) {
    return { pageId: body.pageId };
  }
}
void ForgetsAFunction;

class AsyncContext extends AgentController<typeof pageAgent, { pageId: string }> {
  agent = pageAgent;

  async context(_req: HttpRequest<any, any>, { body }: { body: { pageId: string } }) {
    return { pageId: body.pageId, edit: async (instruction: string) => instruction };
  }
}
void AsyncContext;

// Shared hooks that build no context fit a typed controller.
const sharedHooks = defineAgentHooks<{ pageId: string }>({
  runOwner: () => null,
});
class SharesHooks extends AgentController<typeof pageAgent, { pageId: string }> {
  agent = pageAgent;
  hooks = sharedHooks;

  context(_req: HttpRequest<any, any>, { body }: { body: { pageId: string } }) {
    return { pageId: body.pageId, edit: async (instruction: string) => instruction };
  }
}
void SharesHooks;

// A shared `context` hook is typed by its own `Ctx`.
defineAgentHooks<{ pageId: string }, PageContext>({
  // @ts-expect-error `edit` is missing
  context: (_req, { body }) => ({ pageId: body.pageId }),
});

// An untyped agent's controller is unchanged: `{}` is a fine context.
class Untyped extends AgentController<typeof untyped> {
  agent = untyped;

  context() {
    return {};
  }
}
void Untyped;
