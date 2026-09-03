---
title: Validate With a Request Schema, Not Inline Checks
impact: HIGH
impactDescription: one boundary, localized messages, typed body
tags: controller, validation, requests
---

## Validate With a Request Schema, Not Inline Checks

Subclass `HttpRequest`, declare a `schema`, and type the controller method against
it. The framework validates before the method body runs and produces the standard
`validation_error` response that `<Form>` and the mutation hooks already know how to
render per field.

Built-in rules: `required`, `string`, `email`, `number`, `password`, `min:N`,
`max:N`, `file`, `fileType`, `fileSize`. Custom logic goes in a `refine()` override.
**A field with no value and no `required` rule is skipped**, so optional fields need
no special handling.

**Incorrect (hand-rolled, unlocalized, and it will drift from the client):**

```ts
async store(req: HttpRequest<{ name: string }>) {
  const input = await req.input();
  const name = input.get("name");
  if (!name) return { error: "Name is required" };  // wrong shape entirely
  if (name.length > 120) return { error: "Too long" };
}
```

**Correct:**

```ts
class CreateCustomerRequest extends HttpRequest<{ name: string; email?: string }> {
  schema = {
    name: { required: "Name is required", "max:120": "Too long" },
    email: { email: "Email is invalid", "max:160": "Too long" },
  };
}

export class CustomerController extends ResourceController {
  async store(req: CreateCustomerRequest) {
    const { name, email } = (await req.input()).toJSON();
  }
}
```

**Localize the messages** rather than hardcoding English — `Dictionary.text({...})`
from `gemi/i18n` translates an inline string without needing a client dictionary,
which is exactly what a schema message is:

```ts
schema = { name: { required: Dictionary.text({ "en-US": "Name is required", "tr-TR": "Ad gerekli" }) } };
```

**Use `refine()` for a cross-field or lookup rule** — the one place a guard covers
every path into an endpoint. `req.safeInput()` returns `{ isValid, errors, input }`
when you need to branch instead of throw.

Reference: `app/http/requests/SignUpRequest.ts` (a `refine()` guard covering every
sign-up path); <https://nstfkc.github.io/gemi/controllers.md>
