# Subdomains & Custom Domains

By default, gemi routes on the path only: every host reaching the server is served by the same root routers. Declaring `route.domains` makes the host part of routing too. It gives an app:

- **Fixed subdomains** with their own routers. For example, `admin.example.com` can run a different api and different views from `example.com`.
- **A param subdomain**, such as `acme.example.com`. It runs the same app on every tenant's host, and the handler reads the tenant from `req.domain.params`.
- **Custom domains.** A resolver maps a host the app does not own, such as `app.acme.com`, onto a tenant. That host is then served exactly as `acme.example.com` would be. A catch-all group can serve the hosts the resolver does not know.
- **An endpoint for on-demand TLS.** A proxy such as Caddy asks it before issuing a certificate for a new custom domain.

Route keys stay path-only, and routers do not change. Each host group simply has its own root routers.

## Declaring domains

`domains` sits next to `api` and `view` in `app/config/route.ts`:

```typescript
import { createRoot } from "gemi/client";
import { defineRouteConfig } from "gemi/services";

import RootApiRouter from "@/app/http/routes/api";
import RootViewRouter from "@/app/http/routes/view";
import AdminApiRouter from "@/app/http/routes/admin/api";
import AdminViewRouter from "@/app/http/routes/admin/view";
import RootLayout from "@/app/views/RootLayout";
import { Organization } from "@/app/models";

export default defineRouteConfig({
  api: { rootRouter: RootApiRouter },
  view: { rootRouter: RootViewRouter, root: createRoot(RootLayout) },
  domains: {
    root: process.env.ROOT_DOMAIN ?? "localhost",
    groups: [
      // A site of its own: its own api and its own views.
      { subdomain: "admin", api: { rootRouter: AdminApiRouter }, view: { rootRouter: AdminViewRouter } },
      // The app itself, once per tenant. No routers given, so it runs the root ones.
      {
        subdomain: ":tenant",
        exists: async ({ tenant }) => (await Organization.count({ where: { slug: tenant } })) > 0,
      },
    ],
    custom: {
      group: ":tenant",
      resolve: async (host) => {
        const org = await Organization.findFirst({ where: { customDomain: host } });
        return org ? { tenant: org.slug } : null;
      },
    },
  },
});
```

| Field | Type | Purpose |
| --- | --- | --- |
| `root` | `string` | The apex the subdomains hang off. Compared against the request's hostname, so the port does not matter. |
| `trustProxy` | `boolean` (default `false`) | Read the host from `X-Forwarded-Host`, and the protocol from `X-Forwarded-Proto`. Only set it behind a proxy that overwrites those headers. Otherwise a client can pick its own host. |
| `groups[].subdomain` | `string` | A fixed subdomain (`"admin"`, `"eu.admin"`), or one `:param` label (`":tenant"`). |
| `groups[].api` / `groups[].view` | route config | The group's own `rootRouter`, plus hooks if needed. Hooks default to the root's. Leave either out and the group serves the root one for that side. |
| `groups[].exists` | `(params, req) => boolean \| Promise<boolean>` | For the param group only. A `false` answers `404` before any route runs. |
| `custom.group` | `string` | The `subdomain` of the group a resolved custom host is served as. |
| `custom.resolve` | `(host) => params \| null` | Maps a host outside `root` to that group's params, or returns `null` for a host the app does not know. |
| `custom.cacheTtlMs` | `number` (default `60000`) | How long a `resolve` answer is reused. Both hits and misses are cached. `0` disables the cache. |
| `custom.fallback` | `{ api?, view? }` | Serves every host `resolve` returned `null` for, instead of a `404`. |

A malformed config fails the boot. That covers an empty root, a subdomain declared twice, two param subdomains, and a `custom.group` that names no group.

## How a host is matched

1. `root` itself is served by the root routers.
2. A subdomain of `root` is tried against the fixed subdomains first, as an exact match that may span several labels. After that it is tried against the param subdomain, which matches exactly **one** label and must pass `exists`.
3. Any other host goes to `custom.resolve`. A hit is served as `custom.group` with the params it returned. A miss goes to `custom.fallback` if there is one.
4. Whatever is left gets a `404` with the body `Unknown host`. The same happens to a subdomain of `root` that nothing matches: `a.b.example.com`, or an `exists` that said no.

> **Note:** with `route.domains` declared, **every** request needs a known host, including a load
> balancer's health check sent to the server's IP address. Point health checks at the root host,
> or answer them from a global middleware, which runs before host matching.

## Reading the domain in a handler

`req.domain` holds what the host said. `domain.params` is kept apart from `req.params`, which only ever holds the path's params:

```typescript
export class ProjectController extends Controller {
  async index(req = new HttpRequest()) {
    const tenant = req.domain?.params.tenant; // "acme" on acme.example.com and on app.acme.com
    return Project.findMany({ where: { organization: { slug: tenant } } });
  }
}
```

| Field | Value |
| --- | --- |
| `host` | The hostname, lowercased and without the port. |
| `group` | `""` for the root, the group's `subdomain` (`"admin"`, `":tenant"`) otherwise, and `"*"` for the fallback. |
| `params` | The param subdomain's value, or what `custom.resolve` returned. |
| `custom` | `true` for a host outside `root`. |

`req.domain` is `null` when the app declares no `route.domains`. A server-side query from a view runs against the api of the page's own group. A tool call an agent makes during a request carries the same domain as that request.

In a view, `useDomain()` returns the same fields:

```tsx
import { useDomain } from "gemi/client";

export default function Header() {
  const { params, custom } = useDomain();
  return <h1>{params.tenant}</h1>;
}
```

## Linking across hosts

The client router handles paths on the current host only. To link to another host, build an absolute URL. `Link` and `useNavigate` treat an absolute URL as a full page load, not a client-side navigation:

```tsx
import { Link, useDomain } from "gemi/client";

export default function AdminLink() {
  const { url } = useDomain();
  return <Link href={url({ subdomain: "admin" }, "/users")}>Admin</Link>;
}
```

`url(target, path)` keeps the protocol and port of the current page. `target` is `{ subdomain }`, or `{ host }` for a custom domain. On the server, `Url.forDomain` does the same, with typed params:

```typescript
import { Url } from "gemi/facades";

Url.forDomain({ subdomain: "acme" }, "/projects/:id", { id: project.id });
// "https://acme.example.com/projects/42"
```

Outside a request, in a job or an email, `Url.forDomain` takes the protocol from `HOST_NAME`.

## Sessions across subdomains

By default, the session cookie belongs to the host that set it, so signing in on `acme.example.com` does not sign anyone in on `admin.example.com`. Set `cookieDomain` in `app/config/auth.ts` to share it:

```typescript
export default defineAuthConfig({
  cookieDomain: "root", // or a hostname, e.g. "example.com"
});
```

The cookie is scoped to the domain only on a request whose host is that domain or one of its subdomains. A browser refuses a cookie for another site's domain, so a **custom domain keeps its own session**, and users sign in on that host. Signing out clears both the shared cookie and any host-only cookie set before `cookieDomain` was turned on.

## On-demand TLS for custom domains

`GET /__gemi__/domains/ask?domain=<host>` answers `200` when the app serves that host in its own right, and `404` otherwise. "In its own right" means the host is the root, a declared subdomain, a param subdomain that passes `exists`, or a custom domain that `custom.resolve` accepts. A host only the fallback would serve gets a `404`, so the endpoint never approves certificates for arbitrary hosts.

The endpoint is answered before host matching, so the proxy can call it on any host, `localhost` included. It does run after global middleware. With Caddy:

```
{
  on_demand_tls {
    ask http://localhost:5173/__gemi__/domains/ask
  }
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy localhost:5173
}
```

Caddy keeps the original `Host` when it proxies, so `trustProxy` is not needed here. Set `trustProxy` behind a proxy that rewrites `Host` and sends `X-Forwarded-Host` instead.

## Development

`*.localhost` resolves to the loopback address in Chrome and Firefox, so with `root: "localhost"`, `acme.localhost:5173` and `admin.localhost:5173` work with no setup. For a custom domain, add an `/etc/hosts` entry (`127.0.0.1 app.acme.test`). The dev server lets the root, its subdomains and, when `custom` is set, any host through Vite's host check.

Browsers differ on accepting a cookie scoped to `localhost` itself. To test a shared session across subdomains, use a root that resolves to loopback with its subdomains, such as `lvh.me`.

## Limits

- Typed routes cover the root routers. A group that runs the root routers, the usual tenant setup, is fully typed. A group with routers of its own, like `admin` above, has untyped `useQuery` and `Link` paths for now.
- The MCP router is served on the root group's api.
- `Url.absolute` keeps using `HOST_NAME`, because an OAuth redirect URI has to be one fixed host.

## See also

- [Routing](./routing.md): the routers each group runs.
- [Authentication](./authentication.md): `cookieDomain` and the session cookie.
- [Navigation](./navigation.md): `Link` and `useNavigate`.
- [Middleware](./middleware.md): global middleware, which runs before host matching.
