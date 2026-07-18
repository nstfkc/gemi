# Forms

The `Form` component is gemi's declarative way to submit data to an API route. It
wraps a native `<form>`, collects its fields into a `FormData`, fires the right
mutation for you, injects the CSRF token, and exposes the server's validation and
form errors to child components through context. You get typed endpoints, automatic
error surfacing, and pending state without wiring up `useMutation` by hand.

Everything here is exported from `gemi/client`:

```tsx
import { Form, FormError, ValidationErrors, useFormStatus } from "gemi/client";
```

## The `Form` component

At minimum, `Form` needs an `action` (the endpoint path). It defaults to the `POST`
method. Name your inputs to match the endpoint's expected body.

```tsx
import { Form, ValidationErrors } from "gemi/client";

export default function CreateUser() {
  return (
    <Form method="POST" action="/admin/user">
      <input name="name" />
      <ValidationErrors name="name" />

      <input name="email" type="email" />
      <ValidationErrors name="email" />

      <button type="submit">Create</button>
    </Form>
  );
}
```

### Props

| prop | description |
| --- | --- |
| `action` | The endpoint path, typed against your routes for the chosen `method`. Required. |
| `method` | `"POST"` (default), `"PUT"`, `"PATCH"`, or `"DELETE"`. |
| `params` | Fills dynamic segments in `action` (e.g. `/user/:id`). Inherits current route params if omitted. |
| `search` | Query-string values appended to the request. |
| `onSuccess(result, form)` | Called on success with the typed response and the `HTMLFormElement`. |
| `onError(error, form)` | Called on failure with the error and the form element. |
| `dynamicInputs(formData)` | Return extra key/value pairs to append at submit time (values not in the DOM). |

All other native `<form>` props (`className`, `id`, …) pass straight through. The
form element gets a `group` class and a `data-loading` attribute reflecting the
pending state, which you can style against.

### Submit and navigate on success

Combine `onSuccess` with `useNavigate` to redirect after a successful submit:

```tsx
import { Form, useNavigate } from "gemi/client";

export default function UserCreate() {
  const { push } = useNavigate();

  return (
    <Form
      method="POST"
      action="/admin/user"
      onSuccess={(_data, form) => {
        form.reset();
        push("/admin/users");
      }}
    >
      <input name="name" />
      <input name="email" type="email" />
      <button type="submit">Submit</button>
    </Form>
  );
}
```

> **Note:** `Form` renders a hidden `__csrf` input automatically — you do not add it
> yourself. It submits via `fetch` (no full page reload) and prevents the native
> submit.

## Validation and error display

When a controller throws a `ValidationError`, the server responds with a
`validation_error` shaped as `{ kind, messages }`, where `messages` is keyed by field
name. `Form` catches that and exposes it through context so these child components can
render it — no manual error plumbing. See [Controllers](./controllers.md) for throwing
`ValidationError` server-side.

### `ValidationErrors`

Renders the messages for one field. Place it next to that field's input:

```tsx
<input name="email" type="email" />
<ValidationErrors name="email" className="text-sm text-red-600" />
```

It renders one element per message (a `<div>` by default). Pass a `render` prop to
customize the element:

```tsx
<ValidationErrors
  name="email"
  render={(props) => <p role="alert" {...props} />}
/>
```

Renders nothing when the field has no errors.

### `FormError`

Renders a single **form-level** message — the `form_error` kind, used for errors
that aren't tied to a specific field (e.g. "Invalid credentials"):

```tsx
<Form action="/auth/sign-in">
  <FormError className="text-red-700" />
  {/* fields… */}
</Form>
```

Renders nothing when there is no form error.

### `FormFieldContainer`

A `<div>` wrapper that sets `data-has-error` based on whether the named field has
validation errors — handy for styling a whole field group (label, input, message):

```tsx
<FormFieldContainer name="email" className="field">
  <label htmlFor="email">Email</label>
  <input id="email" name="email" />
  <ValidationErrors name="email" />
</FormFieldContainer>
```

## Form state hooks

These hooks read the surrounding `Form`'s context and must be used in components
rendered **inside** a `Form`.

### `useFormStatus`

Returns `{ isPending, validationErrors, formError }` — the full picture: whether a
submit is in flight, the per-field error map, and the form-level error. Ideal for a
submit button:

```tsx
import { useFormStatus } from "gemi/client";

function SubmitButton() {
  const { isPending } = useFormStatus();
  return (
    <button type="submit" disabled={isPending}>
      {isPending ? "Submitting…" : "Submit"}
    </button>
  );
}
```

### `useMutationStatus`

A narrower version that returns only `{ isPending }` — use it when you just need the
pending flag.

### `useFormData`

Returns the live `FormData` of the surrounding form, kept in sync as the user types
(via input events and value mutations). Use it to derive UI from current field
values — for example, enabling a button only when a field is filled, or previewing
input:

```tsx
import { useFormData } from "gemi/client";

function PreviewName() {
  const formData = useFormData();
  return <p>Hello, {String(formData.get("name") ?? "")}</p>;
}
```

## Building forms without `Form`

`Form` is a thin, ergonomic layer over the mutation hooks. If you need full control,
call `usePost` / `usePut` directly and manage the request yourself — see
[Data Fetching](./data-fetching.md). Auth flows are a common case; the auth views use
`Form` together with `useNavigate` (see [Authentication](./authentication.md)).

## Related

- [Controllers](./controllers.md) — throwing `ValidationError` to drive `ValidationErrors`.
- [Data Fetching](./data-fetching.md) — the mutation hooks `Form` is built on.
- [Navigation](./navigation.md) — redirecting after a successful submit.
- [Authentication](./authentication.md) — sign-in/up forms use these components.
