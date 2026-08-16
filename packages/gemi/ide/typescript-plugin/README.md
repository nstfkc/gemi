# gemi TypeScript language service plugin

Makes a route path behave like a reference to the code that serves it.

```tsx
const { data } = useQuery("/suspense-demo/metrics");
//                         ^ go to definition → SuspenseDemoController.metrics()

const nav = <Link href="/about">About</Link>;
//                       ^ go to definition → app/views/About.tsx, and its handler
```

Without it, following one call site means opening `app/http/routes/api.ts`,
finding the entry, reading which controller and method it names, and opening
that file — for a connection the type system already knows about.

## Why a plugin

`useQuery("/reports")` names its handler as precisely as a function call names a
function: the string is checked against the router at compile time, and
autocomplete offers only paths that exist. But the connection is made by
conditional types — `CreateRPC` maps a `routes` object to a union of string
literal keys — not by a symbol. There is nothing for go-to-definition to follow,
so it stops at the literal.

A language service plugin is the only place that gap can be closed, because
closing it takes two things at once: the AST of the router (to know what
`"/reports"` maps to) and the checker (to resolve `HomeController` through its
import to a class, and `"index"` to a method that might be inherited). tsserver
has both, already loaded.

## Enabling it

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "gemi/ide/typescript-plugin" }]
  }
}
```

**VS Code** ships its own copy of TypeScript and ignores `plugins` unless told to
use the workspace's: run **TypeScript: Select TypeScript Version → Use Workspace
Version** once per project. Editors that drive tsserver over LSP — Neovim, Emacs,
Helix, JetBrains — read `tsconfig.json` directly and need nothing extra.

Options, all optional:

| Key           | Default                         |                                                      |
| ------------- | ------------------------------- | ---------------------------------------------------- |
| `projectRoot` | the `tsconfig.json`'s directory | where the app's `app/` folder sits                   |
| `viewsDir`    | `<projectRoot>/app/views`       | where `this.view("auth/SignIn")` finds its component |
| `enable`      | `true`                          | set `false` to switch off without editing the array  |

## What it answers

**Go to definition** on a route path resolves to:

| Route                               | Lands on                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `this.get(HomeController, "index")` | `index()`, in the controller — through imports, aliases and base classes |
| `this.get(() => …)`                 | the callback, in the router                                              |
| `this.resource(ProductsController)` | the method for that verb — `list`, `store`, `show`, `update`, `delete`   |
| `this.view("Reports", [C, "m"])`    | the component _and_ the handler, offered as two definitions              |
| anything it cannot read through     | the `routes` entry itself, one line from the answer                      |

**Hover** names the route and where its handler lives, appended to whatever
TypeScript already had to say.

Everything else is delegated untouched — an identifier, an import specifier, an
object key that happens to look like a path, `config["/home"]`. The plugin answers
only where the position really is a route path and the path really is in the
table, and it never throws: a surprise degrades to "not a route", because a
broken jump beats an editor with no language features.

## How it picks the right route

A path can carry several handlers — a `GET` and a `POST` at `/products`, or an
API route and a view sharing a name. Three signals narrow it, each applied only
when narrowing leaves something:

1. **The parameter's constraint.** `useQuery(url: T)` declares
   `T extends keyof GetRPC`, so the constraint of the parameter this argument
   fills _is_ the GET route set. Comparing that set against each verb's paths
   identifies the verb — with no hook name hardcoded anywhere, which is why a
   wrapper an app writes over `useQuery` works for free.
2. **A verb named outright.** `useMutation("PUT", …)` and
   `<Form action=… method="PUT">`. Keyed off the shape — a verb in the preceding
   argument, a sibling `method` attribute — not off the callee's name.
3. **The attribute.** `href` means a page, `action` means an endpoint.

When several routes still survive, all are returned and the editor offers the
choice. That is the honest answer for a path that genuinely carries two handlers.

## What it cannot see

Routes assembled anywhere but a `routes` property initializer — built in a
constructor, spread in from elsewhere, returned by a helper. This is a floor
rather than a gap: `CreateRPC` cannot see those either, so a route declared that
way has no typed call site to jump _from_.

## Layout

|                  |                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | the tsserver entry point (`export =`), config, and the guard that keeps a failure from taking the language service down                 |
| `plugin.ts`      | the language service proxy: `getDefinitionAndBoundSpan`, `getDefinitionAtPosition`, `getQuickInfoAtPosition`, and the route table cache |
| `routeTable.ts`  | walks the router tree into `path → handler location`                                                                                    |
| `routePath.ts`   | value-level mirrors of the template literal types that build RPC keys                                                                   |
| `entryPoints.ts` | finds the routers, by reading the `RPC` / `ViewRPC` interfaces                                                                          |
| `callSite.ts`    | decides whether a string literal is naming a route, and what narrows it                                                                 |
| `lookup.ts`      | matches a call site against the table                                                                                                   |

The route table is built once and reused until one of the files it was derived
from changes, so typing in a component does not rebuild it. On the
`saas-starter` template it is 26 API paths and 21 view paths, walked from 34
files, in about 2ms.

## Tests

```
bun --bun vitest run ide/typescript-plugin
```

Four files, in rough order of how much they would catch:

- **`rpcParity.test.ts`** is the one that matters. The walker's key set has to be
  character-identical to `keyof RPC`, because the string being looked up was
  typed by a developer whose autocomplete came from `CreateRPC` — and nothing
  else enforces that, since the two live in different languages. So it asks the
  checker for `keyof RPC` over the _same fixture_ the walker reads and requires
  the sets to be equal. A route shape added to `ApiRouter` fails here until the
  walker learns it.
- **`plugin.test.ts`** drives a real `LanguageService` through
  `decorateLanguageService`: spans, definitions, hover, delegation, cache reuse.
- **`routeTable.test.ts`** pins where each jump lands, down to the line.
- **`routePath.test.ts`** pins the path-composition transcription, quirks
  included — `/(app)/` joined to `/(admin)/users` really does produce
  `///users`, and matching the type matters more than being right.

`fixture.ts` and `testProject.ts` are the shared harness: an in-memory project
with `gemi/*` mapped at the package source, so the tests run against the real
`ApiRouter` and the real `useQuery`.

Typecheck with `bun run typecheck`, which covers this directory through its own
`tsconfig.json` — see the comment in it for why it is not part of the package's.

Build with `bun run build:ts-plugin`. See `WHY-PACKAGE-JSON.md` for how tsserver
finds the result.
