# AI Controller Hooks

An app with several chats often wants them to behave the same in most ways: the same authorization, the same run owner, the same upload rules, the same billing when a turn ends. Each chat is its own `AgentController`, and each one extends gemi's `AgentController` directly. To share that behaviour without an app-level base class in between, put the shared methods in one hooks object and assign it to each controller's `hooks`.

## Defining shared hooks

`defineAgentHooks<Body>` takes the methods to share, keyed by the controller method each one stands in for. `Body` is the part of the request body the hooks read. Every controller that uses them must send at least those fields.

```typescript
// app/agents/chatHooks.ts
import { defineAgentHooks } from "gemi/ai";
import { InsufficientPermissionsError, stateKey } from "gemi/http";
import { chargeTurn, settleTurn, type BillingTurn } from "@/app/agents/billing";
import { canEditPage, teamOf } from "@/app/agents/access";

const billingTurn = stateKey<BillingTurn>("billingTurn");

export const chatHooks = defineAgentHooks<{ pageId: string }>({
  async authorizeRequest(req, params) {
    if (params.body && !(await canEditPage(req, params.body.pageId))) {
      throw new InsufficientPermissionsError();
    }
  },

  async runOwner(req) {
    const team = await teamOf(req);
    return team ? `team:${team.id}` : null;
  },

  checkUpload(file) {
    if (file.size > 20 * 1024 * 1024) {
      return { code: "file_too_large", message: "Files can be up to 20 MB." };
    }
  },

  async context(req, { body }) {
    req.state.set(billingTurn, await chargeTurn(body.pageId));
    return { pageId: body.pageId };
  },

  async onStreamComplete(result, ctx) {
    await settleTurn(result, ctx.req.state.get(billingTurn));
  },
});
```

Then each controller assigns it:

```typescript
// app/http/controllers/PostChatController.ts
import { AgentController } from "gemi/ai";
import { chatHooks } from "@/app/agents/chatHooks";
import { postAgent } from "@/app/agents/postAgent";
import { chatStore } from "@/app/agents/chatStore";

type PostBody = { pageId: string; format: "square" | "story" };

export class PostChatController extends AgentController<typeof postAgent, PostBody> {
  agent = postAgent;
  store = chatStore;
  hooks = chatHooks;
}
```

`hooks` is set like `store`, `attachments` and `resource`: with a value made once at module scope.

## What a hook can stand in for

A hook has the same name, the same arguments and the same return type as the controller method it stands in for:

| Hook | |
|---|---|
| `authorizeRequest`, `runOwner`, `runLimitKey` | Who may use the routes, who owns a run, who `maxConcurrentRuns` counts against. |
| `instructions`, `reasoning`, `skills`, `context`, `memoryScopes`, `prepareStep` | What each turn's run is given. |
| `attachmentScope`, `attachmentLimits`, `checkUpload`, `attachmentDestination` | Uploads. |
| `onMessage`, `onToolCall`, `onAwaitingInput`, `onError`, `onStreamComplete` | The run's events. |
| `redactError`, `reportHookFailure` | Errors. |

Settings such as `store`, `attachments`, `maxConcurrentRuns` and `requireThread` are not hooks. Set those on the controller.

## Which one runs

For each method, the first of these that exists runs:

1. the method the controller defines itself,
2. the hook in `hooks`,
3. gemi's default.

A hook replaces gemi's default. For example, an `authorizeRequest` hook replaces the default check of `resource`.

A controller that needs to do more than the shared hook defines the method and calls `super`, which runs the hook. This is how it would call a base class's method:

```typescript
export class PageChatController extends AgentController<typeof siteAgent, SiteBody> {
  agent = siteAgent;
  hooks = chatHooks;

  protected async onStreamComplete(result: AgentRunResult<any, any>, ctx: AgentHookContext) {
    await super.onStreamComplete(result, ctx); // chatHooks.onStreamComplete
    await endFirstBuild(ctx);
  }
}
```

## State that passes between hooks

Hooks are plain functions, so they have no `this` to keep a value on. To pass a value from one hook to a later one in the same turn, put it on `req.state` (see [Passing values to the handler](./middleware.md#passing-values-to-the-handler-reqstate)). In the example above, `context` saves the turn's charge and `onStreamComplete` reads it back. The event hooks reach the request as `ctx.req`. Every turn starts with empty state, including one that answers an approval.

## Variants

Build a variant of a hooks object with a spread. Use one for the chats that need a hook the others don't:

```typescript
export const siteChatHooks = defineAgentHooks<SiteBody>({
  ...chatHooks,
  attachmentScope: (_req, _threadId, extra) => ({ key: `site:${extra?.body.siteId}` }),
});
```

A hook named in the spread replaces the one with the same name from `chatHooks`. To run both, call the first one from the second (`chatHooks.onMessage?.(message, ctx)`).

## Related

- [AI Server Turns](./ai-server-turns.md): `startTurn` goes through the same hooks as a chat turn.
- [Authorization](./authorization.md#on-agent-routes): `resource`, which the default `authorizeRequest` checks.
- [AI Memory](./ai-memory.md): `memoryScopes()`.
- [AI Skills](./ai-skills.md): `skills()`.
