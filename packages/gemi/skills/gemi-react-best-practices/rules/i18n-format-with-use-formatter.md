---
title: Format Dates and Numbers with useFormatter
impact: MEDIUM
impactDescription: hydration mismatches and off-by-one-day dates
tags: i18n, dates, time zone, hydration, ssr
---

## Format Dates and Numbers with useFormatter

`toLocaleDateString()`, `toLocaleString()` and `new Intl.DateTimeFormat()` with no
locale or `timeZone` use the **runtime's** locale and zone. A view renders twice —
on the server, then in the browser — so the same instant prints in the server's
zone and then in the viewer's: a different hour, often a different day, and a
hydration mismatch. Hard-coding `"en-US"` fixes the hydration but ignores the
app's locale.

**Incorrect (runtime locale and zone — differs between SSR and the browser):**

```tsx
function Row({ order }) {
  return <td>{new Date(order.createdAt).toLocaleDateString()}</td>;
}
```

**Correct (the page's locale and the app's zone, shipped with the payload):**

```tsx
import { useFormatter } from "gemi/client";

function Row({ order }) {
  const format = useFormatter();
  return <td>{format.date(order.createdAt)}</td>;
}
```

- Inside a component that reads a dictionary, use `t.format` from `useDictionary`.
- The zone is `translation.timeZone` (default `UTC`), or per request
  `translation.detectTimeZone(req)`; override one call with `{ timeZone }`.
- Server code (controllers, emails, jobs) uses `Lang.formatter()` — the request's
  locale and zone, so a date in an email matches the one on screen.
- Don't hand-roll UTC helpers per app; set the zone once in config.
