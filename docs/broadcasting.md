# Broadcasting

Broadcasting pushes "something changed" to the browsers looking at it, in real time, over Bun's WebSocket. It is **volatile**: events are hints, delivered at most once, never stored and never replayed. A client that may have missed an event refetches over HTTP, which stays the source of truth.

```typescript
import { Broadcast } from "gemi/facades";

Broadcast.to("site.:siteId", { siteId: site.publicId }).emit("changed", { pages: ["/about"] });
```

```tsx
import { useChannelInvalidate } from "gemi/client";

// Refetch the site's pages on every event, and whenever an event may have been missed.
useChannelInvalidate("site.:siteId", { siteId }, ["/sites/:siteId/pages"]);
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

The router is checked at boot, and any of these fails it:

- a malformed pattern, or one that starts with a param (`":kind.:id"`). Start every pattern with a literal segment;
- two patterns that can build the same topic, such as `"site.:siteId"` and `"site.:id"` or `"site.featured"`. The client names the pattern it subscribes through, so the weaker of two overlapping patterns would decide who may join the other's topics;
- a pattern other than `"user"` that can build a two-segment `user.…` topic, such as `"user.:userId"`. `user.<id>` belongs to the `"user"` channel;
- `this.private()` without a callback on a pattern with params. It would let every signed-in user join every site. Pass a callback or a policy that checks the params;
- a segment starting with `__`, which is reserved for gemi.

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
- **Errors at the call site.** An undeclared param, a value that is not allowed, a bad event name or a payload over the limit throws where you emit. So does `Broadcast.to("user")`: the `"user"` channel is a different topic per subscriber, so use `Broadcast.toUser(user)`.

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
- The type arguments are the payload and the event name; `.events(SiteChanged)` on a channel reads them. Return the name `as const` from `broadcastAs()`. Without the name argument it is `string`, and the channel's events lose their types.

## On the client

The hooks come from `gemi/client`. They share one WebSocket per tab, opened by the first hook that mounts and closed a few seconds after the last one unmounts. Subscriptions to the same channel and params are shared too.

### `useChannelInvalidate`: the common case

```tsx
import { useChannelInvalidate } from "gemi/client";

useChannelInvalidate("page.:pageId", { pageId }, ["/pages/:pageId", "/pages/:pageId/pictures"]);
```

On every event on the channel, and on every resync (see below), the listed queries are invalidated: every cached search variant is marked stale, and the ones on screen refetch now. A path's `:params` are filled from the route's params, then the channel's params. An entry can also be `{ path, params, search }` to target one variant.

### `useQuery({ live })`: polling only as a fallback

```tsx
import { useQuery } from "gemi/client";

const { data } = useQuery(
  "/site-imports/:importId",
  { params: { importId } },
  { live: "user", refetchUntil: (d) => (d.active ? 2_000 : 0) },
);
```

`live` names a channel: a pattern without params (`"user"`), `["site.:siteId", { siteId }]`, or `{ channel, params }`. Its events and resyncs refetch the query. While the channel is open, `refetchUntil` and `refreshInterval` are paused; while it is not (connecting, refused, offline, a blocked socket, a server render) they run as usual. So keep the polling you had: it is the fallback, and there is no other.

### `useChannel`: full control

```tsx
import { useChannel, useMutate } from "gemi/client";

const mutate = useMutate();
const { status } = useChannel("site.:siteId", { params: { siteId } }, {
  on: {
    changed: (d) => {
      for (const page of d.pages) mutate({ path: "/pages/:path", params: { path: page } });
    },
  },
  onResync: () => mutate({ path: "/sites/:siteId/pages", params: { siteId }, search: () => true }),
});
```

- `on` maps event names to handlers. With a `ChannelRouter` that declares `.events(...)`, the names and payloads are typed from the generated `BroadcastRPC`.
- `onResync` runs whenever events may have been missed. **A view that uses `on` must also refetch in `onResync`**, or it goes stale silently after a reconnect. In development, `useChannel` with `on` and no `onResync` warns.
- `status` is `"connecting"`, `"open"` (subscribed), `"denied"` (with `code`), `"closed"` (on the server, or waiting to reconnect) or `"idle"` (`enabled: false`).
- `enabled: false` unsubscribes.

Handlers may change between renders without resubscribing.

### Missed events and resync

Nothing is replayed. Instead the client **resyncs**: `onResync` runs, and `useChannelInvalidate` and `live` queries refetch, whenever an event may have been missed:

1. when a subscription is acknowledged: on the first connect (an event may have been emitted between the server render and the subscription), after a reconnect, after a `bye`, after the socket was closed for falling behind, and when a hidden tab is shown again;
2. when the server sends a `gap` (a driver lost messages, for instance a Redis subscriber that reconnected).

Resyncs are coalesced to one per subscription per 2 seconds, and refetches only reach the variants on screen. Events are hints and HTTP is the truth: a lost event costs one refetch at the next resync.

### Connection behaviour

- **Reconnects** use full-jitter backoff between 1 and 30 seconds, or the `retryAfter` the server sent with `bye`. An `online` event retries at once.
- **Heartbeat.** The client pings every `heartbeatMs` (from the server) and reconnects when it has heard nothing for twice that, so a connection a proxy dropped silently is noticed within about a minute.
- **Hidden tabs** keep the socket for 60 seconds, then disconnect. Showing the tab reconnects and resyncs.
- **Refusals.** `unknown_channel` and `invalid_params` are final and never retried. `denied`, `error`, `rate_limited` and `limit` are retried on the next reconnect, since access and load change.
- **Sessions.** A socket keeps the session it was opened with. `useSignIn`, `useEmailCode` and `useSignOut` reconnect it, so its channels are authorized as the new session. After signing in some other way (a full-page OAuth redirect reloads the page anyway), nothing else is needed.
- **Server renders and islands** open no socket: the hooks act only in effects, and on the server they report `"closed"`.
- **`toOthers`.** While the socket is open, mutations (`useMutation`, `usePost` and the rest) send the socket's id in `X-Gemi-Socket`, so `Broadcast.toOthers(req)` in the controller skips the tab that made the change.

If you change the server's `path`, pass the same to the client:

```tsx
import { init } from "gemi/client";

init(RootLayout, { realtime: { path: "/realtime" } });
```

`realtime.hiddenDisconnectMs` sets how long a hidden tab keeps its socket.

## The transport

The socket endpoint is served by `gemi start` and `gemi dev` on the app's own port, at `/__gemi/socket` by default, as soon as the app registers `route.channels`. In development it shares the port with Vite's HMR socket.

### What happens on an upgrade

1. The app's **global middleware** runs, as for any request. A middleware that refuses the request refuses the socket with the same response.
2. The **session** is resolved from the `access_token` cookie, or the `access_token` header a native client sends, or a user a global middleware put on the context.
3. **Origin check.** A browser sends cookies with a WebSocket upgrade whatever page opened it, so an upgrade that carries cookies must send an allowed `Origin`, and one without `Origin` is refused (`403`). An `Origin` that is not allowed is refused even without cookies. Allowed are: the request's own host, `APP_URL` and `HOST_NAME`, the `route.domains` root and its subdomains, and `allowedOrigins`. A native client that sends no cookies may leave `Origin` out.
4. **Limits** per process, per client IP and per user (`503` or `429`).
5. The socket opens with the subprotocol `gemi.v1`.

Every subscription is authorized by the `ChannelRouter`, in a request context rebuilt from the upgrade request: the cookies and headers it carried and the user the global middleware resolved.

### Revoking access

An open socket was authorized when it subscribed. When access changes, close what may no longer be allowed:

```typescript
import { Broadcast } from "gemi/facades";

// After removing a member from a site: every subscription to it is told `denied` (`revoked`).
Broadcast.revoke({ channel: "site.:siteId", params: { siteId: site.publicId } });

// Every socket of a user is closed (4001); its tabs reconnect and resubscribe.
Broadcast.revoke({ user });
```

Clients that still have access get back in, because every resubscribe is authorized again. Inside a transaction, `revoke` waits for the commit, so the resubscribes see the committed state. **Signing out** (gemi's `sign-out` route) revokes the user's sockets for you.

### Limits and lifecycle

- **Backpressure.** A socket that falls `backpressureLimit` bytes behind is closed with `1013`, and its client reconnects and resyncs. No queue is kept per socket.
- **Rate limits.** A socket may send `subscribeRate.limit` `sub`/`unsub` frames per window. Past it a `sub` is refused with `rate_limited`; at twice the limit the socket is closed (`1008`).
- **Inbound frames** are JSON text up to `maxInboundMessageBytes`. Anything else closes the socket (`1003`).
- **Idle sockets.** Bun pings them, and closes one that answers nothing for `idleTimeout` seconds.
- **Shutdown.** When `gemi start` drains, it closes the listener, sends every socket `bye` with code `1012` and a `retryAfter` between 1 and 5 seconds (so a deploy's reconnects do not arrive at once), and closes them. That happens before the providers shut down. In development, the application a reload replaced closes its sockets the same way.
- **Logging.** gemi logs the channel, the operation and the close code. It never logs payloads.

## Configuration

```typescript
// app/config/broadcast.ts
import { defineBroadcastConfig } from "gemi/services";

export default defineBroadcastConfig({
  driver: "memory",
  maxEventBytes: 16 * 1024,
  warnEventBytes: 4 * 1024,
  path: "/__gemi/socket",
  allowedOrigins: [], // besides the app's own host, APP_URL, HOST_NAME and route.domains
  maxConnectionsPerProcess: 10_000,
  maxConnectionsPerIp: 100,
  maxConnectionsPerUser: 50,
  maxChannelsPerSocket: 50,
  maxInboundMessageBytes: 16 * 1024,
  backpressureLimit: 1 << 20, // 1 MB
  idleTimeout: 120, // seconds
  heartbeatMs: 25_000,
  subscribeRate: { limit: 100, windowMs: 60_000 },
});
```

Every field is optional; the values above are the defaults. Add the slice to the Kernel's `config` as `broadcast`.

## Drivers

The driver decides which processes see an emit. Delivery to sockets always happens in the process that holds them, with Bun's `server.publish`.

- **`memory`** (the default) reaches the sockets of this process only. It is right for one instance whose web processes also run the jobs. It is wrong for several replicas or for a separate `gemi queue:work` worker: their emits reach nobody.
- A **Redis pub/sub** driver for several instances comes in a later release. A custom driver implements `BroadcastDriver` from `gemi/services`.

## The protocol

Native clients speak the same protocol as the browser. Open a WebSocket to the endpoint with the subprotocol `gemi.v1`, and the `access_token` header. Every frame is JSON text.

| From the client | |
|---|---|
| `{"op":"sub","id":"1","ch":"site.:siteId","p":{"siteId":"abc"}}` | Subscribe. `id` is the client's, 1 to 32 of `[A-Za-z0-9_-]`. |
| `{"op":"unsub","id":"1"}` | |
| `{"op":"ping"}` | Answered with `pong`. |

| From the server | |
|---|---|
| `{"op":"hello","socketId":"…","tag":"…","heartbeatMs":25000}` | First frame. Send `socketId` in `X-Gemi-Socket` on your requests. |
| `{"op":"subscribed","id":"1","t":"site.abc"}` | Joined topic `t`. Resync now. |
| `{"op":"denied","id":"1","code":"denied"}` | Refused or revoked. |
| `{"op":"ev","t":"site.abc","ev":"changed","d":{…},"x":"…"}` | An event. Drop it when `x` is your `tag`. |
| `{"op":"gap"}` | Resync everything. |
| `{"op":"pong"}` | |
| `{"op":"bye","code":1012,"retryAfter":3200}` | Reconnect after `retryAfter` ms. |

Close codes: `1012` restart, `1013` fell behind, `4001` revoked (reconnect at once), `1008` too many frames, `1003` a bad frame.

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
- The fake checks channels and payload sizes like the real one, and records an emit made inside a transaction only once it commits. It records the payload as clients receive it (JSON-encoded), and a malformed channel passed to an assertion throws.
- A `BroadcastEvent` dispatched under `Event.fake()` is recorded as an event and **not** broadcast.
- `restore()` is not optional: a fake left installed swallows every later test's broadcasts.
- `broadcasts.revoked` lists every `Broadcast.revoke`, as `{ user: "<id>" }` or `{ topic }`.

Authorization has its own helper:

```typescript
import { authorizeChannel } from "gemi/http";
import Channels from "@/app/http/routes/channels";

expect(await authorizeChannel(Channels, "site.:siteId", { siteId: bobsSite.publicId }, { as: alice })).toBe(false);
expect(await authorizeChannel(Channels, "page.:pageId", { pageId }, { as: requestWithOwnerCookie })).toBe(true);
```

`as` is a user (as if signed in), a `Request` (its cookies and headers are used), or nothing (a guest). A channel with middleware needs a booted application.

### Components

`<Page>` from `gemi/testing` never opens a socket. Pass it a `fakeSocket()` to push events and resyncs into the component under test:

```tsx
import { render, screen } from "@testing-library/react";
import { Page, fakeSocket } from "gemi/testing";

const socket = fakeSocket();
render(
  <Page socket={socket} queryData={{ "/sites/s1/pages": [] }}>
    <SitePages siteId="s1" />
  </Page>,
);

socket.emit("site.:siteId", "changed", { pages: ["/about"] }, { siteId: "s1" });
socket.resync("site.:siteId");
socket.deny("site.:siteId", "denied");
socket.setStatus("closed"); // `live` queries fall back to polling
expect(socket.subscriptions).toHaveLength(1);
```

`emit` takes a pattern (with its params) or a concrete topic; `"user"` matches the user channel. Subscriptions start `open`, and the fake never resyncs on its own.

## Broadcast, Change Feeds or `useChat`

| | Broadcast | Change Feeds |
|---|---|---|
| Purpose | keeping a UI fresh | processing every change, in order |
| Transport | one WebSocket per tab | an SSE route per feed |
| Missed events | the client resyncs and refetches | replayed from the cursor |
| Several instances | Redis pub/sub (coming) | Postgres NOTIFY |
| Authorization | `ChannelRouter` | the streaming route |

Use `useChat` for agent runs.
