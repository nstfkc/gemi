# Iteration 1 — Sync dispatch

**Goal.** `UserRegistered.dispatch(user.id, user.email)` in a controller runs
every listener under `app/listeners` that was written against `UserRegistered`,
in-process, with the payload fully typed at both ends.

No queueing, no transaction awareness, no test fakes. Those are iterations 2 and
3 and each of them is additive. This one is the skeleton, and it is worth
shipping alone: a listener that does a fast in-request side effect is a real use
of it.

Read [README.md](./README.md) first — especially invariants 1 and 2, which this
iteration establishes and the later ones only inherit.

## Read first

- `packages/gemi/services/queue/Job.ts` — 25 lines, and the closest thing to
  what `Event` is. Note the `static dispatch` typed through
  `Parameters<T["run"]>`; `Event.dispatch` is the same trick through
  `ConstructorParameters`.
- `packages/gemi/services/queue/QueueManager.ts` — `useJobs` and the collision
  handling. `EventManager` is shaped like this and makes the same choices for
  the same reasons.
- `packages/gemi/services/queue/config.ts` — the "declared wins, and `[]` is
  declared" doc comment. The `listeners` slice repeats it, and the reasoning
  transfers verbatim.
- `packages/gemi/services/queue/QueueServiceProvider.ts` — why discovery lives
  in `boot()` and reads the *raw* slice rather than the defaulted config.
- `packages/gemi/services/discovery.ts` — `discoverJobs`, `resolveDir`,
  `warnIfSourceIsMissing`, and `warnIfNameWillNotSurviveTheBuild`. All four have
  an events counterpart; the last one is invariant 1.
- `packages/gemi/support/discover.ts` — `discoverClasses(dir, base, ignore,
  onSkipped)`. The `base` is excluded from results but intermediate classes are
  not.
- `packages/gemi/kernel/providers.ts` — `frameworkProviders`, in registration
  order. Order matters for `boot()` only.
- `packages/gemi/support/Service.ts` — `static token`, the house pattern for a
  class declaring its own registration key, which `static name` and
  `static event` follow.
- `packages/gemi/services/index.ts` — the barrel. `gemi/services` publishes no
  subpaths, so anything an app needs has to be re-exported here.
- `packages/gemi/barrel-imports.test.ts` — why the barrel must not pull in
  anything heavy at module scope.

## Deliverables

### 1. `packages/gemi/services/events/Event.ts`

```ts
// sketch
export abstract class Event {
  static name = "unset";

  static dispatch<T extends new (...args: any[]) => Event>(
    this: T,
    ...args: ConstructorParameters<T>
  ): void {
    app(EventManager).dispatch(new this(...args));
  }

  static dispatchAndWait<T extends new (...args: any[]) => Event>(
    this: T,
    ...args: ConstructorParameters<T>
  ): Promise<void> {
    return app(EventManager).dispatchAndWait(new this(...args));
  }
}
```

Two methods rather than one, because "is this worth awaiting" is a question the
call site should not have to guess at. `dispatch` is fire-and-forget and matches
`Job.dispatch`'s shape; `dispatchAndWait` resolves once every sync listener has
settled — it does **not** wait for queued ones, and its doc comment says so in
those words, because "and wait" invites exactly that reading.

`static name = "unset"` and a throw on dispatching it, copied from `Job`. The
throw is the cheap half of invariant 1; `warnIfNameWillNotSurviveTheBuild` in
§4 is the half that catches the case where a name exists but is the implicit
class binding.

The event instance is what listeners receive. It carries no framework state —
no timestamp, no id, no `propagationStopped`. An event is the payload plus a
name, and anything else is a field the app can add itself.

### 2. `packages/gemi/services/events/Listener.ts`

```ts
// sketch
export abstract class Listener {
  static name = "unset";
  static event: EventClass;

  queued = false;

  abstract handle(event: Event): void | Promise<void>;
}
```

One exported name, and a plain class — `extends Listener`, the way everything
else in gemi is written. No generic parameter: the base annotates `handle` with
`Event` and method parameter bivariance is what lets `SendWelcomeEmail` narrow
it to `UserRegistered` without one.

`static event` holds the event **class**, not its name. The name is read from it
at registration time inside `useListeners`, not here, and that is deliberate:
the class reference is only ever dereferenced in the module graph that declared
it, so the name it yields is the source one. Nothing downstream holds the class
for dispatch (invariant 1).

`handle` is abstract so a listener that forgets it fails to compile rather than
silently handling nothing.

`static event` is typed as an `Event` subclass constructor, which is as far as
the type system reaches. **It cannot check that `static event` agrees with the
annotation on `handle`** — statics and instance members cannot reference each
other's types — and the README records that as an accepted seam. The `.test-d.ts`
under **Tests** pins the half that *is* checkable, so the constraint is not
quietly widened to `any` by a later refactor reaching for convenience.

The plan deliberately does **not** grow a `static events` array. The reasoning
is in the README under "One event per listener"; the short version is that the
plural form pushes `instanceof` into application code, where it is `true` in
every test and `false` in production.

### 3. `packages/gemi/services/events/EventManager.ts`

```ts
// sketch
export class EventManager {
  static token = "events";   // free — checked against every registered token

  private listeners: Record<string, ListenerClass[]> = {};
  private warnedFor = new Set<string>();

  constructor(config: EventConfig = {}) { ... }

  useListeners(listeners: ListenerClass[]) { ... }
  get registeredListeners(): ReadonlyArray<ListenerClass> { ... }

  dispatch(event: Event): void { void this.dispatchAndWait(event); }
  async dispatchAndWait(event: Event): Promise<void> { ... }
}
```

Shaped after `QueueManager` deliberately — same construction-in-`register()`,
same `use*` handover from `boot()`, same `registered*` getter reporting what it
was *handed* rather than what it accepted, so a test can see a collision instead
of having it tidied away.

Three behaviours that are not `QueueManager`'s:

**Many listeners per key, not one.** `Record<string, Listener[]>`, appended to.
Two listeners for one event is the normal case here, where two jobs for one name
is the pathological one. The collision `useListeners` does have to refuse is two
*listener classes* with the same `static name` — that only matters once
iteration 2 puts the name on the wire, but it is refused from the start so the
rule does not appear to change later.

**Registration order is the walk's order.** `discoverClasses` documents its
order as stable — the walk's, and within a file the module namespace's, which
the language sorts by name. It is therefore reproducible but not *meaningful*,
and no listener may depend on running before another. Invariant 3 is what makes
that safe to say: nothing a listener does can stop the next one.

**A zero-listener dispatch warns, in development, once per event name**
(invariant 2):

```ts
// sketch
if (!handlers?.length && process.env.NODE_ENV !== "production") {
  if (!this.warnedFor.has(name)) {
    this.warnedFor.add(name);
    console.warn(
      `[gemi] ${name} was dispatched and nothing is listening for it. ` +
        `A listener registers under the name its event declares, so check ` +
        `that app/listeners holds a Listener with \`static event = ${name}\` ` +
        `and that ${name} declares \`static name = "${name}"\`. ` +
        `Development only.`,
    );
  }
}
```

Once per name, because a dispatch in a loop would otherwise bury the terminal.
`warnedFor` is per-manager and the manager is per-app, so a test that builds a
fresh kernel gets a fresh set.

**Errors.** Each listener runs inside its own `try`. A throw is logged with the
event name, the listener name, and the error, and the loop continues. Nothing
propagates to the dispatcher — `dispatch` has already returned, and
`dispatchAndWait` resolving to a rejection would mean listener 1's failure
becomes the caller's problem while listener 5's does not, depending only on
where the throw landed. Neither method rejects.

### 4. `packages/gemi/services/discovery.ts` — `discoverListeners`

The fourth function in the file, built exactly like `discoverJobs`:

```ts
// sketch
export async function discoverListeners(
  dir: string = eventConfigDefaults().listenersDir,
): Promise<ListenerClass[]> {
  const resolved = resolveDir(dir);
  warnIfSourceIsMissing(resolved, "event listeners", "events");
  const listeners = await discoverClasses(resolved, Listener);
  warnIfListenerNameWillNotSurviveTheBuild(listeners);
  warnIfEventNameWillNotSurviveTheBuild(listeners);
  return listeners;
}
```

Two name checks rather than one, and the second is the one that matters. A
listener's own name does not go on the wire until iteration 2, but the **event**
name is invariant 1 from the first dispatch. Each listener carries its event
class on `static event`, so the check is
`Object.getOwnPropertyDescriptor(L.event, "name")?.writable` — the same exact
test `warnIfNameWillNotSurviveTheBuild` uses, for the same reason: a declared
`static name` is a writable own property while an implicit class binding is not.

A listener whose `static event` is missing entirely is refused here rather than
warned about. It cannot be registered under any name, so it would be a file the
author wrote that never runs — the silence this whole file is arranged against.

Do not skip this by checking the string instead. `UserRegistered.name` reads
`"UserRegistered"` in development whether it was declared or not; the descriptor
is what tells the two apart, and the difference only becomes visible in a
production build.

**Known residual, matching jobs and cron.** `discoverClasses` excludes the
`base` it is handed but not intermediates, so an abstract listener base written
in `app/listeners` and extended by its siblings is itself discovered and
registered. It will be constructed and its `handle` called on every matching
dispatch. `discoverClasses`'s own doc comment describes this shape as the one
"an app reaches for when several jobs share a gate", so it is not hypothetical.
Document it in `docs/events.md`; keep shared bases outside `listenersDir`. A
`static abstract = true` opt-out is the fix if it bites, and is deliberately not
built now.

### 5. `packages/gemi/services/events/config.ts`

```ts
// sketch
// Config key: `events`. Derived from `EventServiceProvider`.
export interface EventConfig {
  listeners?: ListenerClass[];
  listenersDir?: string;
}

export function defineEventConfig(config: EventConfig): EventConfig { return config; }

export function eventConfigDefaults(): Required<EventConfig> {
  return { listeners: [], listenersDir: "app/listeners" };
}
```

The `listeners` doc comment carries the same rule as `queue.jobs`, and the
reasoning transfers with one substitution: what a hand-maintained list drifting
out of step costs here is not a dropped job but a side effect that stops
happening, with the zero-listener warning (development only) as the only trace.

No `eventsDir`. Event classes are never discovered — they are imported by the
listener that binds to them and by the controller that dispatches them, so
nothing needs to walk them, and a directory walk that imported them for no
reason would just be a boot cost.

### 6. `packages/gemi/services/events/EventServiceProvider.ts`

`register()` binds the singleton from the raw slice. `boot()` does discovery,
and reads the **raw** slice — not the defaulted config — for the reason
`QueueServiceProvider.boot` documents at length: `withDefaults` cannot tell an
absent key from an `undefined` one, and both from a deliberate `[]`, so the raw
slice is the only place the distinction still exists.

Registered in `kernel/providers.ts`. Position does not matter in iteration 1
(`register()` resolves nothing, and its `boot()` depends on no other provider) —
but put it **after** `QueueServiceProvider`, because iteration 2 needs its
`boot()` to run after the queue's registry is populated. Putting it in the right
place now saves a reordering in a patch that is otherwise about something else.

### 7. Exports and docs

- `services/index.ts` gains an `// Events` section: `EventServiceProvider`,
  `EventManager`, `Event`, `Listener`, `defineEventConfig`, and
  `discoverListeners`. Every manager in that file is exported beside its
  provider; `docs-imports.test.ts` exists because `AuthManager` was not.
- Nothing new in the `exports` map. `gemi/services` already publishes and
  `barrel-imports.test.ts` guards what it costs — none of these modules imports
  anything at module scope beyond the container, so the barrel stays cheap.
- `docs/events.md`, plus an entry in `docs/README.md` and `docs/llms.txt` /
  `llms-full.txt` if those are generated rather than written.
- `docs-imports.test.ts` checks every `import … from "gemi/…"` in the docs
  against the entrypoint, so the doc and the barrel land together or the suite
  fails.

## Tests

Colocated vitest, following `QueueManager.test.ts`.

- **Fan-out.** Two listeners on one event, both run, both receive the same
  instance with the constructor's arguments on it.
- **Isolation.** Three listeners, the middle one throws: the third still runs,
  neither `dispatch` nor `dispatchAndWait` rejects, the error is logged with
  both names. This is invariant 3 and it is the one a refactor breaks.
- **`dispatchAndWait` actually waits.** An async listener that resolves on a
  deferred; assert the promise has not settled before it does.
- **Zero listeners warn once.** Dispatch the same event three times, one
  warning. Dispatch a second unlistened event, a second warning. Nothing in
  `NODE_ENV=production`.
- **The name check reads the descriptor, not the string.** Build one event class
  with `static name = "X"` and one whose name is implicit but reads `"X"`
  anyway; only the second warns. Without this test the check silently degrades
  to a tautology on the next refactor.
- **`registeredListeners` reports what was handed in**, including a duplicate
  `static name` that `useListeners` refused.
- **Order is the walk's order**, asserted against a fixture directory, so the
  "reproducible but not meaningful" claim in §3 is at least the first half true.
- **Discovery**: a fixture `app/listeners` tree; a nested directory; a file that
  cannot be imported raises `DiscoveryError` rather than being skipped.
- **Declared wins, and `[]` is declared** — three provider-level cases
  (`listeners: [X]`, `listeners: []`, key absent), asserting whether the
  directory was read at all.
- **A listener with no `static event` is refused**, by name, at `useListeners`.

And one type test, `services/events/Listener.test-d.ts`, following
`console/builder.test-d.ts`:

- `static event = SomethingThatIsNotAnEvent` is an error.
- `handle(event: UserRegistered)` narrowing the base's `Event` parameter is
  *not* an error — that is the bivariance the no-generic design leans on, and if
  a future `strictFunctionTypes`-adjacent change breaks it, every listener in
  every app breaks at once.

Neither can express the seam itself. The point of writing them down is that the
two things the compiler *does* enforce here are load-bearing and easy to widen
into `any` by accident.

## Out of scope

`queued`, `afterCommit`, `Event.fake()`, event subclass listeners (a listener
bound to a base event class receiving its subclasses), wildcard listeners, and
listener priority. The last two are worth resisting specifically: priority is
invariant 3 arriving through the back door, and a wildcard listener cannot be
typed against a payload.
