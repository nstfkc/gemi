# Iteration 2 — Queued listeners

**Goal.** `queued = true` on a listener moves it off the request path and onto
the existing queue, with `maxAttempts`, retries, dead-lettering and worker
threads coming from `QueueManager` rather than from anything written here.

```typescript
export class SendWelcomeEmail extends Listener {
  static name = "SendWelcomeEmail";
  static event = UserRegistered;
  queued = true;
  maxAttempts = 5;

  async handle(event: UserRegistered) { await Mail.send(event.email, ...); }
}
```

This is the iteration the stated use case actually wants — moving controller
side effects off the request — so most listeners in a real app will carry the
flag. That is the argument for making it one line, and also the argument for
being loud about what it changes (invariant 4).

## Prerequisite state

Iteration 1 is merged. Every dispatch goes through `EventManager`, listeners are
discovered from `app/listeners`, and `Event` declares `static name`.

## Read first

- `packages/gemi/services/queue/QueueManager.ts` — `push`, `next`, `run`, and
  `useJobs`. Three things below hinge on details in this file: `push` keys the
  queue entry off `job.name`, `useJobs` **replaces** the whole registry, and
  `run` reads `maxAttempts` and `worker` off a fresh instance per attempt.
- `packages/gemi/services/queue/Job.ts` — the hooks `run`/`onSuccess`/`onFail`/
  `onDeadletter` and their signatures, all of which the adapter has to satisfy.
- `docs/jobs-and-queues.md` — the retry semantics, stated for apps, which
  queued listeners now inherit verbatim.
- `packages/gemi/kernel/Kernel.ts` — `registerServices` and the two collision
  guards, for what "already bound" means.
- `packages/gemi/services/queue/QueueManager.test.ts` — how the queue is driven
  in a test without a running server.

## The shape: one synthetic job per queued listener

A queued listener is registered with the queue as a `Job` subclass generated at
boot:

```ts
// sketch
function jobForListener(L: ListenerClass): new () => Job {
  const cls = class extends Job {
    maxAttempts = new L().maxAttempts;
    worker = new L().worker;

    async run(eventName: string, args: unknown[]) {
      const event = app(EventManager).rehydrate(eventName, args);
      await new L().handle(event);
    }
  };
  Object.defineProperty(cls, "name", {
    value: `listener:${L.name}`,
    writable: true,
  });
  return cls;
}
```

`EventManager.dispatch` then splits: sync listeners are awaited in place as in
iteration 1, and each queued one becomes `app(QueueManager).push(job,
JSON.stringify([event.constructor.name, ctorArgs]))`.

Why adapt rather than grow a second queue: retries, `maxAttempts`,
dead-lettering, `concurrency` and worker-thread execution are four features that
already exist, are already documented for apps, and are already tested. A
parallel implementation would be four features that are almost the same.

`writable: true` on the redefined `name` is what makes the descriptor match the
one a declared `static name = "..."` field produces, which is what every "was
this name declared?" check in the framework reads — they compare descriptors,
not strings, because the two spellings read the same string in development.

**Correction, from the implementation.** This was written as
`warnIfNameWillNotSurviveTheBuild` reading it, and that check cannot see a
synthetic job: it is module-private to `discovery.ts` and runs only over the
classes `discoverJobs()` found on disk, while these are built in memory and
handed straight to `registerJob`. So nothing reads the flag today. It is kept
because the check that would report a synthetic entry as "a job you never wrote
and cannot fix" is one registry away — the queue's own — and because
`Object.defineProperty` keeps the attributes it is not given, so dropping the
flag silently leaves the class's non-writable `name` behind.

## Deliverables

### 1. `QueueManager.registerJob(job)`

`useJobs` replaces the registry wholesale (`this.jobs = {}`), so
`EventServiceProvider.boot()` cannot simply call it — the queue's own `boot()`
has already populated the registry by then, and calling `useJobs` again would
discard it. Reading `registeredJobs`, concatenating and calling `useJobs` back
works and is the wrong shape: it re-runs every collision check against jobs that
already passed them and reports duplicates a second time.

Add a single-job entry point beside `useJobs`, sharing its collision handling —
first claim wins, second refused on stderr — and appending to `config.jobs` so
`registeredJobs` keeps reporting everything it was handed.

Provider order matters from here: `EventServiceProvider` must sit **after**
`QueueServiceProvider` in `frameworkProviders`, because its `boot()` writes into
a registry the queue's `boot()` fills. Iteration 1 put it there already.

### 2. `Listener` gains `maxAttempts` and `worker`

Instance fields on `Listener`, defaulting to `3` and `false` — the same
defaults and the same meanings as `Job`, because they *are* `Job`'s, forwarded.
Both are ignored when `queued` is false, and that is worth a doc comment on each
rather than a note somewhere else: a `maxAttempts = 5` on a sync listener is a
line an author wrote that does nothing.

### 3. `static name` on a **queued** `Listener` becomes required

In iteration 1 the listener's own name was internal. Once it is queued the name
is the queue's key and it crosses a JSON boundary, so it inherits the whole
minification story from invariant 1 — and `discoverListeners` already has the
check written for the event class; point it at the listener class too.

Upgrade the iteration-1 advisory to something an author cannot miss: a queued
listener whose name is implicit is a side effect that stops happening in
production only.

**Narrowed, from the implementation.** This was written as "required on
`Listener`", meaning every listener, and the refusal belongs only where the
hazard is. The refusal is `jobForListener`'s and it throws at registration for a
queued listener; `warnIfListenerNameWillNotSurviveTheBuild` stays a warning for
a sync one, because a sync listener's name has no second reader for a minified
build to disagree with — every reader of it comes from the same source-side
walk. Refusing it would stop a boot over a failure that cannot occur, and the
warning names the upgrade path so an author adding `queued = true` later is not
surprised by it.

### 4. `EventManager.rehydrate(eventName, args)`

The queue hands the worker a name and an argument array; something has to turn
that back into an event instance. This is the second place invariant 1 is load-
bearing, and the first place `EventManager` needs to resolve an **event** class
by name rather than a listener.

So `EventManager` keeps a second registry: event name → event class, populated
from each listener's `static event` at `useListeners` time. An event nobody
listens for is never in it, which is exactly right — nothing can be queued for
it.

Rehydration is `new EventClass(...args)`, matching how `QueueManager` already
treats a job payload: **the constructor arguments are what is serialized, not
the instance.** An event whose constructor does work beyond assigning fields
does that work again in the worker; say so in the docs, next to the existing
"pass plain, serializable data" note for jobs.

A name that resolves to nothing here is the one case that must throw rather than
warn: the payload is already off the queue, the listener is about to be called
with `undefined`, and a `handle` reading `event.email` off it would fail
somewhere much less informative.

### 5. Documentation of the context boundary (invariant 4)

`queued = true` is a context boundary spelled as a field, and this is where it
gets written down properly — in the field's doc comment, and in `docs/events.md`
as its own subsection rather than a parenthesis:

- A sync listener runs inside the dispatcher's `kernelContext` and `ormContext`.
  It sees the request's `app()`, the authenticated user via `currentActor()`,
  and joins the ambient transaction.
- A queued listener runs from `QueueManager.next()` and may rely on none of it —
  and with `worker = true`, in a different thread with a cloned app.

The second bullet said "outside all of it" and the docs must not: the queue is
in-process and `push` starts the drain, so a queued listener frequently runs
*inside* the dispatching request's context, and whether it does depends on
whether the queue was already busy. Write it as what may be relied on, and see
the correction under invariant 4 — an intermittently present context is the
worse hazard of the two, not the milder one.

The failure this prevents is a policied `Model` read inside a listener returning
different rows depending on a flag the author set for latency reasons.

### 6. Durability, stated plainly

`QueueManager.queue` is a `Set` in memory. A queued listener that has not run
when the process exits does not run. This is not new — it is true of every job
today — but an event system invites "dispatch it and it will happen", so the
docs say the opposite in the queued section: a dispatch is not a durability
guarantee, and work that must survive a restart wants a row somewhere.

## Tests

- **Sync and queued in one dispatch.** Two listeners on one event, one of each:
  the sync one has run by the time `dispatchAndWait` resolves and the queued one
  has not; drive the queue and it runs.
- **`dispatchAndWait` does not wait for queued listeners.** The explicit form of
  the above, because the method name suggests otherwise.
- **Retries come from the queue.** A queued listener with `maxAttempts = 2` that
  always throws: attempted twice, `onDeadletter` reached. Assert against
  `QueueManager`'s existing path rather than re-testing retry logic.
- **Rehydration round-trips.** Constructor arguments in, equal field values on
  the instance the listener receives.
- **An unknown event name on the queue throws**, with the name in the message.
- **The synthetic job's `name` is a writable own property**, so the discovery
  warning does not fire on it. Cheap, and it protects a non-obvious line.
- **`registerJob` refuses a duplicate** without discarding the existing
  registry — the failure mode `useJobs` would have had.
- **Two listeners with the same `static name`** are refused at `useListeners`,
  and both still appear in `registeredListeners`.

## Open

**Do synthetic jobs belong in `QueueManager.registeredJobs`?** As written they
do, under `listener:SendWelcomeEmail`. In favour: `registeredJobs` is documented
as reporting what the manager was handed, a queued listener genuinely is
something the queue will run, and hiding it makes a queue introspection tool
lie. Against: an app listing its jobs now sees entries it never wrote, and the
prefix is the only thing marking them. Ship visible; revisit if the noise is
real.
