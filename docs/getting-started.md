# Getting Started

gemi is a batteries-included, full-stack TypeScript web framework built on Bun, Vite, and React 19 with server-side rendering. It ships everything a typical web app needs — routing, authentication, a type-safe network layer, middleware, form validation, emails, background jobs, object storage, and i18n — so you spend your time on product code instead of wiring libraries together.

## What is gemi?

gemi is Laravel-inspired: you describe your app with class-based routers, controllers, config modules, service providers, and a kernel rather than a file-based convention. It is **not** Next.js — routes are plain config objects on router classes, not files in a directory.

A single gemi project serves both your API and your React front end from one Bun process. Views are rendered on the server and hydrated on the client, and the network layer between them is fully typed end to end.

### When should you use gemi?

gemi is a good fit for **B2B applications with many API endpoints and non-trivial business logic** — dashboards, internal tools, and SaaS products where you control the whole stack.

> **Note:** If you are building a mostly static site, a blog, or a content-heavy e-commerce storefront where cold-start load time is the top priority, a static-first framework like Next.js or Astro may serve you better. gemi optimizes for application development, not static content delivery.

## Requirements

- **[Bun](https://bun.sh)** — gemi's runtime, package manager, bundler, and test runner. The CLI (`gemi dev`, `gemi build`, `gemi start`) spawns Bun processes directly.
- **Node.js >= 18** — some tooling expects a modern Node baseline even though the app runs on Bun.
- **React 19** — gemi depends on React and React DOM `>=19` (`react` / `react-dom` `19.2.x` in the templates). React 19 SSR is core to how views render.
- **Vite 8** and **sharp** are peer dependencies used by the build and the image-optimization service.
- **[`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react)** — required by the client/SSR build and wired into your app's `vite.config.mjs` (the scaffolded template includes it).

gemi's own `peerDependencies` are `react >= 19`, `react-dom >= 19`, `sharp ^0.34.2`, and `vite ^8.0.0`; the generated project also depends on `@vitejs/plugin-react`.

## Create a new app

Scaffold a project with `create-gemi-app`:

```bash
bunx create-gemi-app
```

You'll be prompted for a project name (defaults to `my-app`). You can also pass it directly:

```bash
bunx create-gemi-app --project-name my-app
```

The scaffolder downloads the **saas-starter** template, pins your `package.json` to the latest published `gemi` version, installs dependencies with Bun, and initializes a git repository. When it finishes, follow the printed steps:

```bash
cd my-app
mv .env.example .env          # create your local environment file
bunx prisma migrate deploy    # initialize the database and generate the Prisma client
bun dev                       # start the development server
```

The generated project is the canonical gemi layout: an `app/` directory (server entry, client entry, kernel, `config/`, `providers/`, routes, controllers, views, email, i18n, database), plus `gemi.config.ts`, `gemi.d.ts`, `vite.config.mjs`, `tsconfig.json`, a `prisma/` schema, and a `Dockerfile`. See [Project Structure](./project-structure.md) for a full tour.

## Commands

gemi projects wire the CLI into their `package.json` scripts:

```json
{
  "scripts": {
    "dev": "gemi dev",
    "build": "gemi build",
    "start": "gemi start"
  }
}
```

- **`gemi dev`** — starts the hot-reloading development server (Vite-backed, Bun `--hot`).
- **`gemi build`** — produces a production build: the Vite client bundle, the SSR view bundle, and a runnable `dist/server/server.mjs`.
- **`gemi start`** — runs the built server in production mode.

Run them via Bun:

```bash
bun dev
bun run build
bun run start
```

See the [CLI reference](./cli.md) for every command and flag.

> **Gotcha:** In production, `start` requires a completed `build` first — it launches `dist/server/server.mjs`. In containerized deploys, the `start` script also typically runs migrations first, e.g. `bunx prisma migrate deploy && gemi start`.

## Your first route and view

gemi separates **API routes** (JSON endpoints under `/api`) from **view routes** (server-rendered pages). Both live under `app/http/routes/`.

Add an API endpoint in `app/http/routes/api.ts`:

```typescript
import { ApiRouter, type HttpRequest } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    "/greeting/:name": this.get((req: HttpRequest<{ name: string }>) => {
      return { message: `Hello, ${req.params.name}!` };
    }),
  };
}
```

This is served at `/api/greeting/:name`. See [Routing](./routing.md) and [Controllers](./controllers.md) for handlers, resource controllers, and validation.

Add a page in `app/http/routes/view.ts`:

```typescript
import { ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/about": this.view("About"),
  };
}
```

`this.view("Home")` maps the `/` path to `app/views/Home.tsx`. Create that view:

```tsx
export default function Home() {
  return <h1>Welcome to gemi</h1>;
}
```

Then fetch your endpoint from a view with the type-safe client hook:

```tsx
import { useQuery } from "gemi/client";

export default function Home() {
  const { data } = useQuery("/greeting/:name", { params: { name: "world" } });
  return <h1>{data?.message}</h1>;
}
```

Run `bun dev` and open the printed URL. From here, dig into:

- [Project Structure & the Kernel](./project-structure.md)
- [Configuration](./configuration.md)
- [Routing](./routing.md)
- [Controllers](./controllers.md)
