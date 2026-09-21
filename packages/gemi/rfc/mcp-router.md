# RFC: `McpRouter` — exposing API routes as MCP tools

Status: draft
Author: Enes Tufekci
Date: 2026-09-06
Updated: 2026-09-21 — "Files" rewritten against the attachment store that landed in #491–#493

## Summary

A gemi app declares which of its existing API routes a model may call, in one
file, by referencing them:

```ts
// app/http/routes/mcp.ts
export default class extends McpRouter {
  routes = {
    "/create-product": this.fromApiRoute("POST", "/:orgId/products", {
      description: "Create a product for an organization",
      input: s.object({ name: s.string(), price: s.number() }),
      params: { orgId: (req) => req.ctx().user.orgId },
    }),
  };
}
```

The framework turns this file into a tool registry with two consumers — an
agent running in the same server (v1) and a remote MCP client over HTTP (v2) —
and services every call by building a synthetic `Request` and handing it to the
existing `ApiRouteDispatcher`. Middleware, auth, policies, input validation
and error shaping all run exactly as they do for an HTTP client, because it _is_
an HTTP request by the time it reaches the route.

## Motivation

An MCP tool and an API route are the same thing described twice: a name, an
input schema, an output shape, and a side effect. An app that wants both writes
the second one by hand and keeps it in sync forever. gemi already owns the
route table, the input schemas (`HttpRequest.schema`), the JSON Schema builder
(`ai/Schema.ts`) and the middleware stack, so it can generate the MCP surface
instead — and, more importantly, guarantee that a tool call and an HTTP call to
the same route are subject to the same guards.

## The addressing decision

`this.fromApiRoute("POST", "/:orgId/products", …)` takes the method and the url
as **two arguments**, not as the concatenated `"POST:/:orgId/products"`.

`` `${Method}:${Path}` `` is real — it is how `RouteHandlerParser` keys the RPC
type (`http/ApiRouter.ts:484`) — but it is _internal_. No app author types it
today: `useQuery("/health")` strips the verb (`client/useQuery.ts:85`) and
`useMutation("POST", "/products")` splits it (`client/useMutation.ts:88-98`).
`fromApiRoute` follows `useMutation`, which is the closest existing thing.

Splitting also types better, over the same `Methods[M][K]` machinery
`useMutation` already declares. Verified against a real `this.resource()` +
nested router:

| written                        | compiler says                               |
| ------------------------------ | ------------------------------------------- |
| `"/:orgId/prodcuts"`           | not assignable to `"/:orgId/products"`      |
| `"DELETE", "/:orgId/products"` | not assignable to `"/:orgId/products/:id"`  |
| `input: s.object({ title })`   | not assignable to `Schema<{ name; price }>` |

So: the url autocompletes from the app's own routes, a renamed or unmounted
route breaks the build rather than `tools/call`, and the declared schema is
checked against the handler's actual input type. Output is inferable the same way should
`outputSchema` land in v2, which no controller-side annotation can reach.

## Why not decorators on the controller

The first sketch was `@Mcp({...})` on a controller method. It works — standard
decorators compile and emit under all three of tsc 5.9, Bun 1.3.14 and Vite 8.1
with the repo's `target: ES2022`, and a method decorator _can_ typecheck the
schema against the handler's request type — but three things argue against it:

1. **Path params belong to the exposure, not the method.** `/:orgId/products`
   has an `orgId` that must almost always come from the session, not from the
   model; letting a model pass an arbitrary `orgId` is a tenant-isolation bug.
   A controller decorator cannot express "bound from auth" because the
   controller does not know the path.
2. **A route can be mounted more than once** — publicly and under `/admin` —
   and only one mount should be exposed.
3. **Cost of entry.** Bun does not implement `Symbol.metadata`, so metadata
   needs a polyfill loaded before any decorated class; `ctx.metadata`
   prototype-chains from the base class, so a naive write leaks a subclass's
   tools onto its parent; and typing it needs `esnext.decorators` in `lib`.

A separate file also answers "what can a model do in this app?" by being read,
which is the review question that matters here.

The cost is that the description lives away from the handler and the route is
named twice. Typed, so drift is a build failure rather than a silent one.

## Design

### `fromApiRoute(method, url, meta)`

```ts
type Meta<M, K> = {
  /** The only prose the model gets. Required. */
  description: string;
  /** Checked against the route's request body type, minus its binary fields —
   *  those are declared in `files`, and a `"input"` one is added back to the
   *  tool's schema as a string (an attachment id) when the list is emitted. */
  input?: Schema<Omit<BodyOf<M, K>, BinaryKeys<BodyOf<M, K>>>>;
  /** v2. Checked against the route's return type; emitted as `outputSchema`.
   *  Typed here to show the shape is reachable — not implemented in v1. */
  output?: Schema<Awaited<DataOf<M, K>>>;
  /** Per-param: bound from the request, or supplied by the model. */
  params?: { [P in keyof ParseParams<K>]: ((req: HttpRequest) => string) | "input" };
  /** Required for every `Blob`/`File` field of the body, and rejected when
   *  there are none. Same two modes as `params`. See "Files" below. */
  files?: Record<BinaryKeys<BodyOf<M, K>>, ((ctx: ToolContext) => string) | "input">;
  /** Grouping/filtering, mirroring `AgentTool` groups. */
  tags?: string[];
  /** Defaults to the key of `routes`. */
  name?: string;
};
```

`ParseParams`/`UrlParser` already exist (`client/useMutation.ts:81`) and extract
`:params` from the url _type_, so a param that is neither bound nor declared
`"input"` is a compile error rather than a runtime 404.

### Files: by scoped attachment reference

MCP tool arguments are JSON, and an `AgentTool`'s arguments are equally JSON, so
bytes never travel as a tool argument. A model cannot supply them anyway: it
_saw_ the image, it cannot reproduce it. What travels is a reference, and the
adapter rehydrates it.

The store this needs landed in #491–#493 (`ai/store/Attachments.ts`), so this
section describes the MCP adapter against code that exists rather than a plan.

**Worked case.** The user uploads an image in the chat and asks the agent to
create a product; `POST /:orgId/products` expects multipart with the image.

1. `POST /chat/files` (`AgentController.upload`) keeps the bytes in the app's
   own storage _and_ uploads them to the provider, and answers
   `{ fileId, attachmentId, name, mimeType, size, destination }`. `fileId` is
   the provider's and goes into the message history, so vision is unchanged;
   `attachmentId` (`gemi_att_…`) is gemi's and is the only id a tool argument
   may carry.
2. The model calls the tool with `{ name, price, image: "gemi_att_7f3…" }`.
3. The adapter calls `ctx.attachments.file(id)`, which answers a `File` under
   the name and type it was uploaded with, appends it to a `FormData`, and
   dispatches. The product route receives a genuine multipart request and its
   `file` rules run untouched (`http/HttpRequest.ts:260-269`). The route is
   neither modified nor duplicated, and cannot tell a model was involved.

**The adapter never reads from the provider.** The fan-out happens at upload
time, not at tool-call time:

```
POST /chat/files
   |-> attachmentStorage.put(file)   -> attachmentId   <- the tool path reads this
   \-> provider.upload(file)         -> fileId         <- message history, for vision

tools/call { image: "gemi_att_7f3…" }
   \-> ctx.attachments.file(id)      -> File -> FormData -> handleApiRequest
```

Pulling the bytes back from the provider was rejected: `AgentProvider` declares
only `upload`, retrieval varies by vendor, it is a round trip for bytes the
server held minutes ago, and retention is the vendor's to decide.

**Where each file goes is already per file.** `attachmentDestination(file, req)`
answers `"both"` (the default), `"provider"` or `"storage"`, and a client may
narrow `"both"` to `"storage"` per upload and nothing else. A CSV to be imported
through a tool can therefore stay off the provider. A `"provider"` upload mints
no `attachmentId`, so it can never be a tool argument — the MCP layer need not
handle that case, only report it.

**Resolution is scoped to the caller, and the adapter inherits that for free.**
The id arrives from the model, so it is as untrusted as a request body. The
store has no unscoped lookup at all: `AttachmentStore.find(scope, id)` only, and
a tool is handed `ctx.attachments`, a `ToolAttachments` closed over the scope
`AgentController.attachmentScope()` derived from the request (`user:<id>`, else
`thread:<id>`, else none). None of its methods takes a scope, and it checks the
record's `scopeKey` a second time in case an app's store forgot the `WHERE`
clause. An id from another tenant fails as `AttachmentNotFoundError`, worded
exactly like an invented one.

The one rule for the MCP adapter, then: **resolve files through
`ctx.attachments` and nothing else.** Reaching for `AgentController.attachments`
or the storage driver directly would be the unscoped read this store was built
not to have.

**Declaration is required, in the same two modes as `params`.**

```ts
this.fromApiRoute("POST", "/:orgId/products", {
  description: "Create a product for an organization",
  input: s.object({ name: s.string(), price: s.number() }),
  params: { orgId: (req) => req.ctx().user.orgId },
  files: { image: "input" }, // model names an attachment id
  // or:  { image: (ctx) => ... },     // bound; model has no say — see gap 2
});
```

Verified at the type level: a body with `image: File` and no `files` is an
error, a `files` key that is not a binary field is an error, and `files` on a
JSON-only route is an error. The check reads the body type, since the `file`
rules themselves live on the request class — a default parameter value inside
the method body, not reachable from the route table.

**Two gaps remain between the store and this adapter.** Both are in `gemi/ai`,
both are small, and v1 of the MCP router cannot ship file-taking tools until
the first one is closed.

1. **The model never learns a user upload's `attachmentId`.** `ClientTurn.files`
   (`ai/types.ts:356`) carries `{ fileId, name, mimeType }` only, the run builds
   the user message from those three fields (`ai/Agent.ts:2873`), and
   `FilePart.attachmentId` is never sent to the provider. So in the worked case
   the model has seen the image and has no id to put in `image` — it will
   invent one, and the call fails with `AttachmentNotFoundError`. A
   `"storage"`-only upload is worse off: it has no `fileId`, so it cannot be in
   a turn at all (`request.ts` refuses an empty `FilePart.fileId`), and the
   model does not know it exists.

   The fix is to carry `attachmentId` through `ClientTurn.files` onto the
   `FilePart`, and render it to the model as a short text line beside the file
   (`[attachment gemi_att_7f3… product.png image/png]`) — a text line alone for
   a storage-only upload. The id being client-supplied is fine: resolution is
   scoped, so a client naming someone else's id gets a not-found.

2. **Bound mode has nothing to bind to.** `ToolAttachments` has `put`, `get`,
   `read` and `file`, all by id; there is no "the files of this turn", so a
   binder like `(ctx) => ctx.attachments.only()` has nothing to call. Gap 1's fix puts the
   ids on the user message, so a bound resolver can read them off the run's
   latest user turn — but that needs an accessor on `ToolContext`, which is an
   `ai` API decision, not an MCP one.

**Attachments flowing outward are done, and are not MCP work.** A tool that
_produces_ a file calls `ctx.attachments.put(blob, { showModel: true })` (#490):
the bytes are stored under the caller's scope, uploaded to the provider, and put
in front of the model as an input-role message once the call settles; `put` is
memoized per tool call so a re-entered tool does not store or upload twice, and
only the most recent tool-produced file stays in the provider context. Its
record's `id` is an ordinary `attachmentId`, so a file one tool produced can be
the `"input"` of the next MCP tool without either knowing about the other.

**Still excluded in v1:** inline base64 (`s.file()` with `contentEncoding`,
which would push `ai/Schema.ts` outside the strict-structured-output subset it
was written for) and adapter-side URL fetching (an SSRF surface). Neither is
needed while every caller is local; both are v2 candidates once a remote client
has bytes of its own.

### Two callers, one registry

The MCP surface has two consumers, and they are different enough that the
design has to name them:

- **Local.** An agent running in this same server — a gemi `Agent`, usually
  behind an `AgentController`. It has no need of a socket, a session id or a
  token. It needs the tool list as `AgentTool`s and a way to invoke one.
- **Remote.** An MCP client over HTTP, authenticating with a bearer token.
  **Out of scope for v1**, but the v1 seams must not stand in its way.

What makes this cheap is that `AgentTool` (`ai/Agent.ts:335`) already has the
shape a tool descriptor needs — `{ name, description, inputSchema, execute }`.
So the registry does not emit MCP JSON _or_ agent tools; it emits neutral
descriptors, and each caller projects:

```
McpRouter  →  descriptors  →  AgentTool[]        (local, v1)
                          →  tools/list JSON     (remote, v2)
```

Both projections invoke the same way: build a `Request` and call
`ApiRouteDispatcher.handleApiRequest(req)`
(`services/router/ApiRouteDispatcher.ts:198`), which already takes a plain
`Request`. "Local" means no socket, not a second execution path — middleware,
policies and validation run identically for both callers.

A `ValidationError` becomes a tool error the model can see and correct
(`isError: true` on the remote side), not a protocol error.

### Identity, and the seam v2 needs

**Identity is a parameter of the call, never read from ambient state.** This is
the single decision that keeps v2 unblocked, and it costs nothing in v1.

For the local caller the identity is already in hand: `ToolContext.req`
(`ai/Agent.ts:56`) is the request that started the agent run, and its session
is the user the run belongs to. The synthetic request copies that request's
credentials, so a tool call runs **as the user who started the run**. That is
both the useful behaviour and the safe one: running tools as a service identity
would make a prompt-injected model a confused deputy with reach across tenants.

So the adapter signature takes the principal explicitly:

```ts
type McpCaller =
  | { kind: "local"; req: HttpRequest } // v1 — inherit the run's user
  | { kind: "remote"; token: string }; // v2 — resolved to a session
```

v1 implements only `local`. v2 implements `remote` by writing one resolver,
touching neither discovery, nor schema generation, nor the dispatch adapter.

Concretely, five things v1 must **not** do, because each would have to be
unpicked for v2:

1. Reach for `RequestContext.getStore()` inside the adapter. A remote call
   arrives with no ambient gemi request; the synthetic request has to be
   self-sufficient.
2. Let the registry emit `AgentTool`s as its native output. Reversing JSON
   Schema back out of them for `tools/list` is work that need never exist.
3. Hardcode "every tool is visible". `list(caller, filter?)` takes a filter from
   day one even though v1 always passes none — v2 scopes visibility per token,
   and by `tags`.
4. Put session state in the registry. `Mcp-Session-Id` belongs to the transport,
   which v1 does not have.
5. Derive tool names by any rule other than the `routes` key. Remote clients
   will hardcode these names; the key is the contract, and changing the
   derivation later breaks them silently.

One more that is nearly free now and expensive later: MCP tool **annotations**
(`readOnlyHint`, `destructiveHint`, `idempotentHint`) drive confirmation
prompts in remote clients. The HTTP verb already implies sensible defaults —
GET is read-only, DELETE is destructive — so populate them from the verb in v1
rather than making every app revisit its MCP file when v2 lands.

### No remote surface in v1

Remote access is **prohibited until bearer auth lands**, and the way to prohibit
it is to not mount it: v1 ships no MCP HTTP endpoint at all. Nothing to reach,
nothing to guard, no JSON-RPC framing, no `Mcp-Session-Id`, no SSE. v1 is the
registry plus the `AgentTool` projection, and the whole transport arrives with
v2 alongside the auth that makes it safe.

If the transport is developed ahead of the auth, it must be behind a config flag
that defaults off, and the boot should refuse to enable it without a token
resolver configured — a half-built MCP endpoint reachable in production is
precisely the thing this section exists to prevent.

### The invariant

**A tool call must never be able to do something the same caller could not do
with a direct HTTP request.** Endpoints already carry their own authentication;
the MCP layer adds none and, more to the point, must not subtract any.

Two concrete ways an implementation could break this, both worth naming because
both look like reasonable shortcuts:

1. **Calling `exec` directly.** Flat route entries expose a bound `exec`
   (`services/router/createFlatApiRoutes.ts`), and invoking it runs the handler
   _without_ `runRouteMiddleware` — no auth, no policies, no rate limit. It is
   the shorter path and it is the wrong one. The adapter goes through
   `ApiRouteDispatcher.handleApiRequest` (`ApiRouteDispatcher.ts:198`), which
   runs middleware before the handler, and this should be asserted by a test
   that exposes a route guarded by `auth` and calls it as an anonymous local
   caller expecting a rejection.
2. **Synthesising credentials.** The synthetic request copies the initiating
   request's credentials and nothing more. It never mints a session, and never
   carries a service identity.

Because of the invariant, exposing a route through `McpRouter` grants no
authority by itself. What it grants is _reachability by a model_ — which is a
real decision, since the model chooses the arguments and may be adversarially
steered — but not privilege.

Dispatch happens under the route's real path rather than a `/__gemi__` one, so
the `onRequestStart` / `onRequestEnd` hooks fire normally and model-originated
traffic shows up in an app's logging. Marking those requests so an app can
_tell_ them apart is worth doing in v1.

## Changes to existing code

- `RouteHandler`: expose `handler` and `methodName` (currently `private`,
  `http/ApiRouter.ts:45`).
- `createFlatApiRoutes`: carry `source: { controller, methodName }` onto each
  entry. Measured on a patched copy: three lines of type, a five-line helper,
  and `sourceOf(routeHandler)` threaded through the five existing `addRoute`
  calls. Resource routes, nested routers, prefixing and middleware inheritance
  then need no special handling — verified end to end.
- `gemi.d.ts`: augment an `McpRoutes` interface the way `RPC` is augmented, so
  an app's MCP file resolves against its own routes.
- `ClientTurn.files` / the run's user message: carry `attachmentId` onto the
  `FilePart` and show it to the model as text — gap 1 under "Files". The
  attachment store itself (#491–#493) is already in place.
- New: `http/McpRouter.ts`, an `McpServiceProvider`, the descriptor registry,
  and the two projections (`AgentTool[]`
  for v1, `tools/list` JSON for v2).

## Scope

Settled:

|                                 | v1                             | v2                        |
| ------------------------------- | ------------------------------ | ------------------------- |
| Local caller (in-process agent) | yes                            | —                         |
| Remote caller over HTTP         | prohibited — not mounted       | bearer token              |
| Transport                       | none shipped                   | HTTP only — no stdio      |
| `output` / `outputSchema`       | out of scope                   | candidate                 |
| `fromResource` expander         | not needed                     | not needed                |
| File arguments                  | by scoped attachment reference | + base64 / URL for remote |

Out of scope for v1 and deliberately unblocked, not merely deferred: the HTTP
transport, bearer auth, per-token tool visibility, and MCP session handling. The
seam that keeps them cheap is the explicit `McpCaller` above — v1 exercises only
its `local` arm, but the arm exists.

This makes v1 substantially smaller than it first looked: no protocol layer at
all. The work is the registry, the typed `fromApiRoute`, the request synthesis,
and the `AgentTool` projection.

Still open:

1. **What marks a model-originated request** so an app can distinguish it in
   `onRequestStart` — a header on the synthetic request, or a flag on the
   request context. The context flag is harder to spoof, since a header on a
   _real_ inbound request could claim it.
2. **Whether `params` binding functions receive the caller** or only the
   request. For the local caller they are the same thing; for v2 they are not,
   and a binding like `orgId: (req) => req.ctx().user.orgId` has to keep
   working when the "request" is synthesised from a token.
3. **Rate limiting.** `RateLimitMiddleware` keys on the request; a local tool
   call inherits the user's request, so an agent loop could exhaust a human's
   budget. Whether that is correct or surprising is a product call.
4. **Bound or `"input"` as the default for `files`.** Bound is safer, since
   the model names nothing, but it depends on gap 2, and `"input"` is the only
   mode that works for a turn carrying several attachments. `"input"` is safe
   enough on its own because resolution is scoped.

## Alternatives considered

- **`@Mcp` decorator on controller methods.** See above. Viable, and better
  colocated, but cannot express param binding or per-mount exposure.
- **Fluent `.mcp()` on the route.** `this.post(C, "m").mcp({...})` knows the
  path and types well, but degrades badly on `this.resource()`, where one call
  mounts five routes and the config becomes a five-key block restating the
  controller.
- **Generating tools from every route automatically.** Rejected: exposure to a
  model is a security decision and must be written down, not inferred.
