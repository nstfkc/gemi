# Change Feeds

A change feed tells whoever is looking at something that it changed: another browser tab, a preview pane, a second agent run. You publish "channel K changed" where the change happens. Views follow the channel over Server-Sent Events, and pick up where they left off after a dropped connection or a hidden tab. This works in one process with the default driver, and across instances with the database driver on Postgres.

```typescript
import { ChangeFeed } from "gemi/facades";

// Where a site changes (in its transaction or not):
await ChangeFeed.publish(`site:${site.id}`, { pages: ["/about"] });
```

```typescript
// app/http/routes/api.ts: the stream, authorised like any other read
"/sites/:siteId/changes": this.get(async (req: HttpRequest<{}, { siteId: string }>) => {
  const site = await Site.findUniqueOrThrow({ where: { publicId: req.params.siteId } });
  return ChangeFeed.stream<SiteChange>(req, `site:${site.id}`);
}),
```

```tsx
// a view
import { useSubscription } from "gemi/client";

useSubscription(
  "/sites/:siteId/changes",
  { params: { siteId } },
  { onChange: ({ data }) => apply(data), onReset: () => reload() },
);
```

## The model

- A **channel** is a string naming something that changes, such as `site:42`, `post:7` or `user:3:inbox`. It can be 1 to 255 characters long.
- Every `publish` to a channel appends one **entry** to its log. The entry's **seq** is 1, 2, 3, … per channel, and its `data` is any JSON value (or nothing).
- The driver keeps the last `retain` entries of each channel (default 1000).
- A subscriber has a **cursor**: the last seq it saw of each channel it follows. It receives two kinds of event:
  - `{ type: "change", channel, seq, data }`: one entry, in order, each exactly once.
  - `{ type: "reset", channel, seq }`: the subscriber cannot be brought up to date entry by entry. Either its cursor is older than what the driver keeps (it was away for more than `retain` changes), or it is ahead of the head (the store was reset). Read the resource again; you are now at `seq`.

**The log is the truth, and notifications only wake subscribers up.** A subscriber always reads what it delivers from the log, starting at its cursor. So a lost notification (for example, a dropped connection between instances) delays a change but never loses it.

## Publishing

```typescript
const seq = await ChangeFeed.publish("site:42", { pages: ["/about"] });
```

Inside an ORM transaction, nobody is told before the commit, and nothing is published if it rolls back. A subscriber is never told about a change it then can't see.

- With the database driver on Postgres, the entry is written on the transaction itself and commits with it, and the publish resolves to the seq.
- With every other driver (the memory driver, SQLite, or a transaction on another connection), the publish waits for the commit and resolves to `null`, because the seq doesn't exist yet.

Seqs are commit-ordered: a subscriber never sees seq 6 while seq 5 could still appear. The database driver gets this by locking the channel's head row until the publishing transaction ends, so publishers to one channel take turns. Publishers to different channels don't wait for each other.

`ChangeFeed.head(channel)` is a channel's latest seq. `ChangeFeed.cursor(channels)` is a cursor at the channels' heads. Pass it from a view to its client, so the subscription starts from what the view showed rather than from whenever the browser connected:

```typescript
// a view's data
return { site, changesCursor: await ChangeFeed.cursor(`site:${site.id}`) };
```

## Streaming to the browser

`ChangeFeed.stream(req, channels)` answers with an SSE response. Use it in a route handler **after** deciding that the caller may read those channels.

There is no generic "subscribe to any channel" endpoint. Each stream is an ordinary route, so its middleware and policies decide who may follow it, and channel names never come from the client. Following a resource goes through the same checks as reading it.

What the stream sends:

1. `{"type":"ready"}` first, once it knows where it is.
2. Then each event as one SSE message, whose `id` is the whole cursor after that event (`site%3A42=17&site%3A43=4`). A client reconnecting with that `Last-Event-ID` resumes every channel at once. The `cursor` search parameter works too, and `options.cursor` overrides both.

It also:

- writes a keepalive comment every 5 seconds (`keepaliveInterval`), because Bun closes a silent connection after 10;
- ends when the client goes away, or when the server starts shutting down (the client then reconnects to an instance that is staying);
- answers `503` with `Retry-After` when this process already holds `maxSubscriptions`.

## Following a route: `useSubscription`

```tsx
import { useSubscription } from "gemi/client";

const { status, cursor, error } = useSubscription(
  "/sites/:siteId/changes",
  { params: { siteId }, search: {} },
  {
    cursor: changesCursor, // optional: start from what the view showed
    onChange: (event) => apply(event.data), // typed from ChangeFeed.stream<T>()
    onReset: () => reload(),
    enabled: true,
    pauseWhenHidden: true,
  },
);
```

- `status` is `"connecting"`, `"open"`, `"paused"` (tab hidden) or `"closed"` (disabled or refused).
- After a drop it reconnects with `Last-Event-ID`, backing off from 1 second up to 30, or by the server's `Retry-After`.
- While the tab is hidden it disconnects, and catches up from its cursor once the tab is shown.
- A `4xx` other than `408` and `429` stops it.
- The callbacks may change between renders without reconnecting.
- The route's `data` type comes from the `T` of `ChangeFeed.stream<T>()`.

## On the server: `ChangeFeed.subscribe`

```typescript
const subscription = ChangeFeed.subscribe(["site:1", "site:2"], { cursor, signal });
for await (const event of subscription) {
  // event.type is "change" or "reset"
}
// subscription.cursor: where it is, to resume from later
```

Breaking out of the loop, `subscription.close()` or the `signal` ends it. `await subscription.ready()` resolves once every channel has a position, so you can read `cursor` before the first event.

A subscription keeps no queue of its own: only which of its channels may have moved, plus at most one batch read from the log (`batchSize`, default 100). A slow consumer costs nothing while it is behind, and one that falls further behind than `retain` gets a `reset`.

## Drivers

```typescript
// app/config/changeFeed.ts
import { defineChangeFeedConfig } from "gemi/services";

export default defineChangeFeedConfig({
  driver: "database",
});
```

| Option | Default | |
|---|---|---|
| `driver` | `"memory"` | `"memory"`, `"database"`, a `ChangeFeedDriver`, or `(app) => driver`. |
| `pollInterval` | `30000` | How often, in ms, the process reads the heads of every channel it follows, in one query. This is a safety net for a missed notification, and the only cross-process signal for a driver that cannot notify. |
| `maxSubscriptions` | `10000` | Subscriptions per process. One more gets `ChangeFeedFullError` (`503` from `stream`). |
| `batchSize` | `100` | Entries read from the log at a time. |
| `keepaliveInterval` | `5000` | Keepalive comments on a stream, in ms. |

### The memory driver

This is the default. Each channel's log lives in this process's memory, so it works for **one process only**: a subscriber on another instance never hears of a publish here. A restart forgets every channel, and a client resuming with an older cursor gets a `reset`. That is the right answer, because what it showed must be read again. To change how much it keeps, build it yourself: `driver: () => new MemoryChangeFeedDriver({ retain: 100 })`.

### The database driver

`driver: "database"` keeps the log in two tables of the default connection: `gemi_change_heads` (one row per channel) and `gemi_changes` (the kept entries). It supports Postgres and SQLite; MySQL isn't supported yet.

On Postgres, a publish also runs `pg_notify` in the same transaction, which Postgres delivers only when the transaction commits. Each process holds one `LISTEN` connection, which wakes its subscribers as soon as any instance publishes. After a dropped connection it reconnects by itself and re-reads every channel it follows, since notifications sent meanwhile are gone.

The `LISTEN` connection uses Bun's own SQL client on Bun 1.4 and later. On Bun 1.3, install the `postgres` package (`bun add postgres`), an optional peer dependency of gemi.

The tables are yours to create. With Prisma:

```prisma
model GemiChangeHead {
  channel String @id
  seq     BigInt

  @@map("gemi_change_heads")
}

model GemiChange {
  channel   String
  seq       BigInt
  data      String
  createdAt BigInt @map("created_at")

  @@id([channel, seq])
  @@map("gemi_changes")
}
```

Without Prisma, `await driver.createTable()` creates both if they don't exist. For another connection, other table names or a different `retain`, build the driver yourself:

```typescript
import { DatabaseManager } from "gemi/database";
import { DatabaseChangeFeedDriver, defineChangeFeedConfig } from "gemi/services";

export default defineChangeFeedConfig({
  driver: (app) =>
    new DatabaseChangeFeedDriver(app.make(DatabaseManager).connection("feeds"), { retain: 200 }),
});
```

### Your own driver

A `ChangeFeedDriver` has `publish`, `heads` and `read`, plus optional `listen` (wake-ups from other processes), `joinsTransaction` and `close`. Without `listen`, other processes' publishes arrive every `pollInterval`.
