# Broadcasting

gemi ships real-time messaging over websockets. You define **channels** on the server (route patterns with authorization logic), publish messages to them with the [`Broadcast`](./facades.md) facade, and subscribe to them from React components with `useSubscription`. A channel's topic is a route pattern — the same `:param` syntax used elsewhere in gemi — so a single channel definition can serve many concrete topics (one per room, per user, per order, …).

## Defining a channel

A channel is a class extending `BroadcastingChannel` from `gemi/broadcasting`:

```typescript
import { BroadcastingChannel } from "gemi/broadcasting";
import { Auth } from "gemi/facades";

export class ChatChannel extends BroadcastingChannel {
  // Authorize a client's subscription. Receives the matched route params
  // (from the topic pattern). Return true to allow, false to reject.
  async subscribe(params: { roomId: string }) {
    const user = await Auth.user();
    return await isMemberOfRoom(user.id, params.roomId);
  }

  // Transform the payload before it is delivered to subscribers.
  // Whatever you return is what clients receive as the message data.
  publish(input: { text: string; userId: string }) {
    return {
      text: input.text,
      userId: input.userId,
      at: Date.now(),
    };
  }
}
```

- **`subscribe(params)`** → `Promise<boolean> | boolean`. Called when a client tries to subscribe to a matching topic. It receives the route params parsed from the topic. Return `true` to authorize, `false` to reject. This is where you run auth/permission checks — the [`Auth`](./facades.md) facade works here because gemi runs it inside the request context of the socket. The base implementation returns `true` (public channel).
- **`publish(input)`** → the message payload. Called on the server each time you publish; its return value is serialized and delivered to every subscriber. Use it to shape/enrich the outgoing message. The base implementation returns `{}`.

> **Note:** `subscribe` runs per subscription attempt, so keep it cheap. If you don't override it, the channel is public — any client can subscribe.

## Topics and channels

Each channel is associated with a **topic route pattern** (e.g. `/chat/:roomId`). When a client subscribes to a concrete topic like `/chat/42`, gemi matches it against the registered patterns (shortest pattern first), extracts `{ roomId: "42" }`, instantiates the channel, and calls `subscribe({ roomId: "42" })` to authorize.

## Publishing from the server

Use the [`Broadcast`](./facades.md) facade to publish to a channel from a controller, job, or any server code:

```typescript
import { Broadcast } from "gemi/facades";

Broadcast.channel("/chat/:roomId", { roomId }).publish({
  text: "hello",
  userId: user.id,
});
```

- `Broadcast.channel(route, params)` resolves the registered channel for `route`, applies `params` to build the concrete topic, and returns a handle.
- `handle.publish(data, compress?)` runs the channel's `publish(data)` transform, then delivers `{ topic, data }` to every subscriber. Pass `compress: true` (default `false`) to enable per-message compression.

If no channel is registered for `route`, `Broadcast.channel` logs an error and returns a no-op `publish`, so a missing registration fails quietly rather than throwing.

## Subscribing from the client

Use `useSubscription` from `gemi/client` to receive messages in a component:

```tsx
import { useState } from "react";
import { useSubscription } from "gemi/client";

function ChatRoom({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<any[]>([]);

  useSubscription("/chat/:roomId", {
    params: { roomId },
    cb: (data) => setMessages((prev) => [...prev, data]),
  });

  return (
    <ul>
      {messages.map((m, i) => (
        <li key={i}>{m.text}</li>
      ))}
    </ul>
  );
}
```

`useSubscription(route, { params, cb })`:

- `route` — the channel's topic pattern (same string you registered).
- `params` — values for the pattern's `:params`, used to build the concrete topic to subscribe to.
- `cb(data)` — called for each message whose topic matches; `data` is the payload your channel's `publish` returned.

The hook subscribes on mount and unsubscribes on unmount (and re-subscribes when the resolved topic changes).

## Broadcasting from the client

`useBroadcast` returns a function that sends a payload straight to a topic from the browser (client-to-client relay, without going through a server-side channel transform):

```tsx
import { useBroadcast } from "gemi/client";

function Typing({ roomId }: { roomId: string }) {
  const broadcast = useBroadcast("/chat/:roomId", { params: { roomId } });

  return (
    <input
      onFocus={() => broadcast({ typing: true })}
      onBlur={() => broadcast({ typing: false })}
    />
  );
}
```

`useBroadcast(path, { params })` returns `(payload) => void`. It applies `params` to `path` to build the topic and relays `payload` to everyone subscribed to that topic. Subscribers receive it through their `useSubscription` `cb` just like a server-published message.

> **Note:** Server publishing (`Broadcast` facade) runs your channel's `publish` transform and is the right tool for authoritative events. `useBroadcast` is a lightweight client relay for ephemeral signals like typing/presence — it does not pass through the channel's `publish` method.

## Related

- [Facades](./facades.md) — the `Broadcast` and `Auth` facades used above.
- [Data Fetching](./data-fetching.md) — `useQuery` for request/response data.
- [Configuration](./configuration.md) — registering service providers.
