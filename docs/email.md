# Email

gemi sends transactional email through a small `Email` base class backed by [jsx-email](https://jsx.email) templates. You write each email as a React component, wrap it in a class that extends `Email`, and send it with a fully-typed `send(...)` call. Delivery goes through a driver (Resend by default, or Azure Communication Services) configured in `app/config/mail.ts`.

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
| `replyTo` | `string[]` | Where replies go, when not to `from`. |
| `attachments` | `EmailAttachment[]` | Default attachments. |
| `headers` | `Record<string, string>` | Extra headers merged into every send. |
| `driver` | `string` | A driver registered under `drivers` in the mail config (see [Named drivers](#named-drivers)). Unset: the default `driver`. |
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
  replyTo?: string[];
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  locale?: string;
  scheduledAt?: string;
  idempotencyKey?: string;
  driver?: string;          // a named driver for this send, over the class's
}
```

`send` resolves to an `EmailSendResult`:

```typescript
{
  id: string | null;      // the provider's message id
  provider: string;       // "resend", your driver's `provider`, or "debug"
  status: "sent" | "failed" | "skipped" | "debug";
  error?: unknown;        // what the driver reported, when status is "failed"
}
```

`status` is `skipped` when `filterRecipients` left nobody to send to, and `failed` when the driver rejected the message (`send` does not throw for that, as before). Store `id` if you track delivery, for example against Resend webhooks.

Key points:

- **`data` is type-checked against your `template` props.** The `locale` key is provided separately (see below) and is injected into the template props for you, so you omit it from `data`.
- Any field you omit falls back to the value declared on the class (`to`, `from`, `subject`, `cc`, `bcc`, `attachments`, `headers`).
- Sending renders **both** an HTML body and a plain-text body from the same template automatically.
- `to` passes through the `filterRecipients` callback from `app/config/mail.ts` before delivery, and the driver receives the list it returns; if that list is empty, the send is skipped.

> **Note:** When `process.env.EMAIL_DEBUG === "true"`, `send` does not deliver. Instead it writes the rendered HTML to `${ROOT_DIR}/.debug/emails/<iso-timestamp><subject>.html` and opens it locally (not under `CI=true`, nor with `EMAIL_DEBUG_OPEN=false`) — handy for previewing templates during development. Next to it, a `.json` file with the same name records the envelope the driver would have received, so a test can assert who a mail went to:
>
> ```json
> {
>   "to": ["ada@example.com"],
>   "cc": [],
>   "bcc": [],
>   "replyTo": [],
>   "from": "hello@example.com",
>   "subject": "Welcome",
>   "headers": {},
>   "attachments": [{ "filename": "invoice.pdf", "bytes": 1234 }],
>   "scheduledAt": null,
>   "idempotencyKey": null,
>   "locale": "tr-TR",
>   "driver": null,
>   "text": "..."
> }
> ```
>
> `to` is the list after `filterRecipients`. `/`, `\` and control characters in the subject are replaced with `_` in the filename; the sidecar keeps the real subject. The `.json` is written before the `.html`.

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
| `drivers` | `Record<string, EmailDriver>` | `{}` |
| `headers` | `Record<string, string>` | `{}` |
| `filterRecipients` | `(emails: string[]) => string[] \| Promise<string[]>` | identity |

`ResendDriver` reads its API key from `process.env.RESEND_API_KEY` by default; pass a key explicitly with `new ResendDriver(myKey)` if you prefer. See [Configuration](./configuration.md) for setting `RESEND_API_KEY`.

### Azure Communication Services: `AcsDriver`

`AcsDriver` sends through [Azure Communication Services Email](https://learn.microsoft.com/azure/communication-services/concepts/email/email-overview). Install the SDK (and `@azure/identity` for managed identity); both are optional peer dependencies, loaded on the first send:

```bash
bun add @azure/communication-email @azure/identity
```

```typescript
// app/config/mail.ts
import { AcsDriver, defineMailConfig } from "gemi/services";

export default defineMailConfig({
  driver: new AcsDriver(),
});
```

How it authenticates, first match wins:

| Config | Env fallback | Auth |
| --- | --- | --- |
| `client` | | A pre-built `EmailClient` (your own retries, proxy or credential; tests pass a fake). The SDK is never imported. |
| `endpoint` (+ optional `credential`) | `AZURE_COMMUNICATION_ENDPOINT` | `credential`, or `DefaultAzureCredential`: the app's managed identity in Azure (set `AZURE_CLIENT_ID` for a user-assigned one), `az login` locally. No secret to store. The identity needs a role that can send email on the Communication Services resource. |
| `connectionString` | `AZURE_COMMUNICATION_CONNECTION_STRING` | The resource's access key. |

```typescript
new AcsDriver({ endpoint: "https://acme-email.europe.communication.azure.com" });
new AcsDriver({ connectionString: process.env.ACS_CONNECTION_STRING });
```

What differs from Resend:

- **`from`** must be a sender address verified on a domain linked to the resource. A display name in `from` (`"Acme <updates@acme.com>"`) is dropped: ACS shows the display name configured on the sender username. Recipients (`to`, `cc`, `bcc`, `replyTo`) keep theirs.
- **`id`** is the send's operation id. `Email.send` resolves once ACS has accepted the message and doesn't wait for delivery; delivery and bounces arrive through Event Grid (`EmailDeliveryReportReceived`), keyed by that id.
- **No idempotency keys.** `supportsIdempotencyKey` is `false` and `idempotencyKey` is ignored, so a retried job sends again. Dedupe in the app (for example a row per delivery, written before sending).
- **No scheduled send.** A `scheduledAt` throws (`AcsDriver can't schedule a send …`). Dispatch a delayed job that sends instead.
- **Attachments** are sent base64-encoded with their `contentType`; without one it is inferred from the filename's extension (`application/octet-stream` if unknown). ACS caps a whole message, attachments included, at 10 MB.
- **Headers** (`headers`, the config's `headers`) are passed as ACS custom headers, so `List-Unsubscribe`, `In-Reply-To` and `References` work.

### Named drivers

`drivers` registers more drivers by name. An email class picks one with its `driver` field, a single send with `driver`, and everything else keeps going through `driver`. Use it to move email classes to a new provider one at a time:

```typescript
// app/config/mail.ts
import { AcsDriver, defineMailConfig, ResendDriver } from "gemi/services";

export default defineMailConfig({
  driver: new ResendDriver(),
  drivers: {
    acs: new AcsDriver(),
  },
});
```

```tsx
export class OpsAlarmEmail extends Email {
  driver = "acs";
  // ...
}

await InvoiceEmail.send({ to: [customer.email], data: { invoice }, driver: "acs" });
```

- The send's `driver` wins over the class's.
- An unknown name throws (`No mail driver named "…"`) rather than falling back to the default, also under `EMAIL_DEBUG`, so a typo shows up in development.
- `provider` in the result is the named driver's (`"acs"`), and the debug sidecar records the name as `driver`.
- `headers` and `filterRecipients` from the config apply to every driver.
- A named driver is called directly, not through `MailManager.send`, so a replaced manager that wraps `send` doesn't see those sends. `app(MailManager).driverFor(name)` returns the driver for a name (the default without one).

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

Subclass `EmailDriver` (from `gemi/services`) and implement `send(params: SendEmailParams)` to integrate a different provider, then point the config at it. To report the provider's message id from `Email.send`, also override `deliver`, which returns `{ ok, id, error? }`; the default calls `send` and reports `id: null`. A driver (or `MailManager` subclass) that overrides only `send` keeps being called through `send`. Set `provider` to name the driver in send results, and `supportsIdempotencyKey` if it forwards `params.idempotencyKey`:

```typescript
import {
  EmailDriver,
  type EmailDeliveryResult,
  type SendEmailParams,
} from "gemi/services";

export class PostmarkDriver extends EmailDriver {
  override readonly provider = "postmark";

  async send(params: SendEmailParams) {
    return (await this.deliver(params)).ok;
  }

  override async deliver(params: SendEmailParams): Promise<EmailDeliveryResult> {
    /* call the provider, then: */
    return { ok: true, id: "<provider message id>" };
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

`scheduledAt` schedules delayed delivery. It accepts a natural-language offset or an ISO 8601 timestamp (forwarded to the driver — Resend supports both; `AcsDriver` refuses it, send from a delayed job instead):

```typescript
await WelcomeEmail.send({
  data: { /* ... */ },
  to: [user.email],
  scheduledAt: "in 3 min",
});
```

## Retries and idempotency

A send from a job that may run twice (a queue retry, a cron run that overlaps) can pass an `idempotencyKey`. The provider delivers the first request with a key and answers a repeat without sending again:

```typescript
const { id, status } = await ReportEmail.send({
  to: [recipient.email],
  data: { report },
  idempotencyKey: `report:${report.id}:${recipient.id}`,
});
```

Make the key stable per delivery (the same report to the same recipient), not per attempt. `ResendDriver` sends it as Resend's `Idempotency-Key` header; Resend keeps keys for 24 hours, so a retry after that sends again, and reusing a key with a different payload is rejected. Stop retrying before the key expires.

Drivers that don't support keys ignore them: check `driver.supportsIdempotencyKey` (`true` for `ResendDriver`, `false` for `AcsDriver` and by default). Under `EMAIL_DEBUG=true` the key is recorded in the `.json` sidecar and `send` returns a fake id (`debug_<uuid>`).

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

An attachment can carry a `contentType` (`"text/csv"`). Resend and ACS both forward it; `AcsDriver` infers it from the filename when it's missing.

## Related

- [Facades](./facades.md) — how the container resolves services behind static proxies.
- [Kernel & Service Providers](./project-structure.md) — the `config` and `providers` fields on the kernel.
- [i18n](./i18n.md) — locale resolution and default locale.
- [Configuration](./configuration.md) — `RESEND_API_KEY`, `AZURE_COMMUNICATION_ENDPOINT`, `EMAIL_DEBUG`, `HOST_NAME`.
- [Authentication](./authentication.md) — auth flows send welcome, PIN, and password-reset emails.
