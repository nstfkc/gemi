# gemi events — implementation plan

Laravel-style events and listeners: one dispatch fans out to N handlers the
dispatcher does not know about.

```typescript
// the controller stops knowing what happens next
const user = await User.create(input);
UserRegistered.dispatch(user.id, user.email);
```

The thing being bought is that adding a fourth side effect becomes adding a
file, rather than editing the controller that already has three.

## Stack position

**Branch from `main`.** Nothing here depends on in-flight work. The three
iterations are independently shippable and want to land in order; each is a
release-note-sized change on its own.

## Why this is a small subsystem and not a large one

gemi already has three "something happened, now react" mechanisms, and the gap
between them is narrow:

| Mechanism | Fan-out | Where the handler runs |
| --- | --- | --- |
| `Job.dispatch()` | 1 → 1 | queue, retried, dead-lettered |
| `BroadcastManager.publish()` | 1 → N | *clients*, over websockets |
| a direct call in a controller | 1 → N | inline, and the caller names each one |

What is missing is exactly one row: **1 → N server-side handlers, where the
dispatcher does not hold the list.** Everything else an event system is
sometimes asked to do — retries, dead-lettering, worker threads, pushing to a
browser — is already built and should be reached rather than rebuilt. That is
why iteration 2 adapts `QueueManager` instead of growing a second queue.

**This plan does not include ORM lifecycle events** (`User.created` and
friends). That is a different system: it hooks the write path in `orm/`, it has
its own transaction-commit semantics, and it would arrive through
`Model.$exec` rather than through a dispatcher. If it is ever wanted, it wants
its own plan and can emit into this one.

## The one thing that does not port from Laravel

Laravel binds a listener to an event by **reflecting on the type-hint** of
`handle(UserRegistered $event)`. TypeScript erases types at runtime, so that
mechanism cannot exist here. The binding has to be carried as a *value*.

This is the constraint the API shape falls out of, and it is a favourable one:
making the binding a value is also what makes the payload types flow without a
generated registry.

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

```typescript
// app/listeners/SendWelcomeEmail.ts
import { Listener } from "gemi/services";
import { UserRegistered } from "@/app/events/UserRegistered";

export class SendWelcomeEmail extends Listener {
  static name = "SendWelcomeEmail";
  static event = UserRegistered;
  queued = true;

  async handle(event: UserRegistered) {
    await Mail.send(event.email, ...);
  }
}
```

**The binding lives on the listener, not the event.** The listener is the thing
with an opinion about what it cares about; an event has no business knowing who
is watching. That direction is also what keeps the property the subsystem is
bought for — adding a side effect is adding a file, and no existing file is
edited.

**A `static event` field, not a `Listener(UserRegistered)` class factory.** The
factory is the only shape in which the event cannot drift apart from `handle`'s
annotation, because it infers the parameter. It was rejected for reading oddly,
which is a fair price to refuse to pay for something every app writes dozens of
times: `static event` is how every other class in gemi declares things about
itself (`static token`, `static name`, `static $policies`).

No generic parameter is needed. `Listener` declares `handle(event: Event)`
and method parameter bivariance lets a subclass narrow it to `UserRegistered`.

What that costs is written down rather than hidden: **nothing checks that
`static event` and the annotation on `handle` agree.** Copy a listener, change
the static, forget the annotation, and TypeScript is satisfied while the
listener receives something else. It is an accepted seam, and it is accepted
because the failure is local and immediate — that one listener reads a field
that is not there, in its own stack — rather than the misroute-shaped failures
the invariants below exist to prevent. `static event` is constrained to an
`Event` subclass, which is as far as the type system reaches here.

`dispatch` forwarding its arguments to the constructor mirrors `Job.dispatch`'s
existing `Parameters<T["run"]>` trick, so the two subsystems read the same way
at the call site.

### One event per listener

`static event`, singular, and `static events = [A, B]` is deliberately not
offered.

A listener bound to two events has to discriminate inside `handle`, and the
natural way to write that is `if (event instanceof UserRegistered)`. That is
unsound here for precisely the reason invariant 1 gives: the controller
dispatches an instance built from the **bundled** `UserRegistered` while the
listener's `instanceof` tests against the **source** one, so it is `false` in
production and `true` in every test. The plural form's ergonomics invite a
silent production-only bug into application code, which is a worse thing to ship
than a little duplication.

Two events wanting the same side effect are two small listeners calling one
shared function.

## Invariants

These hold across all three iterations. Each is here because breaking it
produces a *silent* wrong result rather than an error.

### 1. The registry is keyed by declared `static name`, never by class identity

This is the least obvious decision in the plan and the one most likely to be
"simplified" away, so it is first.

A `Map<typeof Event, Listener[]>` keyed by the class object is the obvious
implementation and it is wrong in production only. `gemi build` minifies the
server entry, and the app code reachable from it — the controller, and every
event class that controller imports in order to dispatch — is bundled and
minified with it. Discovery, meanwhile, imports `app/listeners/*.ts` from source
at runtime, and those files import `app/events/UserRegistered.ts` from source
too. **Two module graphs, two `UserRegistered` class objects.** An
identity-keyed map looks up the bundled one, finds the entry registered under
the source one, and returns nothing.

The failure that produces is a dispatch with zero listeners, which is legal,
normal, and completely silent. It would work in development, pass every test,
and do nothing in production.

A declared `static name = "UserRegistered"` is a string literal. Minification
leaves string literals alone, so both halves agree. This is the same hazard
`services/discovery.ts:warnIfNameWillNotSurviveTheBuild` already documents for
jobs, one subsystem over, and it is worse here because a job at least logs when
its name resolves to nothing.

Consequence: `static name` is **required on `Event`**, and required on
`Listener` from iteration 2 (where the listener name crosses the queue's JSON
boundary). Both get the writable-own-property check that discovery already
applies to jobs.

**Corollary, for application code: never `instanceof` an event.** The same two
class objects make `event instanceof UserRegistered` inside a listener `true` in
development and `false` in a production build. Nothing the framework does can
fix that, so the framework's job is to never need it — which is why a listener
binds to exactly one event (above), and why `docs/events.md` says this out loud
rather than leaving it to be discovered.

### 2. A dispatch with zero listeners warns in development

Following directly from invariant 1: the one observable symptom of the bug
above, of a typo'd event name, and of a listener directory that was never
walked, is all the same symptom — nobody handled it. Since zero listeners is
also a perfectly legal steady state, the warning is development-only and fires
once per event name.

This is the entire early-warning system for the subsystem. It is cheap and it
is not optional.

### 3. One listener's failure never prevents another listener from running

Listeners are independent side effects by construction. Letting listener 2
cancel 3 through 5 makes registration order load-bearing, which is the exact
coupling the subsystem exists to remove — and registration order comes from a
filesystem walk, so it is not even something an author chose.

Each listener's error is caught, logged with the event and listener names, and
the next one runs. Queued listeners keep the queue's existing retry and
dead-letter path instead.

### 4. Whether a listener is sync or queued changes what `app()` resolves to

A sync listener runs inside the dispatcher's `kernelContext` and `ormContext`:
it has the request's `app()`, the authenticated user, and the ambient
transaction. A queued listener runs in a cloned app with none of that.

`queued = true` is therefore not a performance toggle, and must not be
documented as one. It is a context boundary that happens to be spelled as one
line. Every doc and doc comment that mentions it says so.

### 5. Nothing in the framework dispatches an event

Only application code does, in these three iterations. Framework-internal
fan-out has other mechanisms and adding a framework event now would fix its
name and payload before there is a second consumer to check the shape against.

## Decisions, settled

| Decision | Choice | Why not the other one |
| --- | --- | --- |
| Binding direction | on the **listener** (`static event`) | an event listing its listeners means adding a side effect edits an existing file, and it puts knowledge of the watchers in the thing being watched |
| Binding spelling | `static event = E` field | `Listener(E)` as a class factory is the only drift-proof shape, and reads oddly enough to lose the trade for something written this often |
| Events per listener | exactly one | the plural form forces `instanceof` in app code, which is unsound across the build boundary (invariant 1) |
| Default execution | **sync**, `queued = true` opts out | errors surface at the dispatch site; the listener keeps the request's context. Most listeners in an app like this will opt in — that is fine, and it should be a decision each one makes out loud |
| Await semantics | `dispatch()` returns `void`; `dispatchAndWait()` returns a promise | one method that is sometimes worth awaiting is a method nobody knows whether to await |
| Listener errors | caught per listener, logged, others continue | see invariant 3 |
| Registration | discovered from `app/listeners`, `listeners` config slice overrides | matches jobs, cron and commands; same "declared wins, and `[]` is declared" rule |
| Queued execution | adapts `QueueManager` | retries, `maxAttempts`, dead-lettering and worker threads already exist and are already tested |
| Transaction safety | opt-in `static afterCommit = true` | see iteration 3 — defaulting it on would make `dispatch` inside a transaction silently not happen yet, which is its own surprise |

## Decisions, open

Flagged where they land, not settled here.

- **Do synthetic listener jobs appear in `QueueManager.registeredJobs`?**
  (iteration 2). They will, under a `listener:` prefix, unless deliberately
  filtered. Visible is probably right; noisy is the counter-argument.
- **What happens to an abstract listener base that lives in `app/listeners`?**
  It gets discovered either way, because `discoverClasses` excludes only the
  `base` it was handed, not intermediates. What happens next depends on whether
  it declares `static event`. **Without one it stops the boot** — iteration 1 §4
  refuses a listener that binds to nothing rather than warning about it, and the
  message names the class and says to move a shared base out of the directory.
  That is the shared-gate case, and it is the narrower answer of the two. **With
  one** it is registered and run like any other listener, which is the residual
  jobs and cron have today. Iteration 1 documents both; a
  `static abstract = true` opt-out is available if it turns out to bite.
- **Should `afterCommit` be the default in a later major?** Iteration 3 ships it
  opt-in and revisits with usage.

## Iterations

1. **[Sync dispatch](./01-sync-dispatch.md)** — `Event`, `Listener`,
   `EventManager`, discovery, sync fan-out, the zero-listener warning. Useful on
   its own.
2. **[Queued listeners](./02-queued-listeners.md)** — `queued = true`, routed
   through `QueueManager` via a synthetic job per listener.
3. **[After-commit and testing](./03-after-commit-and-testing.md)** —
   `afterCommit` hooked into `withTransaction`, plus `Event.fake()` and the
   assertions.
