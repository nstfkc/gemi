---
title: Do Not Build Structure the Framework Already Has
impact: HIGH
impactDescription: a parallel structure is one the framework's own tooling cannot see
tags: structure, container, services, conventions
---

## Do Not Build Structure the Framework Already Has

The reflex when a codebase needs somewhere to put shared code is to add `lib/`,
`utils/`, or a hand-rolled registry. In a gemi app most of those already exist
with a name, and the cost of the parallel one is not duplication — it is that the
framework's own machinery cannot see it.

| The reflex | What gemi already has |
|---|---|
| A `lib/` of shared classes with I/O | `app/services/`, classes extending `Service`, resolved from the container |
| A module-scope singleton client | A `Service` with a `static token`, injected where needed |
| A hand-rolled service locator or DI map | The container; `app/providers/` binds into it |
| A custom router, or routing by file path | Router classes under `app/http/routes/` |
| Ad-hoc `if (!req.body.name)` checks | An `HttpRequest` subclass under `app/http/requests/` |
| A `constants.ts` of env reads | A config slice under `app/config/` |
| A `scripts/` folder run with `bun x.ts` | `app/commands/`, run by `gemi run` |
| A barrel re-exporting a package's modules | Deep imports — see `bundle-deep-imports` |

**Incorrect (a registry the framework cannot see):**

```ts
// app/lib/services.ts — invented
export const billing = new Billing(process.env.STRIPE_KEY!);
```

Constructed at module scope, so it runs whenever anything imports the file —
including a discovery walk that imports every file in a directory. Nothing can
rebind it in a test, and nothing resolves it by token.

**Correct:**

```ts
// app/services/Billing.ts
export class Billing extends Service {
  static token = "Billing";
  // Constructed lazily by the container, rebindable in a test.
}
```

Two things follow from this that are easy to get backwards:

- **A view's file path is not its URL.** `app/views/` is organised however you
  like; routing is declared on router classes. Moving a view does not change a
  route, and creating one under a path that "looks like" a URL registers nothing.
  See `routing-routers-are-classes`.
- **`app/models/generated/` is output.** Editing it is editing a build artifact —
  the change disappears on the next generate.

When a rule here and an existing pattern in your app disagree, check the app's
`CLAUDE.md` and git history before "fixing" it: the app may have a reason, and
ground rule 2 says the app wins.
