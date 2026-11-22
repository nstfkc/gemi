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
| `busyPolicy`, `maxThreadRuns` | What a message on a busy thread does (supersede, queue, join, parallel or skip), and how many runs a thread takes at once. See [A thread that is busy](./ai-server-turns.md#a-thread-that-is-busy). |
| `instructions`, `reasoning`, `skills`, `runTools`, `usageLimits`, `trailingContext`, `context`, `memoryScopes`, `prepareStep` | What each turn's run is given. `runTools`, `usageLimits` and `trailingContext` get `{ body, context }`; `trailingContext` answers text sent after the conversation (see [Text after the conversation](./ai-agent-context.md#text-after-the-conversation)); `runTools` answers `{ tools?, activeTools? }` (see [Tools per turn](./ai-agent-context.md#tools-per-turn)), `usageLimits` the run's budgets (see [Usage limits](./ai-usage.md#usage-limits)). |
| `attachmentScope`, `attachmentLimits`, `checkUpload`, `attachmentDestination`, `attachmentRetention` | Uploads, and how long they and the files tools make are kept (see [Short-lived attachments](#short-lived-attachments)). |
| `onMessage`, `onToolCall`, `onToolResult`, `onAwaitingInput`, `onError`, `onProviderRetry`, `onStreamComplete` | The run's events. `onProviderRetry` fires for each model-call attempt the provider asks again; see [AI Providers](./ai-providers.md#watching-retries). `onToolResult` fires once for each tool result on the stream (`ok`, `error`, `denied`, `running`), with `result.approval` on a call a person approved or refused, and the call it answers as a third argument (`{ toolCallId, name, input }`, the input as the model sent it); see [AI Tool Approvals](./ai-tool-approvals.md#who-approved-a-call). |
| `redactError`, `reportHookFailure` | Errors. |

Settings such as `store`, `attachments`, `maxConcurrentRuns` and `requireThread` are not hooks. Set those on the controller.

A `context` hook returns the app's `AgentContext` unless you name another type: `defineAgentHooks<Body, Ctx>`, for controllers whose agent declares a context of its own (see [AI Agent Context](./ai-agent-context.md)). Hooks that don't build a context fit any controller, whatever its agent's context is.

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

Hooks are plain functions, so they have no `this` to keep a value on. To pass a value from one hook to a later one in the same turn, put it on `req.state` (see [Passing values to the handler](./middleware.md#passing-values-to-the-handler-reqstate)). In the example above, `context` saves the turn's charge and `onStreamComplete` reads it back. The event hooks reach the request as `ctx.req`. Every turn starts with empty state, including one that answers an approval. `ctx` also has the turn's `runId`, its `threadId`, and `denials`: the approvals the user refused in the run so far (see [Not asking again after a refusal](./ai-tool-approvals.md#not-asking-again-after-a-refusal)).

## Variants

Build a variant of a hooks object with a spread. Use one for the chats that need a hook the others don't:

```typescript
export const siteChatHooks = defineAgentHooks<SiteBody>({
  ...chatHooks,
  attachmentScope: (_req, _threadId, extra) => ({ key: `site:${extra?.body.siteId}` }),
});
```

A hook named in the spread replaces the one with the same name from `chatHooks`. To run both, call the first one from the second (`chatHooks.onMessage?.(message, ctx)`).

## Short-lived attachments

An upload can live in two places: gemi's `Storage` copy (`attachmentId`) and the provider's copy (`fileId`). Files a tool makes with `ctx.attachments.put`, `ctx.generateImage` or `ctx.editImage` are stored the same way. By default all of them are kept. `attachmentRetention` makes them short-lived. It is asked once per upload (`route: "upload"`), and once per turn (`route: "stream"`) for the files that turn's tools make:

```typescript
export class StoreChatController extends AgentController<typeof storeAgent, StoreBody> {
  agent = storeAgent;

  protected attachmentRetention() {
    return "turn" as const; // or { ttlMs: 10 * 60_000 }, or null to keep
  }
}
```

- **`"turn"`**: when the turn has completed (after `onStreamComplete` and `onError`), gemi deletes the stored bytes, the provider file (`provider.deleteFile`) and the record. This covers the uploads the turn names in `turn.files` and the files its tools made. The client already has everything the stream sent it, so a tool that should show the shopper an edited photo puts the image in its output (a `data:` URL). A page that fetches the image by id afterwards needs `{ ttlMs }`. An upload that no turn names stops resolving after `turnAttachmentMaxAgeMs` (one hour by default) and is deleted by the sweep.
- **`{ ttlMs }`**: the files are kept for that long. After that they no longer resolve (a tool gets `AttachmentNotFoundError`), and `sweepAttachments()` deletes them.

Run the sweep from a cron. It also deletes `"turn"` files whose turn never completed, for example after a restart:

```typescript
// app/cron/SweepChatAttachments.ts
import { CronJob } from "gemi/services";

export class SweepChatAttachments extends CronJob {
  name = "SweepChatAttachments";
  cron = CronJob.exp("*/5 * * * *");

  async callback() {
    await new StoreChatController().sweepAttachments();
  }
}
```

A store with [expiring threads](./ai-thread-store.md#expiring-threads) sweeps them the same way, with `store.sweepExpired()`.

It answers `{ deleted, failed }`. A deletion that fails, in a turn or in the sweep, goes to `reportHookFailure`, and its record stays so the next sweep tries again. A missing `deleteFile` on the provider or `delete` on storage counts as a failure, because skipping a copy would leave it in place unnoticed.

A turn deletes an upload only when that upload was itself made short-lived. The turn looks the upload up under its own `attachmentScope`, and looks up a provider-only file only when the file was recorded for the same `runOwner`. A turn can't delete a file the app keeps, or one another caller uploaded.

Things to know:

- **Stores.** A custom `AttachmentStore` needs `delete(scope, id)` and `expired(now, limit)`, a `FileOwners` needs `delete(fileId)` and `expired(now, limit)`, and `attachmentStorage` needs `delete`. The in-memory defaults and the `Storage` facade have them. Records gain `expiresAt` and `deleteAfterTurn`.
- **Threads.** After a `"turn"` deletion, the thread's history still names the files. On the next turn the provider refuses the deleted file id, and the model is told the file can't be read. A chat whose thread shouldn't outlive the turn either runs stateless (no `threadId`, nothing is stored) or deletes the thread in `onStreamComplete` (`DatabaseAgentStore.deleteThread`, see [AI Thread Store](./ai-thread-store.md#listing-and-deleting-threads)).
- **Paused tools and jobs.** A tool that waits for an approval or an answer runs again on a later turn. Under `"turn"`, the files it stored on the first turn are gone by then. Background jobs (`ctx.jobs`) make their own files, which don't get the turn's retention. Use `{ ttlMs }` for both.

### Anonymous visitors

A visitor who isn't signed in and has no thread has no attachment scope by default. Their upload goes to the provider alone (the answer has `downgraded: "no_scope"` and no `attachmentId`), so a tool can't read the bytes. To let a tool read the photo in the same turn, give the upload a scope from a value the server checks, such as a visitor token the page was rendered with. Send the token in the chat's `body`, so the upload and the turn resolve the same scope:

```typescript
protected async attachmentScope(req: HttpRequest, threadId?: string, extra?: { body: StoreBody }) {
  const scope = await super.attachmentScope(req, threadId);
  if (scope) return scope;
  const visitor = await verifyVisitorToken(extra?.body.visitor); // the app's own check
  return visitor ? { key: `visitor:${visitor.id}` } : null;
}
```

With `attachmentRetention()` answering `"turn"`, the photo is kept in `Storage` while the turn runs, the tool reads it with `ctx.attachments.file(id)`, and the photo is deleted from both places when the turn completes. Don't build the key from an unchecked body field (see `attachmentScope` in the source for why).

## Related

- [AI Server Turns](./ai-server-turns.md): `startTurn` goes through the same hooks as a chat turn.
- [Authorization](./authorization.md#on-agent-routes): `resource`, which the default `authorizeRequest` checks.
- [AI Memory](./ai-memory.md): `memoryScopes()`.
- [AI Skills](./ai-skills.md): `skills()`.
