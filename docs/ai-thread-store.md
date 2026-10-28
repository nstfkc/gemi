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
  userId           String? @map("user_id")
  title            String?
  summaries        String?
  summaryLock      String? @map("summary_lock")
  summaryLockUntil BigInt? @map("summary_lock_until")
  createdAt        BigInt  @map("created_at")
  updatedAt        BigInt  @map("updated_at")

  @@index([userId, updatedAt])
  @@map("gemi_agent_threads")
}

model GemiAgentMessage {
  threadId  String @map("thread_id")
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
