---
title: Never Wrap the Redirect Facade in try/catch
impact: HIGH
impactDescription: silently breaks the redirect
tags: controller, redirect, facades, gotcha
---

## Never Wrap the Redirect Facade in try/catch

`Redirect` from `gemi/facades` works by **throwing** a special error that the
framework catches higher up to perform the redirect. A `try/catch` around it — or a
broad `catch` anywhere up the call stack — swallows that throw, and the redirect
silently does nothing. Nothing logs; the handler just continues.

Code after a `Redirect.to()` call is unreachable.

**Incorrect (the catch eats the redirect):**

```ts
async view(req: HttpRequest) {
  try {
    const store = await Store.findUnique({ where: { slug } });
    if (!store) {
      Redirect.to("/stores");     // throws…
    }
    return { store };
  } catch (error) {                // …and this swallows it
    Log.error("store view failed", { error });
    return { store: null };
  }
}
```

**Correct (redirect outside the guarded region):**

```ts
async view(req: HttpRequest) {
  let store = null;
  try {
    store = await Store.findUnique({ where: { slug } });
  } catch (error) {
    Log.error("store lookup failed", { error });
  }

  if (!store) {
    Redirect.to("/stores");
  }

  return { store };
}
```

**Two Redirects, and they are not interchangeable:**

- **Facade** (`gemi/facades`) — server-side, in a handler or middleware, *before*
  rendering. `Redirect.to(path, { params, search })` for internal routes,
  `Redirect.external(url, status)` for absolute ones.
- **Component** (`gemi/client`) — client-side, redirects on mount from client state:
  `if (!user) return <Redirect href="/auth/sign-in" action="replace" />;`

Prefer the facade when the decision is knowable on the server: the component ships
and renders a page first, then navigates.

`Auth.user()` throws `AuthenticationError` the same way, so the same rule applies to
it — do not bury an auth check inside a `try/catch`.

Reference: `app/utils/storefrontRedirect.ts`
<https://nstfkc.github.io/gemi/navigation.md>
