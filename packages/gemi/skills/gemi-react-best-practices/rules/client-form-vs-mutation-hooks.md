---
title: Reach for Form First, Mutation Hooks When You Need Control
impact: MEDIUM
impactDescription: CSRF, FormData and field errors for free
tags: client, forms, mutations, validation
---

## Reach for Form First, Mutation Hooks When You Need Control

`<Form>` wraps a native form and handles what is otherwise hand-written every time:
collecting fields into `FormData`, attaching the CSRF token, tracking pending state,
and exposing the server's per-field `validation_error` messages through context.

**Incorrect (re-implementing all of it, and losing field errors):**

```tsx
const { trigger, loading } = usePost("/admin/user");
const [name, setName] = useState("");
const [errors, setErrors] = useState({});

async function onSubmit(e) {
  e.preventDefault();
  const res = await trigger({ name });
  if (res?.error?.kind === "validation_error") setErrors(res.error.messages);
}
```

**Correct:**

```tsx
import { Form, ValidationErrors } from "gemi/client";

<Form action="/admin/user" method="POST"
      onSuccess={(_data, form) => { form.reset(); push("/admin/users"); }}>
  <input name="name" />
  <ValidationErrors name="name" />
  <FormError />
  <button type="submit">Create</button>
</Form>;
```

Inside a `Form`, three hooks read its context: `useFormStatus()`
(`{ isPending, validationErrors, formError }`), `useMutationStatus()`
(`{ isPending }`), and `useFormData()` for live `FormData` as the user types. The
form also carries a `data-loading` attribute for styling.

**Use the mutation hooks (`usePost` / `usePut` / `usePatch` / `useDelete`) when the
write is not a form submission** — a button that toggles a flag, an action in a menu,
an optimistic list operation. Pair them with `useMutate` to update the reading
query's cache rather than refetching.

**File posts that need to be unit-testable use `usePost` with `FormData`.**
`useUpload` is XHR-based, which is what gives it progress events and also what makes
it uninterceptable by MSW under happy-dom — reach for it only when you need the
progress bar.

Reference: <https://nstfkc.github.io/gemi/forms.md>
