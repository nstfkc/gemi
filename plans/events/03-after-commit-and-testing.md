# Iteration 3 — After-commit dispatch, and testing

**Goal.** Two unrelated things that both only become possible once the
subsystem exists, and neither of which is large enough for its own iteration.

1. `static afterCommit = true` on an event: dispatched inside a transaction, its
   listeners run when that transaction commits, and not at all if it rolls back.
2. `Event.fake()` and the assertions, so a controller test can say what was
   dispatched without running the side effects.

## Prerequisite state

Iterations 1 and 2 are merged.

## Read first

- `packages/gemi/orm/context.ts` — `ormContext`, the `OrmScope` interface,
  `withTransaction`, and `transactionDepth()`. The whole of part one lands in
  this file and it is worth reading the doc comments before touching it; the
  savepoint branch and the outermost branch are structurally different and only
  one of them may run the callbacks.
- `packages/gemi/orm/context.test.ts` — especially "two concurrent transactions
  never see each other's handle", which is the property part one must not break.
- `packages/gemi/testing/index.ts` and `Page.tsx` — what the testing entrypoint
  currently publishes, and its idioms.
- `packages/gemi/services/queue/QueueManager.test.ts` — how a test drives the
  queue, for the interaction between a fake and a queued listener.

---

## Part one — `afterCommit`

### The problem

```typescript
await DB.transaction(async () => {
  const user = await User.create(input);
  UserRegistered.dispatch(user.id, user.email);   // welcome email sent
  await Billing.provision(user);                  // throws
});                                               // rolled back
```

The user does not exist and has been welcomed. Sync listeners have already run;
queued ones are on an in-memory queue that has no idea a transaction was
involved. Laravel added `ShouldDispatchAfterCommit` for exactly this shape.

gemi can detect it precisely, which not every framework can: `ormContext` holds
the open handle and the nesting depth, and `withTransaction` is the single
implementation behind both `Model.transaction` and `DB.transaction`, so there is
one place to hook and no second path around it.

### Deliverables

**1. `OrmScope` gains an after-commit callback list.**

Held on the **outermost** scope only, and this is the part to get right. A
savepoint's scope is created by spreading the current one
(`{ ...current, tx: nested, depth: current.depth + 1 }`), so a naive array field
is shared by reference with the parent — which is, for once, the behaviour
wanted: a dispatch inside a savepoint that commits, in a transaction that then
rolls back, must not run. Rolling back the outer transaction discards the whole
list, savepoint entries included.

The inverse — a savepoint that rolls back while the outer transaction commits —
is the case the shared array gets wrong, and it needs handling: entries added
inside a savepoint that is rolled back must be dropped. Record the depth
alongside each callback and truncate on savepoint failure.

**2. `withTransaction` drains the list on commit.**

Only in the outermost branch, after `begin` resolves — never in the savepoint
branch, which has not committed anything durable. On rejection, the scope is
discarded and nothing runs.

Draining happens **outside** the transaction scope, deliberately: a listener
that runs after commit must not join the transaction that just closed, and
`ormContext.run` with a scope carrying no `tx` is how to guarantee it. A
listener that opens its own transaction then does so cleanly.

A throwing callback must not turn a committed transaction into a rejected one —
the transaction succeeded, and reporting otherwise would have the caller roll
back work the database has already kept. Catch, log, continue, exactly as
invariant 3 requires within a single dispatch.

**3. `Event` gains `static afterCommit = false`.**

`EventManager.dispatch` checks `currentTransaction()`. Three cases:

| `afterCommit` | in a transaction | behaviour |
| --- | --- | --- |
| `false` | either | dispatch now — unchanged from iterations 1 and 2 |
| `true` | no | dispatch now; there is nothing to wait for |
| `true` | yes | queue the dispatch on the scope, drain on commit |

`dispatchAndWait` on a deferred event resolves **immediately**, having run
nothing. That is a genuinely sharp edge and the reason this ships opt-in: the
two features compose into something that does not do what either name suggests.
The doc comment on `afterCommit` says so, and the pairing warns in development.

**4. Opt-in, not default.**

Defaulting it on would mean a `dispatch` inside a transaction silently does not
happen yet — turning a fire-and-forget call into a deferred one based on ambient
state the call site cannot see. That is a different surprise of the same size as
the one being fixed, and it is the one that is harder to debug because nothing
went wrong. Revisit for a major once there is usage to look at.

### Tests

- Commit runs the deferred listeners; rollback runs nothing.
- A deferred dispatch inside a savepoint runs when the **outer** transaction
  commits, not when the savepoint does.
- A savepoint that rolls back inside a transaction that commits: the dispatch
  made inside the savepoint does not run; one made before it does.
- Callbacks run outside the transaction — `currentTransaction()` is `undefined`
  inside a deferred listener.
- A throwing callback does not reject the transaction, and the next callback
  runs.
- Two concurrent transactions do not see each other's deferred dispatches. This
  is the existing `context.test.ts` property extended to the new field, and it
  is the one an implementation on a module-level array gets wrong.
- `afterCommit` with no transaction open dispatches immediately.

---

## Part two — testing

### `Event.fake()`

```typescript
// sketch
const events = Event.fake();

await post("/register", { email: "a@b.c" });

events.assertDispatched(UserRegistered);
events.assertDispatched(UserRegistered, (e) => e.email === "a@b.c");
events.assertNotDispatched(WelcomeBackEmail);
events.assertNothingDispatched();
```

A fake swaps the container binding for a recording `EventManager` that registers
no listeners and runs nothing. The point is the second line of the sketch: a
controller test asserting *that the event fired* is testing the controller, and
a controller test asserting *that a welcome email was sent* is testing three
things and will break when the fourth listener is added. Events are worth having
mostly because they make that separation possible, and a fake is what makes it
convenient.

The predicate form takes the event instance and is typed off the class passed
in — the same `InstanceType<T>` inference `Listener()` uses.

### Deliverables

- A `FakeEventManager` extending `EventManager`, overriding `dispatch` /
  `dispatchAndWait` to record and return.
- `Event.fake()` binds it, returns it, and returns the *same* instance on a
  second call within a test so `Event.fake()` in a helper and in the test body
  do not disagree.
- Restoration. Whatever `testing/` already does for teardown; if there is no
  hook, the returned object gets a `restore()` and the docs show it in
  `afterEach`. A fake that outlives its test is a subsequent test whose
  listeners silently never run — the same silence as invariant 2 and with no
  warning to catch it, since a fake legitimately has no listeners.
- `assertDispatched`, `assertNotDispatched`, `assertDispatchedTimes`,
  `assertNothingDispatched`. Failure messages name what *was* dispatched — the
  common failure is an event fired with a different payload than expected, and
  "expected UserRegistered, dispatched: UserRegistered(2, 'b@c.d')" ends the
  investigation on the spot.
- Exported from `gemi/testing`, not `gemi/services` — it is test-only, and
  `barrel-imports.test.ts` is about not making every app pay for things it does
  not use.

### The interaction worth testing

A fake and a **queued** listener. Nothing should reach `QueueManager`: a faked
dispatch records and stops. Without this, a controller test with a fake still
enqueues real work, which runs against a test database after the assertions have
passed.

## Out of scope

`Event.fakeExcept()` / partial fakes, snapshotting dispatched events, and any
assertion about *listeners* having run. The last is the one that will be asked
for and is worth declining: a test that asserts a listener ran is a test of the
listener, and it can call `new SendWelcomeEmail().handle(new UserRegistered(…))`
directly with no framework involvement at all.
