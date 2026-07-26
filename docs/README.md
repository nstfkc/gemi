# gemi Documentation

**gemi** is a batteries-included, full-stack TypeScript web framework built on **Bun**, **Vite**, and **React 19** with server-side rendering. It ships everything a typical web application needs — class-based routing, a type-safe network layer, authentication and authorization, middleware, form validation, transactional email, background jobs, cron, object storage, real-time broadcasting, and i18n — so you spend time on product code instead of wiring libraries together.

gemi is Laravel-inspired: an application is a **Kernel** owning a **container**, **service providers** register bindings into that container, runtime settings live in **`app/config/*.ts`**, routes are declared in **router classes**, request logic lives in **controllers**, and framework services are reached through **facades**. It is **not** Next.js — there is no file-based routing; every URL is mapped explicitly in a router.

> Runnable examples come from the `saas-starter` template (`templates/saas-starter`).

## When to use gemi

gemi is a strong fit for **B2B / SaaS apps** with many API endpoints and non-trivial business logic, where an integrated, type-safe front-to-back stack pays off. For static sites, blogs, or content-first e-commerce optimized for first paint, a static/SSG framework may fit better.

## Getting started

```bash
bunx create-gemi-app
# then:
cd my-app
mv .env.example .env
bunx prisma migrate deploy
bun dev
```

See **[Getting Started](./getting-started.md)** for requirements and a first route-and-view walkthrough.

## Documentation map

### Foundations
- **[Getting Started](./getting-started.md)** — install, scaffold, dev/build/start, your first route + view.
- **[Project Structure & the Kernel](./project-structure.md)** — the `app/` layout, the Kernel, the container, `app/config/*.ts`, service providers, and app bootstrap.
- **[Configuration](./configuration.md)** — `gemi.config.ts` (build config), `.env` handling, `app/preload.ts`, Vite config.
- **[CLI](./cli.md)** — `gemi dev`, `build`, `start`, and the codegen/inspection commands.

### HTTP layer
- **[Routing](./routing.md)** — `ApiRouter` / `ViewRouter`, path params, groups, nesting, `resource()`.
- **[Controllers](./controllers.md)** — `Controller` / `ResourceController`, the `HttpRequest` API, request validation, `ValidationError`.
- **[Middleware](./middleware.md)** — the string DSL, built-in middleware, negation, and writing custom middleware.

### Views & client
- **[Views & Layouts](./views-and-layouts.md)** — view components, server data binding, nested layouts, `Head`, breadcrumbs.
- **[Data Fetching](./data-fetching.md)** — `useQuery`, the mutation hooks, the `Query` prefetch facade, and the type-safe `gemi.d.ts` layer.
- **[Forms](./forms.md)** — the `Form` component, surfacing validation errors, form status hooks.
- **[Navigation](./navigation.md)** — `Link`, `useNavigate`, `useParams`, `useSearchParams`, and the `Redirect` component vs. facade.

### Auth
- **[Authentication](./authentication.md)** — `app/config/auth.ts`, adapters, sessions, magic links, OAuth, the `Auth` facade, and client auth hooks.
- **[Authorization](./authorization.md)** — role-based middleware and authorization errors.

### Services & facades
- **[Facades](./facades.md)** — reference for `Auth`, `Redirect`, `Lang`, `Storage`, `Query`, `Broadcast`, `Url`, `Log`, `Meta`, `Cookie`, `Redis`.
- **[File Storage](./file-storage.md)** — the `Storage` facade, filesystem/S3 drivers, image optimization, the `Image` component.
- **[Email](./email.md)** — the `Email` class, jsx-email templates, the Resend driver, localization and scheduling.
- **[Jobs & Queues](./jobs-and-queues.md)** — defining and dispatching background `Job`s.
- **[Cron](./cron.md)** — scheduling recurring `CronJob`s.
- **[Broadcasting](./broadcasting.md)** — websocket channels, the `Broadcast` facade, `useSubscription` / `useBroadcast`.
- **[Internationalization](./i18n.md)** — component-scoped dictionaries, `useTranslator`, `useLocale`, locale detection.

## Core concepts at a glance

| Concept | What it is | Where |
| --- | --- | --- |
| **Kernel** | Composition root: declares the app's `config` and `providers` | [project-structure](./project-structure.md) |
| **Container** | The `Application` every service is resolved from — `app(MailManager)` | [project-structure](./project-structure.md) |
| **Config slice** | `app/config/<name>.ts` — runtime settings and hooks for one subsystem | [project-structure](./project-structure.md) |
| **Service provider** | Registers bindings into the container (`register()` / `boot()`) | [project-structure](./project-structure.md) |
| **Router** | Class declaring a `routes` object; routers nest | [routing](./routing.md) |
| **Controller** | Server logic behind a route; receives `HttpRequest` | [controllers](./controllers.md) |
| **Facade** | Static proxy to a container-resolved service | [facades](./facades.md) |
| **View** | Default-export React component rendered for a URL | [views-and-layouts](./views-and-layouts.md) |
| **`gemi.d.ts`** | Generated types binding client hooks to your routes | [data-fetching](./data-fetching.md) |

## A few things that will bite you

These are the counter-intuitive rules worth knowing up front — each is covered in depth in its page.

- **Subsystem hooks are config callbacks, not provider methods.** `filterRecipients`, `onLogCreated`, `onSignUp`, `onRequestFail`, `detectLocale` and friends are plain properties on a config slice in `app/config/*.ts` — there is no provider to subclass and no `boot()` macro to override. This is a deliberate divergence from Laravel. See [Project Structure](./project-structure.md#hooks-are-config-callbacks-not-provider-methods).
- **`gemi.config.ts` is build config; `app/config/` is runtime config.** Similar names, unrelated files. `gemi.config.ts` configures Vite/Bun; `app/config/*.ts` configures framework services. See [Configuration](./configuration.md) and [Project Structure](./project-structure.md#configuration-appconfig).
- **A service provider registers bindings — it does not hold settings.** `register()` binds factories into the container and must not resolve anything; `boot()` runs after every provider has registered and may resolve freely. Settings live in config.
- **The `Redirect` facade works by throwing.** Never wrap `Redirect.to(...)` in `try/catch`; the framework catches the throw to perform the redirect, and wrapping it silently breaks it. (This is the server facade from `gemi/facades`, distinct from the client `<Redirect />` component.) See [Facades](./facades.md) and [Navigation](./navigation.md).
- **Two facades were renamed.** `I18n` is now `Lang` and `FileStorage` is now `Storage`; the methods on each are unchanged. See [Facades](./facades.md).
- **Middleware is a string DSL.** `auth`, `cache:...`, `rate-limit:N`, etc., and `-auth` *cancels* an inherited middleware. Most names (`admin`, `role:...`) are **app-registered aliases**, not built-ins. See [Middleware](./middleware.md).
- **The query hook is `useQuery`, not `useGet`.** Some app-level notes mention `useGet`; it does not exist in gemi. See [Data Fetching](./data-fetching.md).
- **Routing is explicit.** A view/controller file name has no relation to its URL — the mapping lives in a router. See [Routing](./routing.md).
- **`gemi.d.ts` is generated — never edit it by hand.** Regenerate the API surface with `gemi ide:generate-api-manifest`. See [CLI](./cli.md).
