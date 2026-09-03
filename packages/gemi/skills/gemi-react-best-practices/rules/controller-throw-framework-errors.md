---
title: Throw the Framework's Errors, Do Not Invent a Response Shape
impact: HIGH
impactDescription: clients already handle these; a custom shape they do not
tags: controller, errors, validation, client-contract
---

## Throw the Framework's Errors, Do Not Invent a Response Shape

The client's mutation hooks and `<Form>` branch on a tagged error object —
`validation_error`, `form_error`, `server_error`, `not_authorized`,
`insufficient_permissions`. Returning an ad-hoc `{ error: "…" }` from a controller
produces a **200 with a body the client reads as success**, so the UI shows nothing
and the failure disappears.

| Throw | Meaning |
|---|---|
| `ValidationError({ field: ["msg"] })` | 400, per-field messages `<ValidationErrors>` renders |
| `AuthenticationError` | 401 — no identity (views redirect to sign-in) |
| `AuthorizationError("msg")` | 401 — known identity, refused this action |
| `InsufficientPermissionsError` | 401 — missing a role or permission |

**Incorrect (a 200 that the client cannot distinguish from success):**

```ts
async update(req: HttpRequest) {
  const post = await Post.findUniqueOrThrow({ where: { publicId } });
  if (post.authorId !== user.id) {
    return { error: "You cannot edit this post", status: 403 };
  }
}
```

**Correct:**

```ts
import { AuthorizationError, ValidationError } from "gemi/http";

async update(req: HttpRequest) {
  const post = await Post.findUniqueOrThrow({ where: { publicId } });
  if (post.authorId !== user.id) {
    throw new AuthorizationError("You cannot edit this post");
  }
  if (!slug) {
    throw new ValidationError({ slug: ["Slug is required"] });
  }
}
```

**`ValidationError` already yields the right status and body** — do not wrap it, and
do not build a parallel error convention per endpoint.

**Do not construct a `Response` by hand** to set a status, header or redirect. The
facades cover it: `Redirect.to(...)`, `Cookie.set(...)`, `Meta.title(...)`. A handler
returns plain data and the framework serializes it.

Reference: <https://nstfkc.github.io/gemi/controllers.md>
