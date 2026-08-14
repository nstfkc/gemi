# Feature Flags

A feature flag in gemi is **declared in code and controlled from the database**. You write the flag's key, its value type and its default in `app/features`; whether it is on, and who it is on for, lives in a `FeatureFlag` row you can change without a deploy.

Flags are evaluated **on the server**, once per request, and the answers ride the page payload the server was already sending. The browser never fetches them — so a flag cannot cause a flash of the wrong variant, and your targeting rules never leave the server.

```typescript
// app/features/index.ts
import { FeatureRouter } from "gemi/http";

export default class extends FeatureRouter {
  features = {
    "new-checkout": this.boolean(false).describe("Rebuilt checkout flow"),
    "pricing-page": this.variant(["a", "b", "control"], "control"),
    "seat-limit": this.number(5),
  };
}
```

```tsx
import { useFeature } from "gemi/client";

export default function Pricing() {
  const variant = useFeature("pricing-page"); // "a" | "b" | "control"
  return variant === "a" ? <PricingA /> : <PricingControl />;
}
```

```typescript
import { Features } from "gemi/facades";

if (await Features.enabled("new-checkout")) {
  // ...
}
```

Keys are typed from your declarations, so `useFeature("pricign-page")` is a compile error rather than a flag that silently reads as off.

## Why the split

The database cannot type anything — TypeScript has never seen your rows. So the parts that need to be typed (the key, the value type) live in code, and the parts that need to change at 2am (on/off, targeting) live in a row.

The practical consequence: **adding a flag is a deploy, flipping one is not.**

## Setup

### 1. Add the model

```prisma
model FeatureFlag {
  id       Int    @id @default(autoincrement())
  publicId String @unique @default(cuid())

  key         String  @unique
  description String?
  enabled     Boolean @default(false)

  offValue     Json?
  defaultValue Json?
  rules        Json?

  seed     String  @default(cuid())
  bucketBy String?

  archivedAt DateTime?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  @@index([archivedAt])
}
```

Then `bunx prisma migrate dev`, `bunx prisma generate`, and export the subclass from your models barrel:

```typescript
// app/models/FeatureFlag.ts
import { FeatureFlagModel } from "./generated";
export class FeatureFlag extends FeatureFlagModel {}
```

```typescript
// app/models/index.ts
export { FeatureFlag } from "./FeatureFlag";
```

Do **not** put a tenant policy on this model. The flag store loads the whole table from a background refresh, outside any request and with no user; a `scope` would make that load return nothing. The evaluator is what decides who a flag applies to.

### 2. Declare your flags

`app/features/index.ts`, as above. Five factories are available:

| Factory | Value type |
| --- | --- |
| `this.boolean(default?)` | `boolean` |
| `this.number(default)` | `number` |
| `this.string(default)` | `string` |
| `this.variant([...values], default)` | the literal union of `values` |

Two modifiers, both chainable: `.describe(text)` and `.serverOnly()`.

Flags namespace like routers do:

```typescript
class BillingFeatures extends FeatureRouter {
  features = { "new-invoice": this.boolean(false) };
}

export default class extends FeatureRouter {
  features = { "billing/": BillingFeatures }; // -> "billing/new-invoice"
}
```

> **Never annotate `features`.** Write `features = { ... }`, not `features: FeatureDefinitions = { ... }`. The annotation widens the literal keys, inference collapses, and every flag key silently becomes an untyped `string`. Nothing errors. `ViewRouter.routes` has the same property for the same reason.

### 3. Wire the config

```typescript
// app/config/features.ts
import { defineFeaturesConfig } from "gemi/services";
import AppFeatures from "@/app/features";

export default defineFeaturesConfig({ router: AppFeatures });
```

Add `features` to your Kernel's `config` object. That is the whole setup — an empty `FeatureFlag` table is a working state, and every flag resolves to its declared default until you add rows.

## Turning a flag on

```sql
insert into "FeatureFlag" (key, enabled, "defaultValue", seed, "updatedAt")
values ('new-checkout', true, 'true', 'anything-stable', now());
```

- **`enabled`** is the kill switch. `false` short-circuits every rule — nothing in `rules` can turn a disabled flag back on. That is the point: turning something off during an incident is one column, and no rule anybody forgot about can defeat it.
- **`offValue`** is served when `enabled` is false.
- **`defaultValue`** is served when the flag is on and no rule matched.

Both value columns fall back to the declared default when null, so you only set them when you want something other than what the code says.

Keeping them separate matters for multivariate flags: `offValue` answers "what does the app do when this is killed", `defaultValue` answers "what does an untargeted user see". Collapsing them would make killing an experiment serve the control arm rather than the pre-experiment behaviour.

## Rules

`rules` is an ordered array. The first rule that matches wins, and its value is served.

```json
[
  {
    "id": "enterprise-early-access",
    "conditions": [{ "attribute": "plan", "operator": "eq", "value": "enterprise" }],
    "value": true
  },
  { "id": "gradual", "rollout": 10, "value": true }
]
```

A rule matches when **all** of its segments hold, **all** of its conditions hold, and its rollout bucket passes. A rule that does not match falls through to the next one — so the example above reads exactly as it looks: enterprise accounts get it, then 10% of everyone else.

There is no `OR`. Two rules serving the same value express it, which keeps each rule independently readable.

### Conditions

`attribute` is a dot path. Paths starting with `user`, `attributes`, `request`, `anonymousId` or `now` resolve against the evaluation context; anything else resolves against your attributes, so `plan` and `attributes.plan` are the same thing. Array indices work: `user.accounts.0.organizationRole`.

| Operator | Holds when |
| --- | --- |
| `eq`, `neq` | strictly equal / not equal |
| `in`, `nin` | the value is in the given array (an array attribute intersects it) |
| `contains`, `ncontains` | string substring, or array membership |
| `startsWith`, `endsWith` | string prefix / suffix |
| `gt`, `gte`, `lt`, `lte` | both sides are finite numbers and compare |
| `before`, `after` | both sides parse as dates and compare |
| `exists`, `nexists` | the attribute is (not) null or undefined |

Every comparison is strict. A rule targeting `seats > 10` does not match a user whose `seats` is the string `"12"` — no coercion, and no error either.

There is deliberately **no regex operator**. A pattern edited in an admin UI and run against user input on the render path is a denial-of-service surface that `startsWith` and `in` already cover.

### Segments

Reusable condition sets, declared in config because "who counts as an enterprise account" is business logic worth reviewing:

```typescript
export default defineFeaturesConfig({
  router: AppFeatures,
  segments: {
    internal: [{ attribute: "user.email", operator: "endsWith", value: "@example.com" }],
  },
});
```

```json
[{ "id": "internal-only", "segments": ["internal"], "value": true }]
```

A rule naming a segment that no longer exists does **not** become a catch-all — it simply never matches. Deleting a segment must not widen every rule that used it to your whole audience.

### Attributes

Anything else you want to target on:

```typescript
export default defineFeaturesConfig({
  router: AppFeatures,
  context: (req) => ({ plan: currentPlan(req), country: geoOf(req) }),
});
```

This runs on every request inside the render path, so keep it cheap and free of I/O. If it throws, evaluation degrades to no attributes rather than failing the page.

## Percentage rollouts

`rollout` is a number from 0 to 100. Assignment is deterministic: the same user gets the same answer on every request, on every server, across deploys.

```json
[{ "id": "ramp", "rollout": 25, "value": true }]
```

**Raising a rollout only ever adds people.** Someone in the 10% is still in the 20%, so ramping up never takes the feature away from a user who already had it, and never invalidates a measurement taken across the change.

By default users are bucketed on `user.publicId`, falling back to the `session_id` cookie for signed-out visitors. Bucket on something else with `bucketBy`, on the flag or on a single rule:

```json
[{ "id": "by-org", "rollout": 50, "bucketBy": "attributes.orgId", "value": true }]
```

That rolls out by organisation, so everyone in a company sees the same thing.

### What changes an assignment

Assignment is a hash of the flag key, the row's `seed`, the rule's `id` and the subject. So it is stable across servers and deploys, and two independent 50% flags select *different* halves rather than the same one.

Four things re-bucket everybody, all of them deliberate:

- changing `seed` — this is how you intentionally re-randomise a flag
- changing `bucketBy`
- renaming the flag key
- a rule losing or changing its `id`

Give every rule with a `rollout` a stable `id`. Without one it falls back to its array position, and inserting a rule above it silently reshuffles the audience — gemi logs a warning when it sees this.

## Variants

For splitting traffic across a closed set:

```json
[
  {
    "id": "experiment",
    "variants": [
      { "value": "a", "weight": 50 },
      { "value": "b", "weight": 50 }
    ]
  }
]
```

Weights are relative, so `1`/`1` and `50`/`50` mean the same thing. A variant whose value is not in the declared set causes the **whole rule** to be skipped — dropping just the bad arm would silently redistribute its share and change the experiment for everyone.

Declare the set with `variant()` and your `switch` is exhaustively checked:

```tsx
switch (useFeature("pricing-page")) {
  case "a": return <A />;
  case "b": return <B />;
  case "control": return <Control />;
}
```

## On the server

```typescript
import { Features } from "gemi/facades";
```

| Member | Does |
| --- | --- |
| `Features.enabled(key)` | `true` unless the value is `false`, `null` or `undefined` |
| `Features.value(key)` | the resolved value, typed by the declaration |
| `Features.all()` | every client-visible flag as `key -> value` |
| `Features.explain(key)` | value plus the rule that produced it — **server-side only** |
| `Features.for(subject)` | evaluation against an explicit subject |
| `Features.refresh()` | reload this process's snapshot now |

Everything is async. After the boot-time warm-up there is no I/O and calls settle in a microtask, but the first call in a cold process does hit the database — a sync API would have to answer that window with the default, which is a flag silently reading "off" while a deploy rolls.

The user comes from the request context, not `Auth.user()`, so flags are evaluable on an anonymous page without throwing. On a route with no `auth` middleware, where nothing has resolved a session, user-targeted rules will not match.

In a job, a cron tick or a console command there is no request, so bare calls evaluate anonymously. Name the subject explicitly instead:

```typescript
if (await Features.for({ user }).enabled("digest-v2")) { ... }
await Features.for({ subjectId: organization.publicId }).value("seat-limit");
```

## On the client

```typescript
import { useFeature, useFeatures } from "gemi/client";
```

`useFeature(key)` returns the value the server already evaluated. It is a context read — no request, no suspense, no loading state. `useFeatures()` returns the whole map.

Values refresh on every navigation, because each navigation is a server request that re-evaluates them. A flag flipped in the database reaches an open page on its next navigation, not instantly.

An unknown key returns `false` and warns in development; it never throws, so a flag removed from your declarations cannot white-screen a page.

## Gating routes

```typescript
class AppRouter extends ViewRouter {
  routes = {
    "/beta": this.view("Beta").feature("beta-area"),
  };
}
```

When the flag is off the route renders your application's own `404` view with a 404 status, rather than an error page that confirms something is there. Gates accumulate: a router's, then a layout's, then the route's, and all must pass.

Gating runs after middleware, so a flag targeting signed-in users works if `auth` is in the chain.

**This gates the response, not the route's existence.** The path and view name are still in the route manifest the browser receives, so a `<Link>` to a gated route renders and only 404s when followed. If the route's *name* is the secret, that is not enough on its own.

## Configuration

`app/config/features.ts`:

| Option | Default | Does |
| --- | --- | --- |
| `router` | — | your `app/features` class. Required for flags to do anything |
| `enabled` | `true` | `false` serves every declared default and issues no queries |
| `source` | database | where rows come from |
| `model` | `"FeatureFlag"` | the ORM registry name of the model |
| `ttl` | `30` | snapshot lifetime, in seconds |
| `bucketBy` | `"user.publicId"` | default bucketing attribute |
| `segments` | `{}` | reusable condition sets |
| `context` | — | extra attributes per request |
| `onEvaluate` | — | fires once per flag per request, for exposure logging |
| `maxClientFlags` | `200` | warn above this many flags in the payload |

## Caching and staleness

Flags are cached per process and refreshed in the background, so no request ever waits on the database for a flag. After the first load, a read returns immediately and the refresh happens behind it.

**`ttl` is your propagation delay, plus one request.** Because the refresh happens *behind* a request rather than blocking it, the first request after the TTL expires still serves the old values and triggers the reload; the next one sees the new values. On a busy instance that gap is milliseconds. On an idle one, nothing changes until something asks — a flag flipped against an instance receiving no traffic is still stale when the next visitor arrives, and then correct on their second page.

There is no cross-instance invalidation, so if that is too slow during an incident, lower `ttl`; the cost is one query per instance per window. `Features.refresh()` bypasses it entirely for the process that calls it.

A failed refresh keeps the last good data rather than reverting every flag to its default, which would be a config change nobody made, applied to production, at the moment something else is already broken.

## Security

Only evaluated `key -> value` pairs reach the browser. Never sent: your rules, conditions, segment criteria, the bucketing `seed`, the off/default values, or which rule matched.

The seed matters most — with it and a user id, anyone could compute another user's bucket for every flag, including unreleased ones.

Two things to keep in mind:

**Flag keys are public.** Every client-visible key appears in the HTML of every page, so a flag named for an unannounced feature announces it. Use `.serverOnly()` for anything where the name is the secret:

```typescript
"acquisition-banner": this.boolean(false).serverOnly(),
```

A server-only flag is still evaluated and still readable through `Features.enabled()`; it just never enters the payload, and `useFeature` cannot see it.

**Flags are not authorization.** A client-visible flag is a hint. Anything that must not happen is enforced by a policy or middleware — `Features.enabled()` in a controller is the server-side half of that, not a substitute for it.

## Testing

`StaticFeatureFlagSource` replaces the database with a plain object:

```typescript
import { defineFeaturesConfig } from "gemi/services";
import { StaticFeatureFlagSource } from "gemi/services";

export default defineFeaturesConfig({
  router: AppFeatures,
  source: new StaticFeatureFlagSource({
    "new-checkout": true,
    "pricing-page": {
      defaultValue: "control",
      rules: [{ id: "r", rollout: 50, value: "a" }],
    },
  }),
});
```

A bare value means "on, serving this". The rows go through the same normalization and the same evaluator the database source feeds, so a test written against it exercises rule precedence, bucketing and the kill switch for real.

## Failure modes, and what happens

| Situation | Behaviour |
| --- | --- |
| No `FeatureFlag` model registered | every flag resolves to its declared default; logged once |
| Database unreachable | last good snapshot is kept; declared defaults if nothing ever loaded |
| Row for a key you never declared | ignored with a warning — there is no default to evaluate it against |
| Malformed `rules` JSON | that rule is skipped and logged; the flag still resolves |
| Rule with an unknown operator | the whole rule is skipped, never partially applied |
| Variant weights that sum to zero | the flag's default is served, reported as `reason: "error"` |

The rule throughout is to drop the smallest broken thing and keep serving — except where dropping would *widen* a flag's audience, in which case the whole rule goes.

## Related

- [Services](./services.md) — the container and configuration this plugs into
- [Authorization](./authorization.md) — for the things flags are not
- [ORM](./orm.md) — the model and migration workflow
