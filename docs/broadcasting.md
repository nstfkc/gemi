# Broadcasting (preview)

> **Preview.** This release has the server side: channels, authorization, `Broadcast`, `BroadcastEvent` and the test fake. The WebSocket transport and the client hooks (`useChannel`, `useChannelInvalidate`) come in the next releases. Until then an emit is checked, recorded by `Broadcast.fake()`, and reaches no socket. See [#874](https://github.com/nstfkc/gemi/issues/874).

Broadcasting pushes "something changed" to the browsers looking at it, in real time, over Bun's WebSocket. It is **volatile**: events are hints, delivered at most once, never stored and never replayed. A client that may have missed an event refetches over HTTP, which stays the source of truth.

```typescript
import { Broadcast } from "gemi/facades";

Broadcast.to("site.:siteId", { siteId: site.publicId }).emit("changed", { pages: ["/about"] });
```

Which one to use:

- **Broadcast**: keeping a UI fresh. "This page changed, refetch it."
- **[Change Feeds](./change-feed.md)**: every change must be processed in order, and a client that was away must catch up on what it missed.
- **`useChat`**: agent runs.

## Channels

A channel is a dot-separated name such as `site.abc123`. The channels clients may subscribe to are declared in `app/http/routes/channels.ts`, keyed by pattern:

```typescript
// app/http/routes/channels.ts
import { ChannelRouter } from "gemi/http";
import { Auth } from "gemi/facades";
import { SiteChanged } from "@/app/events/SiteChanged";

export default class extends ChannelRouter {
  channels = {
    "site.:siteId": this.private(async (req, { siteId }) => Website.canEdit(req, siteId)).events(SiteChanged),
    "page.:pageId": this.private(PageChannelPolicy).middleware("page-owner"),
    "user": this.private(), // joins user.<id> of the signed-in user
    "status": this.public().events<{ deploy: { version: string } }>(),
  };
}
```

Register it in the route config:

```typescript
// app/config/route.ts
import Channels from "@/app/http/routes/channels";

export default defineRouteConfig({
  api: { rootRouter: RootApiRouter },
  view: { rootRouter: RootViewRouter, root: createRoot(RootLayout) },
  channels: Channels,
});
```

How channels behave:

- **The server builds the channel name.** A client sends a pattern and its params; the server fills them in. There is no raw-name or wildcard subscribe, and a pattern that is not declared is refused.
- **Param values** are 1 to 128 letters, digits, `_` or `-`, so a value can never add a segment. Use public ids in channel names, never internal ones.
- **`this.public()`**: anyone may join, signed in or not.
- **`this.private()`**: any signed-in user.
- **`this.private(callback)`** or **`this.private(PolicyClass)`** (a class with `authorize(req, params)`): whoever it returns `true` for. Guests are let in only if it says so, for example by an anonymous owner's cookie. Anything but `true` refuses, and so does a throw.
- **`.middleware(...)`** runs middleware before the authorization, as on a route. One that refuses (`auth`, a breaker, a policy denial) refuses the subscription.
- **`"user"`** is special: it takes no params and joins `user.<id>` of the session's user. Guests are refused. Emit to it with `Broadcast.toUser(user)`.
- **Authorization runs on every subscribe**, including every resubscribe after a reconnect. It runs in a request context rebuilt from the WebSocket upgrade request, so `Auth.user()`, `Cookie`, policies and middleware behave as they do in a route.
- **`.events(...)`** lists the `BroadcastEvent` classes the channel carries, or takes an event map as a type argument. It only feeds the generated `BroadcastRPC` types, so client handlers are typed.

A malformed pattern fails the boot.

## Emitting

```typescript
import { Broadcast } from "gemi/facades";

// A pattern and its params
Broadcast.to("site.:siteId", { siteId: site.publicId }).emit("changed", { pages: ["/about"] });

// A user's own channel
Broadcast.toUser(user).emit("credits", { balance });

// Everyone but the sender's socket (the client sends its socket id in X-Gemi-Socket)
Broadcast.toOthers(req).to("page.:pageId", { pageId }).emit("changed");
```

- **Callers:** controllers, model hooks, jobs and cron, in a process that runs the HTTP server.
- **Transactions:** inside an ORM transaction an emit waits for the commit and is dropped on rollback. Outside one it is sent at once.
- **Nothing comes back.** `emit` returns nothing and nothing is acknowledged.
- **Payloads are JSON.** gemi warns (once per event name) above 4 KB and throws `BroadcastPayloadTooLargeError` above 16 KB. Send ids and a change hint, and let the client fetch. Never put secrets or personal data in a payload.
- **Errors at the call site.** An undeclared param, a value that is not allowed, a bad event name or a payload over the limit throws where you emit.

## Typed events: `BroadcastEvent`

A `BroadcastEvent` is an [`Event`](./events.md) that is also broadcast after its listeners run:

```typescript
// app/events/SiteChanged.ts
import { BroadcastEvent } from "gemi/services";

export class SiteChanged extends BroadcastEvent<{ pages: string[] }, "changed"> {
  static name = "SiteChanged";
  static afterCommit = true;

  constructor(public site: { publicId: string }, public changes: { pages: string[] }) {
    super();
  }

  broadcastOn() {
    return this.channel("site.:siteId", { siteId: this.site.publicId });
  }

  broadcastAs() {
    return "changed" as const;
  }

  broadcastWith() {
    return this.changes;
  }
}

SiteChanged.dispatch(site, { pages: ["/about"] });
```

- `broadcastOn()` returns a `this.channel(...)`, a topic string, or an array of them.
- `broadcastAs()` defaults to the class's `static name`.
- `broadcastWith()` defaults to no payload. A payload is never built from the event's fields, so nothing is sent by accident.
- `static afterCommit = true` holds both the listeners and the broadcast until the commit.
- The type arguments are the payload and the event name; `.events(SiteChanged)` on a channel reads them.

## Drivers

The driver decides which processes see an emit. Delivery to sockets always happens in the process that holds them.

```typescript
// app/config/broadcast.ts
import { defineBroadcastConfig } from "gemi/services";

export default defineBroadcastConfig({
  driver: "memory",
  maxEventBytes: 16 * 1024,
  warnEventBytes: 4 * 1024,
});
```

- **`memory`** (the default) reaches the sockets of this process only. It is right for one instance whose web processes also run the jobs. It is wrong for several replicas or for a separate `gemi queue:work` worker: their emits reach nobody.
- A **Redis pub/sub** driver for several instances comes in a later release. A custom driver implements `BroadcastDriver` from `gemi/services`.

## Testing

```typescript
import { Broadcast } from "gemi/facades";

const broadcasts = Broadcast.fake();
await post("/pages/abc/save", body);
broadcasts.assertSent("page.:pageId", "changed", (d) => d.pages.includes("/about"));
broadcasts.assertNotSent("user");
broadcasts.restore();
```

- `assertSent(channel, event?, predicate?)`, `assertNotSent`, `assertSentTimes(channel, times, event?, predicate?)` and `assertNothingSent()`. `channel` is a pattern (it matches every topic it builds), a concrete topic, or `"user"` (every `user.<id>`).
- The fake checks channels and payload sizes like the real one, and records an emit made inside a transaction only once it commits.
- A `BroadcastEvent` dispatched under `Event.fake()` is recorded as an event and **not** broadcast.
- `restore()` is not optional: a fake left installed swallows every later test's broadcasts.

Authorization has its own helper:

```typescript
import { authorizeChannel } from "gemi/http";
import Channels from "@/app/http/routes/channels";

expect(await authorizeChannel(Channels, "site.:siteId", { siteId: bobsSite.publicId }, { as: alice })).toBe(false);
expect(await authorizeChannel(Channels, "page.:pageId", { pageId }, { as: requestWithOwnerCookie })).toBe(true);
```

`as` is a user (as if signed in), a `Request` (its cookies and headers are used), or nothing (a guest). A channel with middleware needs a booted application.
