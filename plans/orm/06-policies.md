# Iteration 6 — Policies

**Goal.** Per-model policies that can deny an operation, scope its `where`, or
redact fields — applied to **every** query including nested relation reads.

The second of the two features that justify the project. Prisma's query
extensions do not fire on nested reads, so a scope written for `Account` is
bypassed by `User.findMany({ include: { accounts: true } })`. Because iteration 3
routed every relation read through `Model.$exec` on the related model's class,
ours does not have that hole — and that is a correctness story, not an
ergonomics one.

This is also the feature the commented-out `packages/gemi/app/prismaExtension.ts`
was reaching for and could not express: an extension can allow or deny, but it
cannot rewrite the query.

Read [README.md](./README.md) first.

## Prerequisite state

Iterations 1–5 are merged. Every query, nested or not, goes through `$exec`;
transactions are ambient.

## Read first

- `packages/gemi/app/prismaExtension.ts` — the stubbed policy hook and its
  commented-out `policiesServiceProvider` lookup. Worth understanding what was
  intended before designing the replacement.
- `docs/authorization.md` — the existing authorization story. Policies here must
  not contradict or duplicate it; ideally they compose.
- `packages/gemi/orm/Model.ts` — `$exec`, where the hook lands.
- `packages/gemi/orm/plan.ts` — the plan key, which interacts with policies in a
  way that is easy to get subtly wrong (§4).

## Deliverables

### 1. Where the current user comes from

Settle this first; the hook signature depends on it. If `KernelContext` already
carries the authenticated user, the hook reads it and policies stay
dependency-free. If not, that plumbing is part of this iteration.

Also decide what happens with **no** user: a cron tick, a queue worker, a
migration script. Options are deny-by-default (safe, noisy) or an explicit
system/unscoped mode that bypasses policies. Whichever is chosen, unscoped access
must be **explicit at the call site** — never the accidental result of a missing
user.

### 2. The policy hook

Attached to the model class, inherited through the prototype chain so a
`TenantModel` base can contribute to every subclass:

```ts
// sketch
export class Account extends AccountModel {
  static $policy = {
    // deny outright
    before(ctx) { if (!ctx.user) throw new ForbiddenError(); },
    // rewrite the arg tree — this is the part extensions cannot do
    scope(ctx, args) {
      return and(args, { organizationId: ctx.user.organizationId });
    },
    // post-fetch field removal
    redact(ctx, row) { ... },
  };
}
```

`scope` receives and returns **plain args**, before compilation (invariant 2).
It is an `AND` into `args.where`, not SQL manipulation. That is what makes it
work identically under every relation strategy — including iteration 7's lateral
joins, where the scoped `where` simply lands inside the subquery.

Dispatch must walk the prototype chain and apply base-class policies as well as
the model's own, in a defined order. Write the order down.

### 3. Nested reads

The headline. A relation read is `$exec` on the related model, so the related
model's policy applies automatically. What this iteration must do is **prove** it
and keep it proven:

```ts
// Account is scoped to the current organization.
// This must NOT return accounts from other organizations.
await User.findMany({ include: { accounts: true } });
```

That test is the single most important artifact of this iteration. It is the
behaviour Prisma gets wrong and the reason to have built any of this.

### 4. Policies and the plan cache — read carefully

Policies rewrite args, so they change the SQL. **Policy application must happen
before the plan key is computed**, or two users' differently-scoped queries share
one plan and one of them gets the other's SQL. That is a cross-tenant data leak
produced by a caching bug.

Two consequences:

- The pipeline order in `$exec` is `policies → plan key → compile`, exactly as
  documented in the README. Do not reorder for a perceived cache-hit win.
- A scope that injects a *value* (the org id) keeps the same **shape** for every
  user, so the plan is still shared and the value binds per call. That is the
  desired outcome and it is worth an explicit test: same shape, different bound
  values, no leak.
- A scope whose *shape* varies by user (an admin getting no scope at all) must
  produce a different plan key. Also worth a test.

### 5. Writes

`create`, `update`, `delete` and their `Many` variants need policy coverage too,
and the semantics differ: scoping a `deleteMany` means restricting which rows are
affected; scoping a `create` means validating or defaulting the tenant column.
Define what `scope` means per operation rather than assuming the read semantics
generalise.

### 6. Redaction

Post-fetch field removal in the shaping stage. Note that this is the one policy
capability that **breaks the differential harness** — gemi's result deliberately
differs from Prisma's. Assert differential equality against the pre-redaction
payload, as the README's testing section requires.

Redaction also has a type-honesty problem: the type says the field is there and
the value is gone. Consider limiting redaction to nullable fields, or documenting
it as a runtime-only guarantee. Do not leave it unaddressed.

### 7. Soft deletes, as the proof case

`User` and `Account` both carry `deletedAt`. A soft-delete base class that scopes
every read with `deletedAt: null` and turns `delete` into an `update` is the
natural demonstration that the hook is expressive enough. Ship it as a small
built-in, or at minimum as a documented recipe with a test.

## Acceptance criteria

1. Deny, scope and redact all work on a root query.
2. **Scope applies to nested relation reads** — the `include` test above passes.
3. Base-class policies apply to subclasses, in a documented order.
4. Policy application happens before plan-key computation; a test proves two
   users with the same query shape and different scope values do not share bound
   parameters, and a test proves differently-*shaped* scopes get different plans.
5. Write operations are policy-covered, with per-operation semantics documented.
6. Redaction is applied in shaping; differential assertions run against the
   pre-redaction payload.
7. Unscoped / system access requires an explicit call-site opt-in and is tested.
8. Soft-delete recipe or built-in, with tests.
9. `bun run lint` and `bun run test` pass.

## Out of scope

Field-level *write* permissions, row-level security delegated to the database,
policy caching or memoisation (measure in iteration 7 before optimising), a
policy DSL. Keep policies as plain functions for now.

## Notes and risks

- **This iteration can produce a cross-tenant data leak** if the plan-cache
  ordering in §4 is wrong. It deserves more review attention than any other
  iteration, and the tests in acceptance criterion 4 should be written before the
  implementation rather than after.
- **Policies run on every query, including every nested read.** Keep the hook
  cheap and avoid async work in `scope` if at all possible; an `await` per
  relation node per query is a real cost. If async is unavoidable, say so and
  measure it in iteration 7.
- **Do not let policies see SQL.** The moment a policy can manipulate compiled
  text, invariant 2 is dead, the plan cache becomes unsound, and the relation
  strategies stop being interchangeable. Args in, args out.

## Residual: an unregistered policied subclass, read only through includes

**Recorded here because until now it lived only in a PR review thread.** It is a
cross-tenant read path with no home in the durable record, which is the worst
place for one to sit.

`Model.$exec` raises `UnregisteredPolicyClassError` when a class carrying
policies is queried while a different class owns its name. That closed the two
shapes found in #51's review. Its condition begins `registered !== this`, and
there is a third shape where that is false:

```ts
export class Membership extends MembershipModel {
  static $policy = { scope: (ctx) => ({ orgId: ctx.user.orgId }) }
}
// ...and no register("Membership", Membership)
```

If nothing ever queries `Membership` **at its root** — because memberships are
only read through `include: { memberships: true }` — the include resolves the
name to the generated base, `this` *is* that base, and the comparison is never
reached. Rows come back unscoped, with no error. Reproduced during #51's review:
two organisations' accounts returned to a caller scoped to one.

The residual runs the wrong way. A model reached only through includes is
usually a membership or a pivot, which is exactly the kind that carries a tenant
scope, so the guard is weakest where the data is most sensitive.

**Partly closed** by `assertPoliciesRegistered(...modules)` — the same divergence
comparison, applied to the classes in a module namespace rather than to the class
of a query, so an unqueried class is still visible. Run it in a test or at boot.
It is not a full closure and must not be described as one: it can only see
modules it is handed.

**Full closure needs the registration to stop being something an author writes.**
The generator emits `register(...)` for the classes it generates; it cannot emit
one for a subclass in application code it never sees. Options, none built:

- Have the generator emit an application-side barrel that re-exports and
  registers every `app/models/*.ts` subclass it finds. Codegen reading
  application source is a new kind of coupling and wants its own decision.
- Register on first *definition* rather than on first import. There is no hook:
  `static $policy = …` in a subclass body is a [[Define]] on the subclass, so a
  setter on the base is bypassed.
- Make `$policy` a method call — `static $policy = policy(Membership, {…})` —
  so declaring one registers it. Changes the documented shape of every policy,
  and the `docs/authorization.md` examples with it.

