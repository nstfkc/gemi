# Events & Listeners

An event is something your application did, announced to nobody in particular. A **listener** is one side effect of it, in its own file. One dispatch fans out to every listener bound to that event, and the code that dispatched it does not hold the list.

```typescript
// The controller stops knowing what happens next.
const user = await User.create(input);
UserRegistered.dispatch(user.id, user.email);
```

That is the whole of what this buys: adding a fourth side effect to a registration becomes **adding a file**, rather than editing the controller that already has three.

Listeners run **in-process and synchronously** inside the dispatching request — see [When to reach for a job instead](#when-to-reach-for-a-job-instead).

## Defining an event

An event is a class extending `Event` (from `gemi/services`) with a **static `name`** and a constructor holding the payload. Events live wherever you like; `app/events/` is the convention.

```typescript
// app/events/UserRegistered.ts
import { Event } from "gemi/services";

export class UserRegistered extends Event {
  static name = "UserRegistered";

  constructor(
    public userId: number,
    public email: string,
  ) {
    super();
  }
}
```

An event is the payload plus a name. It carries no framework state — no timestamp, no id, no "stop propagation" — because each of those is a field you can add yourself if you want one, and a listener that could cancel the listeners after it would make registration order matter (see [When a listener throws](#when-a-listener-throws)).

> **Note:** The static `name` is **required**, and omitting it does not fall back harmlessly to the class name. The listener registry is keyed by this string. `gemi build` minifies the server entry, and the app code reachable from it — your controller, and every event class it imports in order to dispatch — is bundled and minified with it, which renames the class binding; a class's implicit `.name` *is* that binding, so `UserRegistered` becomes something like `D`. Discovery, meanwhile, imports `app/listeners/*.ts` from source at runtime, and those files import `app/events/*.ts` from source too. Two module graphs, two class objects, two different names — and the dispatch reaches nobody, in production and nowhere else. A declared `static name` is a string literal, which survives minification intact. Discovery warns at boot about any event a listener binds to that leaves it out.

### Never `instanceof` an event

The same two class objects are why this is unsafe **in your own code**:

```typescript
// Don't. `true` in development and in every test, `false` in a production build.
if (event instanceof UserRegistered) { /* ... */ }
```

Your listener's `UserRegistered` came from source; the instance it was handed was built from the bundled one. Nothing the framework does can fix that, so the framework's job is to never need it — which is why a listener binds to exactly one event and always knows what it received.

## Writing a listener

A listener is a class extending `Listener` (from `gemi/services`) under `app/listeners/`, with a static `name`, a static `event`, and a `handle` method.

```typescript
// app/listeners/SendWelcomeEmail.ts
import { Listener } from "gemi/services";
import { UserRegistered } from "@/app/events/UserRegistered";

export class SendWelcomeEmail extends Listener {
  static name = "SendWelcomeEmail";
  static event = UserRegistered;

  async handle(event: UserRegistered) {
    await sendWelcome(event.email);
  }
}
```

The directory is read at boot, so writing the file is all it takes — there is no list to keep alongside it.

**The binding lives on the listener, not on the event.** The listener is the thing with an opinion about what it cares about; an event has no business knowing who is watching. An event listing its listeners would also put the property back the way it was: adding a side effect would mean editing an existing file.

**Annotate `handle` with the event you bound to.** Narrowing the base class's `Event` parameter is legal and is how the payload gets typed without a generic to carry around. What the compiler *cannot* check is that the annotation and `static event` agree — a static and an instance member cannot reference each other's types. Copy a listener, change the static, forget the annotation, and TypeScript is satisfied while the listener receives something else. The failure is local and immediate (that one listener reads a field that is not there, in its own stack), which is why it is an accepted seam rather than a reason to complicate the API.

### One event per listener

There is no `static events = [A, B]`, deliberately. A listener bound to two events has to discriminate inside `handle`, and the natural way to write that is `event instanceof UserRegistered` — which is exactly the line that is `true` in every test and `false` in production. Two events wanting the same side effect are two small listeners calling one shared function.

### Configurable fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `static name` | `string` | `"unset"` | Unique listener identifier. Required. |
| `static event` | `Event` subclass | — | The one event this listener handles. Required. |
| `handle` | method | — | The side effect. May be `async`. Required. |

## Dispatching

Call `dispatch` with exactly the arguments your event's constructor takes — the call is typed against it, the same way `Job.dispatch` is typed against `run`.

```typescript
import { UserRegistered } from "@/app/events/UserRegistered";

UserRegistered.dispatch(user.id, user.email);
```

`dispatch` returns `void`. It fires the listeners and moves on; nothing they do can be reported back to the call site.

When the caller genuinely needs the side effects to have happened first — a request that renders what a listener wrote, or a test asserting on the result — use `dispatchAndWait`:

```typescript
await UserRegistered.dispatchAndWait(user.id, user.email);
```

It resolves once every listener has settled. Two methods rather than one that is sometimes worth awaiting, because "should I await this?" is a question the call site should not have to guess at.

Listeners run **one at a time**, each awaited before the next one starts, so registration order is the order they run in and not merely the order they start. The cost is worth knowing: a listener that *hangs* — an un-timed-out request to a host that never answers — holds up every listener after it for as long as it hangs, and under `dispatch` the caller has already moved on, so the row a later listener writes is simply not there yet. A listener that can block indefinitely wants its own timeout, or a [job](./jobs-and-queues.md). A listener that *throws* is not this case — see below.

Neither method ever rejects. See below.

## When a listener throws

Each listener runs inside its own `try`. A throw is logged with the event name, the listener name and the error, and **the next listener still runs**.

That is not politeness, it is the point. Listeners are independent side effects, and their order comes from a filesystem walk rather than from anything you chose — so letting listener 2 cancel 3 through 5 would make that walk load-bearing, which is the exact coupling events exist to remove. For the same reason neither `dispatch` nor `dispatchAndWait` rejects: a rejection would make listener 1's failure the dispatcher's problem while listener 5's silently was not, depending only on where in the walk the throw landed.

A listener that must not fail silently should handle its own errors — retry, log to your own sink, or dispatch a [job](./jobs-and-queues.md) that can be retried and dead-lettered.

## When nothing is listening

A dispatch with no listeners is legal and does nothing. In development it warns **once per event name**:

```
[gemi] UserRegistered was dispatched and nothing is listening for it. ...
```

That single line is the whole early-warning system here, because four different mistakes produce the same symptom: an event that never declared `static name`, a typo, a listener that was never discovered, and a listener directory that was never walked. It fires once per name so that a dispatch in a loop does not bury the terminal, and never in production, where "no listeners" is an ordinary answer.

## Registering listeners — `app/listeners/`

Every class under `app/listeners` that extends `Listener` is registered when the kernel boots.

Event classes are **not** discovered, and there is no `eventsDir`. Each event is already in the module graph — imported by the listener that binds to it, and by the code that dispatches it — so a walk over them would only be a boot cost.

### Two listeners, one name

A listener's `static name` identifies it, and two classes cannot claim the same one. The first is registered, the second is refused with a line on stderr. A directory walk is what makes that ordinary: `auth/NotifyAdmins.ts` beside `billing/NotifyAdmins.ts` is a natural thing to write, and nothing forces the import alias a hand-written list would have demanded. Rename one.

Both still appear in `registeredListeners`, which reports what the manager was handed rather than what it accepted, so a test walking it sees the clash.

### A listener that binds to nothing stops the boot

A `Listener` subclass with no `static event` cannot be registered under any name, so it would be a file you wrote that never runs. Discovery refuses it by name rather than warning, because there is no reading of it under which you meant it.

The usual cause is a **shared abstract base living in `app/listeners`**. The walk excludes gemi's own `Listener` and nothing else, so a base beside its subclasses is discovered like one of them — and if it does declare a `static event`, it is *registered* like one of them too, constructed with its `handle` called on every dispatch of that event. Keep shared bases outside the listeners directory.

### What the walk costs

A class does not exist until its module has run, so there is no way to read a directory of classes without importing it. **Every `.ts`/`.tsx` file under `app/listeners` is imported at boot** — in development and in production, on every start — and a file that *does something* when it is imported does that thing at boot.

So `app/listeners` wants to hold listener declarations rather than merely contain some. A file that cannot be imported at all fails the boot naming itself, rather than being quietly left out of the registry.

The walk skips what certainly is not a declaration: `.d.ts` files, tests, type tests and benchmarks by their filename suffix, dot-directories, `node_modules`, and anything under a directory carrying its own `package.json`.

Registration order is the walk's order — sorted per directory, and by name within a file. It is reproducible, and it is not meaningful: nothing about a directory layout was chosen to express "run this listener first", so no listener may depend on running before another.

## Configuring — `app/config/events.ts`

The `events` slice is where you can take over registration yourself. Declaring `listeners` turns discovery off and uses your list verbatim — reach for it when the listeners live somewhere the walk cannot reach, when you want a deliberate subset, or when the deploy ships only the build output and there is no `app/listeners` on disk to read.

```typescript
// app/config/events.ts
import { defineEventConfig } from "gemi/services";
import { SendWelcomeEmail } from "@/app/listeners/SendWelcomeEmail";

export default defineEventConfig({
  listeners: [SendWelcomeEmail], // omit to discover them from app/listeners
});
```

`defineEventConfig` is an identity helper — it exists only to type the object.

**A present `listeners` wins, and `listeners: []` is present.** An empty array means an application with no listeners and is honoured as such; it does not mean "go and find some". Leaving the key out — or leaving the slice out entirely — is what asks for discovery.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `listeners` | `Listener` subclasses | *discovered* | Every listener to register. Omit to discover them from `listenersDir`. |
| `listenersDir` | `string` | `"app/listeners"` | Where to discover them. Relative to the project root, or absolute. |

The slice is wired into the kernel by name:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import events from "../config/events";

export default class extends Kernel {
  config = { events /* , ...other slices */ };
}
```

Behind the scenes the framework's `EventServiceProvider` reads that slice in its `register()` and binds an `EventManager` singleton into the container under the token `"events"`, then fills in the discovered listeners in its `boot()`.

## Resolving the manager

`EventManager` is a normal container binding:

```typescript
import { app } from "gemi/foundation";
import { EventManager } from "gemi/services";

app(EventManager); // typed EventManager, no cast
```

`registeredListeners` is the set it ended up with, discovered or declared — that is what a test asserts against:

```typescript
import { app } from "gemi/foundation";
import { EventManager } from "gemi/services";

expect(app(EventManager).registeredListeners).toHaveLength(3);
```

`discoverListeners()` answers the same question without an application around it. Every file it walks is imported, as above:

```typescript
import { discoverListeners } from "gemi/services";

const listeners = await discoverListeners(); // every Listener under app/listeners
```

## When to reach for a job instead

Listeners run **inside the dispatching request**, in the same process, in the same context: a listener has the request's `app()`, its authenticated user, and its ambient transaction. That makes them right for fast in-request side effects — writing an audit row, warming a cache, updating a counter — and wrong for slow ones, because the request waits for `dispatchAndWait` and the process still does the work either way.

For anything slow or retryable, dispatch a [`Job`](./jobs-and-queues.md) from the listener. The queue is where retries, `maxAttempts`, dead-lettering and worker threads already live.

Four mechanisms, one row each:

| Mechanism | Fan-out | Where the handler runs |
| --- | --- | --- |
| a direct call in a controller | 1 → N | inline, and the caller names each one |
| `Event.dispatch()` | 1 → N | inline, and the caller names none of them |
| `Job.dispatch()` | 1 → 1 | the queue: retried, dead-lettered |
| `Broadcast.publish()` | 1 → N | *clients*, over websockets |

gemi has no ORM lifecycle events (`User.created` and friends) — a model write does not emit anything. Dispatch explicitly from the code that did the write.

## Related

- [Jobs & Queues](./jobs-and-queues.md) — background work with retries, which a listener often dispatches.
- [Broadcasting](./broadcasting.md) — fan-out to browsers rather than to server-side handlers.
- [Controllers](./controllers.md) — dispatching from request handlers.
- [Project Structure](./project-structure.md) — the kernel, `app/config/*.ts`, and service providers.
