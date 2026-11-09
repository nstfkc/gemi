# AI Thread Store

A threaded conversation (a turn with a `threadId`) is kept by the controller's `store`, an `AgentStore`. The default, `MemoryAgentStore`, lives in the process: a restart loses every thread, and a second instance never had them. `DatabaseAgentStore` keeps threads in your database, so they survive deploys and every instance reads the same ones.

```ts
// app/agents/store.ts: one instance, at module scope.
import { DatabaseAgentStore } from "gemi/ai";
import { DatabaseManager } from "gemi/database";
import { app } from "gemi/foundation";

export const agentStore = new DatabaseAgentStore(app(DatabaseManager).connection());
```

```ts
import { AgentController } from "gemi/ai";
import { agentStore } from "../agents/store";

export class ChatController extends AgentController {
  agent = chatAgent;
  store = agentStore;
}
```

Make it once, at module scope, not in the controller field: a controller is constructed per request.

## The tables

It keeps threads in `gemi_agent_threads` and messages in `gemi_agent_messages`, and is written for SQLite, Postgres, and MySQL 8 or MariaDB 10.6+, in raw SQL like the other database stores. The tables are yours to create. With Prisma, add these models to `schema.prisma` and run `prisma migrate dev`:

```prisma
model GemiAgentThread {
  id               String  @id
  scope            String?
  userId           String? @map("user_id")
  title            String?
  summaries        String?
  summaryLock      String? @map("summary_lock")
  summaryLockUntil BigInt? @map("summary_lock_until")
  createdAt        BigInt  @map("created_at")
  updatedAt        BigInt  @map("updated_at")

  @@index([userId, updatedAt])
  @@index([scope, userId, updatedAt])
  @@map("gemi_agent_threads")
}

model GemiAgentMessage {
  threadId  String  @map("thread_id")
  scope     String?
  id        String
  position  Int
  message   String
  createdAt BigInt @map("created_at")

  @@id([threadId, id])
  @@unique([threadId, position])
  @@map("gemi_agent_messages")
}
```

On MySQL, add `@db.Text` to `title` and `@db.LongText` to `summaries` and `message`. Without Prisma, `await agentStore.createTable()` creates the same tables and indexes if they do not exist. `new DatabaseAgentStore(connection, { threadsTable, messagesTable })` picks other names.

## How it behaves

- **The whole message is kept**, as JSON, one row per message id, in the order the thread first saw it. A message written again (a run writes its assistant message as it streams, and a turn that answers a pending call writes the earlier message again with the result) replaces its row in place.
- **One writer per thread at a time.** An append runs in a transaction that locks the thread's row first (the database's write lock on SQLite), so two appends to one thread cannot interleave. On SQLite, one client's transactions take turns; several clients on one file need a busy timeout.
- **An unknown thread is `null`** from `loadThread`, and the controller answers 404, as with `MemoryAgentStore`. An append to it throws.
- **Regenerate** (`removeMessages`) and **compaction summaries** (`loadSummaries`, `saveSummary`, `lockSummary`) are supported. Summaries live on the thread's row and are deleted with it. `lockSummary` is a compare-and-set on that row, so several instances do not summarise the same thread at once.
- **Joins the ORM transaction** on its connection, when a call is made inside one, and rolls back with it.
- **Times** are epoch milliseconds from the database's clock.

## Scopes: one store, many tenants

An app that hosts many tenants (organisations, workspaces, projects) keeps each tenant's conversations apart with a **scope**: an opaque string key. `forScope(scope)` is the same store bound to one scope. Every thread and message it writes carries the scope, and every read and write is filtered by it, so a thread of another scope is one it does not have: `null` from `loadThread` and `getThread`, a 404 from the controller, an error from `appendMessages`, and a no-op for `removeMessages`, summaries and `deleteThread`. `listThreads` lists the scope's threads only.

```ts
const store = agentStore.forScope(`org:${org.id}`); // cheap: shares the connection
const { threadId } = await store.createThread({ userId: user.id });
await store.listThreads({ userId: user.id });
```

In a controller, answer the scope from `storeScope(req, { body })`; `stream` and `upload` then run on `store.forScope(scope)`, and `attach` and `watch` answer 404 for a thread outside the scope (`attach` answers the same 204 as for no run when the client sent `emptyMiss`, as `useChat` does) (they carry no `body`, so take the scope from the user):

```ts
export class ChatController extends AgentController<{ projectId: string }> {
  agent = chatAgent;
  store = agentStore;

  protected storeScope(req) {
    return `org:${req.ctx().user.orgId}`;
  }
}
```

`body` is the client's claim, as in `authorizeRequest()`: derive the scope from the authenticated user where you can, or check the body there. Server code passes the scope itself: `ChatController.startTurn({ threadId, text, scope })` (it wins over `storeScope()`, which otherwise sees the turn's `user` and `body`), and `controller.readThread(threadId, { scope })` for the route that hands a thread to `useChat`. `MemoryAgentStore` has `forScope` too, for tests and development. The scoped view lives on the controller instance, which gemi builds per request (routes, `startTurn`, voice); an instance reused for a request in another scope throws rather than serve it from the first scope's view.

- **The unscoped store is unchanged.** It reads every row, scoped or not (for maintenance and admin pages), and its statements do not name the `scope` column, so an app that never scopes needs no migration.
- **`requireScope: true`** (`new DatabaseAgentStore(connection, { requireScope: true })`) makes every call on the unscoped store throw, so a call that forgot its scope is an error rather than a read across every tenant. `createTable()` still works.

### Row-level security

The store joins the open ORM transaction on its connection, so a call made inside a transaction where the app set its tenant (`set_config('app.current_id', …, true)`) runs under that setting. A run's messages are written while it streams, after the request's transaction has ended, so for those give the store a `beginScope` hook. It is called first in every transaction a scoped view opens itself, and with it every call of a scoped view runs in such a transaction, reads included:

```ts
export const agentStore = new DatabaseAgentStore(app(DatabaseManager).connection(), {
  requireScope: true,
  beginScope: (tx, scope) => tx`SELECT set_config('app.current_id', ${scope}, true)`,
});
```

A policy on both tables can then key on the column:

```sql
ALTER TABLE gemi_agent_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON gemi_agent_threads
  USING (scope = current_setting('app.current_id', true))
  WITH CHECK (scope = current_setting('app.current_id', true));
-- the same on gemi_agent_messages
```

The setting is local to the transaction, so nothing is left on the pooled connection. Inside the app's own ORM transaction the hook is not called: that transaction is the app's, and its own setting applies.

### Adding scopes to existing tables

Tables created before scopes keep working for the unscoped store. To use `forScope`, add the column: with Prisma, add the `scope` fields and the index from the models above and run `prisma migrate dev`. Without Prisma, `await agentStore.addScopeColumns()` (also run by `createTable()`) adds them to tables that do not have them yet. Threads written before are in no scope: the unscoped store sees them and no scope does, until the app sets their `scope` itself.

## Listing and deleting threads

The store records the `userId` that `createThread` is given and the first user message as the thread's `title` (cut at 100 characters), for the app's own "your conversations" page:

```ts
const threads = await agentStore.listThreads({ userId: user.id, limit: 20 });
// [{ id, userId: "42", title: "How many orders…", createdAt, updatedAt }, …], most recently written first

await agentStore.getThread(threadId); // one record, or null
await agentStore.deleteThread(threadId); // the thread, its messages and its summaries
```

Nothing here checks who is asking. The app's routes check that the caller owns the thread, as they do for any `threadId`. `deleteThread` does not delete agent memories scoped to the thread: call `AgentMemories.deleteScope("thread:" + threadId)` too (see [AI Memory](./ai-memory.md)).

## Related

- [AI Context Window](./ai-context-window.md): compaction and its summaries.
- [AI Background Jobs](./ai-background-jobs.md): `DatabaseAgentJobStore`, for jobs that settle into a thread.
- [AI Memory](./ai-memory.md): `DatabaseAgentMemoryStore`.
