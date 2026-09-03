---
title: Construct Clients Lazily, Never at Module Scope
impact: HIGH
impactDescription: keeps boot fast and command discovery working
tags: service, boot, module-scope, commands
---

## Construct Clients Lazily, Never at Module Scope

Work at module scope runs whenever the module is *imported*, which is not the same as
when it is *used*. Three places in a gemi app punish that:

1. **Command discovery imports every file under `app/commands` just to list them.**
   A `new Stripe(key)` beside the handler throws on an empty key during
   `gemi run` — with no command actually invoked.
2. **Service `boot()` runs on every application start**, including per-test and
   per-CLI-command. Validate settings there; open connections lazily.
3. **Ports are installed at boot, after every module in the graph has evaluated**, so
   reading one at module scope gets `undefined`.

**Incorrect (constructed on import; `boot()` opens a connection):**

```ts
const stripe = new Stripe(process.env.STRIPE_KEY!);   // throws at import time

export class SearchIndex extends Service {
  static token = "searchIndex";
  async boot() {
    this.client = await Client.connect(process.env.SEARCH_URL!); // every start
  }
}
```

**Correct (validate at boot, connect on first use, construct in the handler):**

```ts
export class SearchIndex extends Service {
  static token = "searchIndex";
  url = process.env.SEARCH_URL;
  private ready?: Promise<Client>;

  async boot() {
    if (!this.url) throw new Error("SEARCH_URL is not set");
  }

  private connect() {
    return (this.ready ??= Client.connect(this.url!));
  }
}

export default defineCommand("sync-prices").handle(async ({ line }) => {
  const stripe = new Stripe(process.env.STRIPE_KEY!);   // inside the handler
});
```

**`Service.inject()` must not be called at module top level either** — it throws
because the kernel has not booted. Inject as a constructor default
(`constructor(private billing = Billing.inject())`), which resolves per request and
lets a test pass a double without touching the container.

**Read a runtime port inside a function or behind a getter**, never at module scope.

Reference: <https://nstfkc.github.io/gemi/services.md>
