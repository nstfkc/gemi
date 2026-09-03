---
title: Parallelize Independent Work in a Controller
impact: CRITICAL
impactDescription: 2-5x on multi-read endpoints
tags: payload, async, promises, controllers, waterfalls
---

## Parallelize Independent Work in a Controller

Server-side fetching lives in the controller method, not in the component tree, so
there is nothing to restructure in the view — the parallelism is expressed where the
awaits are. Independent awaits belong in a `Promise.all`.

Each sequential `await` on an independent read adds a full database round-trip to
the response.

**Incorrect (three serial round-trips):**

```ts
export class OrganizationController extends Controller {
  async show(req: HttpRequest) {
    const org = await Organization.findUniqueOrThrow({ where: { publicId } });
    const members = await Account.findMany({ where: { organizationId: org.id } });
    const stores = await Store.findMany({ where: { organizationId: org.id } });
    return { org, members, stores };
  }
}
```

**Correct (the dependent read first, then the two independent ones together):**

```ts
export class OrganizationController extends Controller {
  async show(req: HttpRequest) {
    const org = await Organization.findUniqueOrThrow({ where: { publicId } });
    const [members, stores] = await Promise.all([
      Account.findMany({ where: { organizationId: org.id } }),
      Store.findMany({ where: { organizationId: org.id } }),
    ]);
    return { org, members, stores };
  }
}
```

**Two hard exceptions:**

1. **Never `Promise.all` ORM calls inside `Model.transaction`** — see
   `orm-transaction-sequential`. One reserved connection makes it unsafe.
2. **A batch over the analytics pool is bounded**, not unbounded — the admin
   aggregations cap their in-flight count at the pool size so a batch
   cannot queue more work than the pool can serve.

Two habits that compound with this: move an `await` into the branch that actually
uses it, and check cheap synchronous conditions (a param, a flag already in memory)
*before* awaiting anything — an early return costs nothing once the round-trip has
already started.
