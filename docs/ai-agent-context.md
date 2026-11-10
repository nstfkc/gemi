# AI Agent Context

A tool reads the run it belongs to from `ctx.context`: who the run is for, the ids it works on, and functions it calls back into. By default `ctx.context` is the app's `AgentContext`, a single interface for every agent in the app. An agent can instead declare a context of its own. Its tools are then typed by it, its controller's `context()` must return it, and every run of the agent carries it.

A typed context lets the tools stay small. A tool calls `ctx.context.edit(...)`. It doesn't import services or other agents, and it doesn't check optional ids. The controller injects the services in its constructor and passes the tools functions that call them.

## Declaring the context

`Agent.withContext<Ctx>()` returns `tool`, `ask` and `agent`, which are `AgentTool.create`, `AgentTool.ask` and `Agent.create` with `Ctx` bound. Put the context type and the kit in one module and import it from the tools and the agent.

```ts
// app/agents/page.ts
import { Agent, s } from "gemi/ai";
import { provider } from "@/app/config/ai";

export type PageContext = {
  pageId: string;
  edit(instruction: string): Promise<string>;
  drawPicture(prompt: string): Promise<{ attachmentId: string }>;
};

const page = Agent.withContext<PageContext>();

export const editTool = page.tool({
  name: "edit",
  description: "Edit the page as instructed",
  inputSchema: s.object({ instruction: s.string() }),
  execute: ({ instruction }, ctx) => ctx.context.edit(instruction),
});

export const drawTool = page.tool({
  name: "drawPicture",
  description: "Draw a picture for the page",
  inputSchema: s.object({ prompt: s.string() }),
  execute: ({ prompt }, ctx) => ctx.context.drawPicture(prompt),
});

export const pageAgent = page.agent({
  name: "page",
  instructions: "You edit one page of a website.",
  provider,
  tools: [editTool, drawTool],
});
```

Inside `execute`, `ctx.context` is a `PageContext`. The same goes for `requiresApproval`, `endsRun`, a per-run `inputSchema` function, and the agent's `prepareStep` (`step.context`).

`page.agent` checks that every tool's context is satisfied by `PageContext`. A tool that needs something else, for example a tool made with another kit, is a compile error on the call. A tool that needs less is fine. A tool that declares nothing needs the app's `AgentContext`, except a question made with `AgentTool.ask`, which the browser answers and which needs no context.

### Without the kit

The kit is the shortest way, and you don't have to use it:

- **An annotated `execute`.** `AgentTool.create` infers the context from the annotation, as in `execute: async (input, ctx: ToolContext<PageContext>) => ...`.
- **`Agent.create`.** The agent's context is what its tools need together, the intersection of their contexts. An agent whose tools declare nothing has the app's `AgentContext`, as before.

`ContextOf<typeof pageAgent>` reads an agent's context type.

Why a kit and not `Agent.create<PageContext>(...)`: TypeScript can't infer some type arguments while you name others. Naming the context there would also mean naming the tool tuple, or losing it, and the browser's typed tool parts come from that tuple.

## Building it in the controller

`AgentController<typeof pageAgent>` types `context()` by the agent, so it must return a `PageContext` (or a promise of one). Leaving out `pageId` or a function is a compile error on the method. This is where the services are injected, and where they become the functions the tools call.

```ts
// app/http/controllers/PageChatController.ts
import { AgentController } from "gemi/ai";
import type { HttpRequest } from "gemi/http";
import { pageAgent, type PageContext } from "@/app/agents/page";
import { PageEditor } from "@/app/services/PageEditor";
import { Pictures } from "@/app/services/Pictures";

type PageBody = { pageId: string };

export class PageChatController extends AgentController<typeof pageAgent, PageBody> {
  agent = pageAgent;

  constructor(
    private pages = PageEditor.inject(),
    private pictures = Pictures.inject(),
  ) {
    super();
  }

  context(_req: HttpRequest<any, any>, { body }: { body: PageBody }): PageContext {
    return {
      pageId: body.pageId,
      edit: (instruction) => this.pages.edit(body.pageId, instruction),
      drawPicture: (prompt) => this.pictures.draw(body.pageId, prompt),
    };
  }
}
```

`authorizeRequest()` runs before `context()`, so a `pageId` taken from `body` here has already been checked. The values from `body` are still the client's claim, as they are everywhere else.

The same `context()` builds the context of a chat turn, a [server turn](./ai-server-turns.md) (`startTurn`), and the turns a [voice call](./ai-voice.md) delegates, so all of them are typed by it.

TypeScript can't make an inherited method abstract for some agents only. So a controller that doesn't override `context()` at all still compiles, and its runs get gemi's default `{}` (or the `context` hook's answer). What an override returns is checked.

## Tools per turn

An agent's `tools` are fixed at `Agent.create`. A turn can change them (#1123):

- `tools`: tools (or namespaces) for this run only, beside the agent's. They're lowered like the agent's own, after them and before skills, and a per-run `inputSchema` function on one is resolved per run as usual. A name the agent already uses throws.
- `activeTools`: the names the model is offered in this run: tools, run tools, or namespaces (a namespace name offers all of it). The rest aren't sent, and a call to one is answered as a call to a tool that doesn't exist. Skills and memory tools aren't filtered. An unknown name throws.

In a controller, `runTools()` decides both once per turn, after `context()`, whose answer it's handed:

```ts
export class PageChatController extends AgentController<typeof pageAgent, { pageId: string }> {
  agent = pageAgent;

  protected async runTools(req, { context }) {
    const site = await Site.find(context.siteId);
    return {
      // The site's own integrations, as tools.
      tools: site.integrations.map((integration) => integrationTool(integration)),
      // Publishing is off on a site without a plan: the model is never shown it.
      activeTools: site.plan ? undefined : ["edit", "drawPicture", "integrations"],
    };
  }
}
```

The same hook is on [`hooks`](./ai-controller-hooks.md) as `runTools`. Running the agent yourself, pass `tools` and `activeTools` to `agent.stream()`.

Things to know:

- A call already pending from an earlier turn (an approval, a client tool) is still answered on a turn that no longer offers its tool, so turning a tool off never strands a question the user can see.
- A run tool that asks for approval or is answered by the client has to be returned again on the turn that answers it: the answer is checked against the run's tools.
- Run tools aren't part of the agent's type, so `useChat` sees their parts by name, untyped.
- A different tool list is a different request prefix, which the provider's prompt cache keys on. Keep the list stable across a conversation where you can.
- A sub-agent started with `ctx.runAgent` gets its own agent's tools, not the parent run's.

## Order of a step's tool calls

When the model makes several tool calls in one step, their `execute` functions start at once. Tools that change shared state often depend on the calls before them in the same step (`add_container { id: "a" }`, then `add_child { parent: "a" }`), so an agent can ask for them to run one at a time, in the model's order (#1161):

```typescript
export const builder = Agent.create({
  name: "builder",
  provider,
  tools: [addContainer, addChild],
  toolExecution: "sequential", // default "parallel"
});
```

- Each call starts once the one before it has settled: ok, error or timed out. A failed call doesn't stop the ones after it; the model sees every result.
- Their `tool-result` events and results follow the model's order.
- The model can still make several calls in one step; only their execution is ordered.
- Input checks, approvals and usage limits are decided for all of the step's calls first, as before. A call that waits for an approval or the client doesn't hold back the ones after it.
- A stop while a call runs: the calls after it never start.
- `agent.stream({ toolExecution })` overrides it for one run. A sub-agent uses its own agent's setting.

## Running the agent yourself

`agent.stream({ context })` takes the agent's context. It's required when the context has a required field, and optional otherwise.

```ts
// app/jobs/RefreshPage.ts
import { pageAgent } from "@/app/agents/page";

export async function refreshPage(pageId: string) {
  return pageAgent
    .stream({
      messages: [],
      turn: { text: "Refresh the copy" },
      context: {
        pageId,
        edit: async (instruction) => `edited ${pageId}: ${instruction}`,
        drawPicture: async () => ({ attachmentId: "none" }),
      },
    })
    .result();
}
```

## Sub-agents

`ctx.runAgent(subAgent, params)` hands the sub-run the parent's context when the parent's context also satisfies the sub-agent's. If the sub-agent declares a context the calling tool's doesn't satisfy, `params.context` is required and typed as the sub-agent's. Build it from your own:

```ts
// app/agents/illustrate.ts
import { Agent, s } from "gemi/ai";
import { provider } from "@/app/config/ai";

type PictureContext = { draw(prompt: string): Promise<{ attachmentId: string }> };
type PageContext = { pageId: string; drawPicture(prompt: string): Promise<{ attachmentId: string }> };

const pictures = Agent.withContext<PictureContext>();
const page = Agent.withContext<PageContext>();

const drawTool = pictures.tool({
  name: "draw",
  description: "Draw one picture",
  inputSchema: s.object({ prompt: s.string() }),
  execute: ({ prompt }, ctx) => ctx.context.draw(prompt),
});
const illustrator = pictures.agent({ name: "illustrator", provider, tools: [drawTool] });

export const illustrateTool = page.tool({
  name: "illustrate",
  description: "Illustrate the page",
  inputSchema: s.object({ brief: s.string() }),
  execute: async ({ brief }, ctx) => {
    const run = await ctx.runAgent(illustrator, {
      prompt: brief,
      context: { draw: (prompt) => ctx.context.drawPicture(prompt) },
    });
    return run.finishReason;
  },
});
```

Only the context changes. The sub-run still inherits the attachments, the request body, the run's subject, its memory scopes and its signal, because it still acts for the same caller. If the sub-agent asks the user something, the tool runs again from the top on the next turn and passes `context` again, so nothing about it is stored.

## Shared hooks and MCP

- **Shared hooks.** A [shared hooks object](./ai-controller-hooks.md) that doesn't build a context fits any controller. To share a `context` hook between controllers of agents with the same context, name the context in `defineAgentHooks<Body, Ctx>`.
- **MCP.** `McpRouter.fromTool(tool, { remote: { context } })` builds the context of a remote MCP call, and that function is typed by the tool's own context. A tool made with `page.tool` needs a `PageContext` there, functions included.

## Coming from `AgentContext`

Apps that augment `AgentContext` keep working: every new type parameter defaults to it. To move an agent over:

1. Declare its context and a kit, and make its tools with `kit.tool`. Pass functions in place of the ids the tools used to look services up with.
2. Make the agent with `kit.agent`. Untyped tools can stay, but then the agent needs the app's `AgentContext` too.
3. Return the context from the controller's `context()`, and inject the services in its constructor.
4. Remove the fields from the `AgentContext` augmentation once no untyped tool reads them.
