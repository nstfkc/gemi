# Features

A feature in gemi is **declared in code and switched on from the database**. You write the key, who it applies to, and how far it has rolled out in `app/features`. The database holds one thing: whether it is switched on at all.

That split is the whole design. **Shipping a feature is a deploy; turning it on is not.** You can merge a feature dark, watch it sit inert in production, and switch it on — or off, during an incident — with an `UPDATE`.

Features are evaluated **on the server**, once per request, and the answers ride the page payload the server was already sending. The browser never fetches them, so a feature cannot cause a flash of the wrong branch, and your targeting never leaves the server.

```typescript
// app/features/index.ts
import { defineFeature } from "gemi/services";

export default {
  "new-checkout": defineFeature({
    describe: "Rebuilt checkout flow",
  }),

  "pricing-redesign": defineFeature({
    rollout: 50,
    when: (ctx) => {
      if (ctx.user?.email.endsWith("@acme.com")) return true; // staff, always
      if (ctx.user?.plan === "free") return false; // never
      // return nothing → the rollout decides
    },
  }),
};
```

```tsx
import { useFeature } from "gemi/client";

export default function Pricing() {
  return useFeature("pricing-redesign") ? <PricingNext /> : <Pricing />;
}
```

```typescript
import { Features } from "gemi/facades";

if (await Features.enabled("new-checkout")) {
  // ...
}
```

Keys are typed from your declarations, so `useFeature("pricing-redesgin")` is a compile error rather than a feature that silently reads as off.

## Every feature is a boolean

`useFeature` returns `true` or `false`. There is no multivariate value, no string, no number.

This is a deliberate floor rather than an oversight. A feature is a thing you turn on; a config value with three settings wants a different lifecycle — versioned, reviewed, deployed — than something you flip at 2am. If you need a three-arm experiment, that is an experimentation system, and it should not be built out of two booleans that can both be true.

## Keys are flat

There is no nesting and no prefix joining. `"billing/new-invoices"` is one key, written exactly as you will look it up.

The reason is grep. The most common thing anyone ever does with a feature is ask "is this still referenced, can I delete it?", and that question should be answerable with a text search. A nested registry breaks it: the key you search for exists nowhere in the source, only as a concatenation at runtime.

## How a feature resolves

In order, stopping at the first that applies:

1. **The store has never loaded** → off. An unreachable database fails closed.
2. **No row, or `active = false`** → off. `when` and `rollout` are not consulted.
3. **`when(ctx)` returned `true` or `false`** → that.
4. **No `rollout`** → on, crawlers included. There is nothing to sample, so every visit already resolves the same way.
5. **A crawler**, on a feature that _has_ a rollout → off.
6. **Inside the rollout bucket** → on, otherwise off.

Two of these are worth dwelling on.

**`active` short-circuits everything.** It is the kill switch, and a kill switch that application code could defeat is not one. Nothing in `when` or `rollout` can turn a switched-off feature back on.

**`when` outranks `rollout`.** A rollout is a statement about strangers; `when` is a statement about someone you can name. Staff overrides and plan exclusions have to beat the dice, or they are not overrides. Returning nothing from `when` is how you say "no opinion about this one" and let the dice decide.

## Rollouts are computed, not stored

A subject's position in a rollout is `sha1(salt:subject)`, reduced to a bucket in `[0, 10000)`. It is on if the bucket is below the threshold.

Nothing is written anywhere. That buys four things:

- **Stability.** The same subject gets the same answer on every device, in every process, forever — with no row, no cookie holding assignments, and nothing to migrate.
- **Monotonicity.** Going 10% → 25% only ever _adds_ people. Nobody who had the feature loses it, because their bucket number never moves; only the threshold does.
- **Independence.** The salt is the feature's key, so two 20% rollouts pick two different 20% slices. Without that, a subject unlucky once would be unlucky in everything.
- **No growth.** One row per feature, not one row per feature per user.

### The subject

The signed-in user (`publicId`, falling back to `id`), or the `session_id` cookie for a logged-out visitor.

Preferring the user is what makes an assignment follow someone between their laptop and their phone. The cost is that **signing up can move a visitor across a rollout boundary**, because the subject changes from the cookie to the account. There is no id that is both stable per person and known before they have an account, so this is a trade rather than a bug — just don't run an experiment that spans registration.

Outside a request — a job, a cron tick — there is no subject and every context shares one bucket. Use `Features.for({ subjectId })` when a background task needs to evaluate as somebody.

### Anonymous visitors

The `session_id` cookie is minted at the top of every view request, before anything is evaluated, so the id used to bucket is the id the browser is about to be given. It is `httpOnly`, `SameSite=Lax`, and lasts a year.

`Lax` rather than `Strict` is load-bearing. `Strict` withholds the cookie on cross-site _top-level navigation_, so a visitor arriving from a search result or a shared link would arrive without it, be minted a new id, and overwrite the old one — re-bucketing on every external entry, which is how most anonymous traffic arrives.

Two operational consequences:

- **A shared cache must never store a response carrying `Set-Cookie: session_id`.** One visitor's id would be handed to everybody, collapsing the whole anonymous population into a single bucket. If you put a CDN in front of view routes, that response needs `Cache-Control: private`.
- **Crawlers are pinned off** for any feature with a rollout. Bots discard cookies, so each crawl would otherwise land in a fresh bucket and index a different branch than the last one. A feature with no rollout is served to bots normally — there is nothing to be inconsistent about.

## Changing a rollout needs a deploy

`rollout` lives in code, so ramping 10% → 50% is a code change and a release. That is the deliberate cost of keeping all the reasoning in reviewed source.

If it becomes painful, the fix is one nullable column on the row overriding the declared value, and nothing else in this design moves.

## Setup

### 1. Add the model

```prisma
model FeatureFlag {
  id       Int    @id @default(autoincrement())
  publicId String @unique @default(cuid())

  key    String  @unique
  active Boolean @default(false)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Export it from `app/models` so the ORM registry can resolve it by name:

```typescript
// app/models/FeatureFlag.ts
import { FeatureFlagModel } from "./generated";
export class FeatureFlag extends FeatureFlagModel {}
```

No tenant policy on this model. These rows are global application configuration, not customer data, and the store loads the whole table from a background refresh with no user attached — a `scope` would make that load return nothing.

### 2. Declare your features

`app/features/index.ts`, default-exporting a plain object. Do not annotate it: a type annotation widens the keys and every one of them silently becomes an untyped `string`.

### 3. Point the config at it

```typescript
// app/config/features.ts
import { defineFeaturesConfig } from "gemi/services";
import AppFeatures from "@/app/features";

export default defineFeaturesConfig({
  features: AppFeatures,
  ttl: 30,
});
```

`ttl` is the propagation delay in seconds — how long a loaded snapshot is reused before the next refresh. It is how long switching something off takes to reach every instance, since there is no cross-instance invalidation. `Features.invalidate()` collapses that window for the process that made the write — see [An admin screen](#an-admin-screen) — but the others still wait out the TTL. Lower it if thirty seconds is too long during an incident; the cost is one query per instance per window.

## Reading a feature

### In a component

```tsx
const on = useFeature("new-checkout");
const all = useFeatures(); // the whole map
```

This is a context read — no request, no suspense, no loading state. The corollary is that switching a feature on reaches an already-open page on its next navigation, not instantly.

### On the server

```typescript
await Features.enabled("new-checkout");
await Features.explain("new-checkout"); // { value, reason } — server only
await Features.all(); // the client-visible map
await Features.for({ user }).enabled("digest-v2");
await Features.list(); // every declared feature and its switch
await Features.refresh(); // reload this process now
await Features.invalidate(); // reload after writing to the table
```

Everything is async. After the boot-time warm-up each call settles in a microtask with no I/O, but the promise is kept because the first call in a cold process does hit the database — and a sync variant would have to answer that window with "off", which is a feature silently vanishing while a deploy rolls.

`explain` is **server-only**. `reason` distinguishes "targeted by name" from "landed in the rollout", which is a fact about the viewer; never serialize it into a response.

## An admin screen

`Features.list()` is the read side. It returns one descriptor per feature the code declares — key, `describe`, `rollout`, `serverOnly`, whether the declaration carries targeting, and the switch:

```typescript
{
  unavailable: false,
  features: [
    { key: "new-checkout", describe: "Rebuilt checkout", rollout: 20, targeted: false, serverOnly: false, salt: undefined, active: true },
    { key: "digest-v2", describe: undefined, rollout: undefined, targeted: true, serverOnly: false, salt: undefined, active: undefined },
  ],
}
```

The declarations are what exists. A feature is on the list because `app/features` declares it, never because a row was inserted — a row for an undeclared key is litter and does not appear. `active: undefined` is **no row**: a feature deployed but never switched on, which is not the same as a row that says `false`, and is the distinction the screen has to show. One is untouched, the other is somebody's decision.

`unavailable` is why the list is not a bare array. It means no snapshot has ever loaded — an unreachable database at boot — so every `active` is _unknown_ rather than absent. Collapsing the two would tell an operator that no feature has ever been switched on, about features that are switched on in the table, at the moment they are most likely to act on it. Render it as an error, and do not offer to flip switches whose current state you do not know.

The `when` function is not on the descriptor and cannot be. It is a function over the viewer, so the only honest answer to "who does this target" is to run it: `targeted` reports that targeting exists, and `Features.for({ user }).explain("new-checkout")` answers it for one subject.

### Gate the route

**`Features.list()` is server-side only, and the route that serves it must be behind admin middleware.** It lists `serverOnly` features — whose keys are exactly what that flag exists to keep out of the payload, as [Hiding a feature's existence](#hiding-a-features-existence) covers — and every descriptor carries `rollout` and `targeted`, which describe who is in an experiment. On an ungated route this hands anybody the unannounced keys and the shape of every rollout.

```typescript
// app/http/routes/api.ts
export default class extends ApiRouter {
  routes = {
    "/admin/features": this.get([AdminFeatureController, "index"]).middleware(["admin"]),
    "/admin/features/:key": this.put([AdminFeatureController, "update"]).middleware(["admin"]),
  };
}
```

```typescript
// app/http/controllers/AdminFeatureController.ts
public async index() {
  return await Features.list();
}
```

### Writing the switch

The write is an ordinary `UPDATE` on your own model — the framework owns no mutation path, because the table is yours. What it does own is the cache in front of it:

```typescript
public async update(
  request: HttpRequest<{ active: boolean }, { key: string }>,
) {
  const input = await request.input();

  await FeatureFlag.update({
    where: { key: request.params.key },
    data: { active: input.get("active") },
  });

  await Features.invalidate();

  return await Features.list();
}
```

`invalidate()` rather than `refresh()`, for two reasons that both amount to "the admin must see their own write". `refresh()` joins whatever load is already in flight, and that load may have queried before the update committed — so the screen could come back saying the switch is still off a moment after flipping it. And `invalidate()` clears the request's evaluation memo, so a feature this request already read is re-evaluated instead of answered from before the write.

**It throws `FeatureReloadError` if the reload fails.** The write landed and the cache did not follow, so the switches in memory may still predate it, and returning normally would present them as the result of the update — worse than never having called it. This is the one call in the subsystem that fails loudly; everywhere else an outage means "keep serving what we have", which is right for evaluation and wrong for an operator watching their own change. Let it surface, or catch it and say the switch was saved but the cache is stale.

It is **process-local**, like `refresh()`. Every other instance is still serving its own snapshot and converges within `ttl`. What this fixes is the one window that reads as a bug — the operator who flips a switch, reloads, and is told for the next thirty seconds that nothing happened.

## Hiding a feature's existence

Feature _keys_ are public — every client-visible key is embedded in the HTML of every page. A key named after an unannounced product announces it.

```typescript
"project-nightingale": defineFeature({ serverOnly: true }),
```

Still evaluated on the server and never in the payload. `useFeature("project-nightingale")` is a compile error — the key is excluded from the client's key type, because the value there could only ever be `false`. Read it with `Features.enabled` instead.

## Gating a route

```typescript
"/beta": this.view("Beta").feature("beta-access"),
```

A gated route renders a real 404 when the feature is off, rather than a 403 — a 403 confirms the route exists, which for an unannounced feature is the thing you were hiding.

The path does stay in the route manifest the browser downloads, so this gates the response, not the route's existence. Pair it with `serverOnly: true` when the name is the secret.

### A rollout is not access control

Gate on `active`, or on a `when` that reads something the visitor cannot choose — the signed-in user, most obviously. Not on a `rollout`.

For an anonymous visitor the bucketing subject is their own `session_id` cookie, and bucketing is a published pure function of it: they can compute a value that lands inside any percentage and send it. Signing the cookie would not close this. They could equally well throw it away and ask for a fresh one until a signed id happens to land inside — a couple of dozen requests for a 5% rollout. Nothing that hands out identities on demand can restrict anything to a fraction of them.

A rollout answers "how many people should see this yet". Use `when` for "who is allowed to".

## Extra context for targeting

```typescript
// app/config/features.ts
export default defineFeaturesConfig({
  features: AppFeatures,
  context: (req) => ({ country: req?.headers.get("cf-ipcountry") }),
});
```

Readable in any `when` as `ctx.attributes.country`. This runs on every request inside the render path, so keep it cheap and free of I/O. If it throws, evaluation degrades to no attributes rather than failing the page.

`when` itself is synchronous for the same reason — an `async` signature is an invitation to put a query on the render path, where every page load would pay for every declared feature.

## Recording exposures

```typescript
onEvaluate: (key, evaluation) => analytics.track("feature", { key, on: evaluation.value }),
```

Fires once per key per request. Errors are caught and logged — an analytics hook must not break the render it observes.

## Testing

```typescript
import { StaticFeatureFlagSource } from "gemi/services";

defineFeaturesConfig({
  features: AppFeatures,
  source: new StaticFeatureFlagSource({ "new-checkout": true }),
});
```

This replaces the _switch_, not the answer: rows still go through the same store and the same evaluator production runs, so a test that turns a feature on still exercises its `when` and its `rollout`. Pinning the final value instead would assert about a code path that never runs.

## Operating

**An empty table is a working state.** Every feature is off until somebody turns it on, which is exactly what you want for a feature you just deployed.

**A row for a key nobody declares is ignored with a warning.** That is usually a feature deleted from the code and left in the table — harmless, and the warning is how you find the litter.

**A failed refresh keeps the last good snapshot.** An outage must not read as "every feature switched itself off"; that would be a config change nobody made, applied to production, at the moment something else is already broken. Only a cold process that has _never_ loaded fails closed.

### Failure modes

| Situation                                    | Behaviour                                         |
| -------------------------------------------- | ------------------------------------------------- |
| No `FeatureFlag` model registered            | every feature stays off; logged once              |
| Database unreachable, snapshot loaded before | last good snapshot is kept                        |
| Database unreachable, never loaded           | every feature off, `reason: "unavailable"`        |
| Row for a key you never declared             | ignored with a warning                            |
| Row with a non-boolean `active`              | read as off                                       |
| `Features.invalidate()` cannot reload        | throws `FeatureReloadError`; switches unchanged   |
| A `when` that throws                         | the feature reads off, logged once per evaluation |

## Related

- [Services](./services.md) — the container and configuration this plugs into
- [Authorization](./authorization.md) — for the things features are not
- [ORM](./orm.md) — the model and migration workflow
- [Testing Views](./testing.md) — `<Page features={{ ... }}>`, for a component test that branches on one
