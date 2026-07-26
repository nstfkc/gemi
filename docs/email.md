# Email

gemi sends transactional email through a small `Email` base class backed by [jsx-email](https://jsx.email) templates. You write each email as a React component, wrap it in a class that extends `Email`, and send it with a fully-typed `send(...)` call. Delivery goes through a driver (Resend by default) configured in `app/config/mail.ts`.

Under the hood the `mail` config slice is read by the framework's `MailServiceProvider`, which binds a `MailManager` singleton into the container. `Email.send` resolves that manager — see [Facades](./facades.md) for how container resolution works.

## Defining an email

Create a class that extends `Email` (from `gemi/email`). It declares the message envelope (`from`, `subject`, …) as fields and the body as a `template` — a React component rendered by jsx-email. Its props type becomes the type of the `data` you must pass when sending.

```tsx
// app/email/WelcomeEmail.tsx
import { Email } from "gemi/email";
import { Body, Button, Container, Head, Html, Text } from "jsx-email";

export class WelcomeEmail extends Email {
  subject = "Welcome to our platform";
  from = "Acme <updates@transactional.acme.com>";

  template = (props: { name: string; magicLink: string; pin: string }) => {
    return (
      <Html>
        <Head />
        <Body>
          <Container>
            <Text>Hi {props.name}, welcome aboard!</Text>
            <Text>Your PIN is {props.pin}</Text>
            <Button href={props.magicLink}>Open your dashboard</Button>
          </Container>
        </Body>
      </Html>
    );
  };
}
```

The class fields you can set:

| Field | Type | Purpose |
| --- | --- | --- |
| `from` | `string` | Default sender (e.g. `"Acme <no-reply@acme.com>"`). |
| `to` | `string[]` | Default recipients. |
| `subject` | `string` \| `Record<string, string>` | Subject line — a plain string, or a map of locale → subject (see [i18n](#localization-i18n)). |
| `cc` / `bcc` | `string[]` | Default CC/BCC. |
| `attachments` | `EmailAttachment[]` | Default attachments. |
| `headers` | `Record<string, string>` | Extra headers merged into every send. |
| `template` | `ComponentType` | The jsx-email React body. Its props type drives `data`. |

## Sending

Call the static `send` method on your subclass. Everything except `data` is optional and falls back to the class fields.

```typescript
import { WelcomeEmail } from "@/app/email/WelcomeEmail";

await WelcomeEmail.send({
  data: {
    name: user.firstName,
    magicLink: link,
    pin: "123456",
  },
  to: [user.email],
  locale: user.locale,
  scheduledAt: "in 3 min",
});
```

The argument shape:

```typescript
{
  data: <template props, minus `locale`>;   // required, typed from `template`
  to?: string[];
  from?: string;
  subject?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  locale?: string;
  scheduledAt?: string;
}
```

Key points:

- **`data` is type-checked against your `template` props.** The `locale` key is provided separately (see below) and is injected into the template props for you, so you omit it from `data`.
- Any field you omit falls back to the value declared on the class (`to`, `from`, `subject`, `cc`, `bcc`, `attachments`, `headers`).
- Sending renders **both** an HTML body and a plain-text body from the same template automatically.
- Recipients pass through the `filterRecipients` callback from `app/config/mail.ts` before delivery; if it returns an empty list, the send is skipped.

> **Note:** When `process.env.EMAIL_DEBUG === "true"`, `send` does not deliver. Instead it writes the rendered HTML to `${ROOT_DIR}/.debug/emails/…html` and opens it locally — handy for previewing templates during development.

### Previewing

`preview` renders the template to an HTML string without sending — useful for a preview route or snapshot test:

```typescript
const html = await WelcomeEmail.preview({
  data: { name: "Ada", magicLink: "#", pin: "000000" },
  locale: "en-US",
});
```

## Configuration: `app/config/mail.ts`

The active driver, global headers, and the recipient filter live in the `mail` config slice. Write it with the `defineMailConfig` helper (an identity function that gives you type checking and completion) and default-export it:

```typescript
// app/config/mail.ts
import { defineMailConfig, ResendDriver } from "gemi/services";

export default defineMailConfig({
  driver: new ResendDriver(),
  // Headers merged into every outgoing message
  headers: {
    "List-Unsubscribe": `<${process.env.HOST_NAME}/api/email/unsubscribe>`,
  },
});
```

Register the slice under the `mail` key on your kernel:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";

import mail from "../config/mail";

export default class extends Kernel {
  config = {
    mail,
    // ...other slices
  };
}
```

Every field is optional; the whole slice is optional too. `MailConfig` is:

| Field | Type | Default |
| --- | --- | --- |
| `driver` | `EmailDriver` | `new ResendDriver()` |
| `headers` | `Record<string, string>` | `{}` |
| `filterRecipients` | `(emails: string[]) => string[] \| Promise<string[]>` | identity |

`ResendDriver` reads its API key from `process.env.RESEND_API_KEY` by default; pass a key explicitly with `new ResendDriver(myKey)` if you prefer. See [Configuration](./configuration.md) for setting `RESEND_API_KEY`.

### Filtering recipients

`filterRecipients` is a **config callback**, not a provider method. Use it to globally suppress or transform recipients (e.g. respecting unsubscribes, or restricting to a whitelist in staging):

```typescript
// app/config/mail.ts
import { defineMailConfig, ResendDriver } from "gemi/services";
import { isUnsubscribed } from "../database/unsubscribes";

export default defineMailConfig({
  driver: new ResendDriver(),

  async filterRecipients(emails) {
    const results = await Promise.all(emails.map(isUnsubscribed));
    return emails.filter((_, i) => !results[i]);
  },
});
```

> **A deliberate divergence from Laravel.** In Laravel you would hang this kind of hook off a service provider's `boot()` (an event listener, a `Mail::alwaysTo` macro). In gemi, subsystem hooks — `filterRecipients` here, `onLogCreated`/`onLogFileClosed` for logging, `extendSession` for auth — are plain callbacks on the config slice instead. They are part of the service's configuration, so they live where the rest of that service's configuration lives, and the service can read them synchronously at construction time.

### Custom drivers

Subclass `EmailDriver` (from `gemi/services`) and implement `send(params: SendEmailParams)` to integrate a different provider, then point the config at it:

```typescript
import { EmailDriver, type SendEmailParams } from "gemi/services";

export class PostmarkDriver extends EmailDriver {
  async send(params: SendEmailParams) {
    /* ... */
  }
}
```

```typescript
// app/config/mail.ts
import { defineMailConfig } from "gemi/services";
import { PostmarkDriver } from "../email/PostmarkDriver";

export default defineMailConfig({
  driver: new PostmarkDriver(),
});
```

### Replacing the manager entirely

Config covers the normal case. If you need to swap the `MailManager` itself, rebind its token from your own service provider — app providers listed in `providers` register **after** the framework's, so the last binding wins:

```typescript
// app/providers/AppServiceProvider.ts
import { ServiceProvider } from "gemi/support";
import { MailManager } from "gemi/services";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(MailManager, () => new AuditedMailManager());
  }
}
```

```typescript
// app/kernel/Kernel.ts
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  providers = [AppServiceProvider];
}
```

A `ServiceProvider` in gemi means what it means in Laravel: a class whose `register()` binds services into the container, and whose `boot()` runs once every provider has registered (so `boot()` may resolve, `register()` may not).

## Localization (i18n)

Emails are locale-aware. Pass `locale` to `send`, and:

1. **The subject** is chosen from the `subject` map by locale (falling back to the app's default locale). Declare it as a `Record<locale, string>`:

   ```tsx
   export class WelcomeEmail extends Email {
     subject = {
       "en-US": "Welcome to Acme",
       "tr-TR": "Acme'ye Hoş Geldiniz",
       "de-DE": "Willkommen bei Acme",
     };
     // ...
   }
   ```

2. **The template receives `locale`** as a prop, so you can branch copy inside the body:

   ```tsx
   template = (props: { firstName: string; locale?: string }) => {
     const t = props.locale === "tr-TR" ? tr : en;
     return <Layout locale={props.locale}>{/* ... */}</Layout>;
   };
   ```

When `locale` is omitted, the app's default locale is used. See [i18n](./i18n.md).

## Scheduling

`scheduledAt` schedules delayed delivery. It accepts a natural-language offset or an ISO 8601 timestamp (forwarded to the driver — Resend supports both):

```typescript
await WelcomeEmail.send({
  data: { /* ... */ },
  to: [user.email],
  scheduledAt: "in 3 min",
});
```

## Attachments

Attach files with the `EmailAttachment` shape — a filename and a `Buffer` of content:

```typescript
import type { EmailAttachment } from "gemi/services";

const invoice: EmailAttachment = {
  filename: "invoice.pdf",
  content: pdfBuffer, // Buffer
};

await OrderEmail.send({
  data: { /* ... */ },
  to: [customer.email],
  attachments: [invoice],
});
```

You can also set default `attachments` on the class if every send should carry the same file.

## Related

- [Facades](./facades.md) — how the container resolves services behind static proxies.
- [Kernel & Service Providers](./project-structure.md) — the `config` and `providers` fields on the kernel.
- [i18n](./i18n.md) — locale resolution and default locale.
- [Configuration](./configuration.md) — `RESEND_API_KEY`, `EMAIL_DEBUG`, `HOST_NAME`.
- [Authentication](./authentication.md) — auth flows send welcome, PIN, and password-reset emails.
