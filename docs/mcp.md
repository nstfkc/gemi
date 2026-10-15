# MCP Server

An `McpRouter` exposes API routes as [Model Context Protocol](https://modelcontextprotocol.io) tools, beside [native tools](#native-tools) the app registers itself. Each route tool is a route: a call is dispatched through the route's own middleware as the calling user, so a tool can never do what that user could not do with a direct request. The router's design (addressing, params, files, results) is in the [McpRouter RFC](https://github.com/nstfkc/gemi/blob/main/packages/gemi/rfc/mcp-router.md).

The same tools serve two kinds of caller:

- **Local**: the app's own agents, through the `AgentTool` projection. Nothing to configure beyond the router.
- **Remote**: an external MCP client (Claude.ai and Claude Desktop connectors, Claude Code, the MCP Inspector, the TypeScript SDK) over Streamable HTTP. It is off by default; this page is mostly about turning it on safely.

```ts
// app/http/McpRouter.ts
import { McpRouter } from "gemi/http";

export class AppMcpRouter extends McpRouter<RPC> {
  scopes = {
    "site:read": { description: "Read your site", tags: ["read"] },
    "site:write": { description: "Edit your site", tags: ["write"] },
  };

  routes = {
    "list-pages": this.fromApiRoute("GET", "/pages", { description: "List the site's pages", tags: ["read"] }),
    "delete-page": this.fromApiRoute("DELETE", "/pages/:id", {
      description: "Delete a page",
      params: { id: "input" },
      requiresApproval: true,
      tags: ["write"],
    }),
  };
}
```

## Tool metadata

`fromApiRoute`'s meta takes a `title` for a client to show and `annotations` that override the hints derived from the verb (GET is read-only, DELETE destructive, PUT idempotent), hint by hint:

```ts
"cancel-order": this.fromApiRoute("POST", "/orders/:id/cancel", {
  description: "Cancel an order",
  title: "Cancel order",
  params: { id: "input" },
  annotations: { destructiveHint: true, idempotentHint: true },
}),
```

Hints are advice to the client, never a defence: authorization is the route's middleware.

### Behind a feature flag

`feature` offers a tool only while an [`app/features`](./feature-flags.md) flag is on for the request:

```ts
read_domain: this.fromApiRoute("GET", "/sites/:siteId/domain", {
  description: "The site's custom domain",
  feature: "custom-domains",
  params: { siteId: bindSite },
}),
```

- **Remote callers:** while it is off, `tools/list` leaves the tool out and `tools/call` answers `Unknown tool: read_domain`, the same answer as for a tool the caller's scopes do not reach. It is evaluated per request as the credential's user, so a feature's `when` can target users.
- **Local agents:** `toAgentTools` builds an agent's tools once, so a gated tool stays in the agent's list. A call to it while the feature is off is refused before the route runs, with an error the model reads: `There is no tool named "read_domain".`
- `await registry.available(caller, filter?)` is `list()` narrowed by features. `list()` and `descriptors()` do not apply them, and each descriptor's `feature` names its key.
- **`server.version` does not change** when a feature flips. Tools behind a `when` differ per user, so a version derived from what one caller sees would give two callers of the same server different versions. Clients get the change from `tools/list`, which modern clients cache privately for 60 seconds. If you derive `version` from your tool names, hash every declared tool (`registry.descriptors()`), not just the ones a caller sees.

## Native tools

Some operations are not one route: a tool that composes several routes, runs a model itself, or reports progress while it works. Register the `AgentTool` you already have with `fromTool`, and it is listed, filtered, scoped and projected beside the routes:

```ts
import { AgentTool, s } from "gemi/ai";
import { McpRouter } from "gemi/http";
import { McpRegistry, mcpCallOf } from "gemi/services";
import { app } from "gemi/foundation";

const buildPage = AgentTool.create({
  name: "buildPage",
  description: "Build a page from a prompt",
  inputSchema: s.object({ prompt: s.string() }),
  outputSchema: s.object({ path: s.string() }),
  async *execute({ prompt }, ctx) {
    yield { progress: 1, total: 2, message: "Drafting" };
    const call = mcpCallOf(ctx)!;
    // Runs the composed route as the same caller, held to its scopes when remote.
    const pages = await app(McpRegistry).execute(call.caller, "list-pages", {}, ctx);
    const draft = await ctx.generate({ provider, instructions: "...", prompt, output: pageSchema });
    // ...
    return { path: "/new" };
  },
});

export class AppMcpRouter extends McpRouter<RPC> {
  routes = {
    "list-pages": this.fromApiRoute("GET", "/pages", { description: "List the site's pages", tags: ["read"] }),
    "build-page": this.fromTool(buildPage, {
      tags: ["write"],
      title: "Build a page",
      // Without `remote`, only the app's own agents get the tool.
      remote: {
        context: ({ caller }) => ({ userId: caller.req.ctx().user.id }),
      },
    }),
  };
}
```

- The `routes` key is the tool's name. The input and output schemas, `requiresApproval`, `timeoutMs` and `async` come from the tool. The meta can set `description` (overrides the tool's), `tags`, `title`, `annotations` (no verb defaults: only what you write) and `requiresApproval: true`. `false` on a tool that requires approval fails the boot. A tool whose `requiresApproval` is a function keeps deciding per call, for an agent in this server and for a remote client; the meta's `true` makes it ask every time instead (see [AI Tool Approvals](./ai-tool-approvals.md#through-the-mcp-registry)).
- The tool must be a server tool with a fixed `inputSchema`. A client tool, or one whose schema is resolved per run, fails the boot.
- **For the app's agents** (`toAgentTools`), the tool runs with the run's own `ToolContext`, as if the agent held it directly: its yields are `tool-progress`, `ctx.jobs` starts background jobs, and a `ToolError` reaches the model.
- **For a remote client**, the tool is listed and callable only when the meta has `remote`, and only for scopes that reach it. `requiresApproval` asks through the same elicitation as a route. The tool runs with a `ToolContext` built for the call: `context` is what `remote.context(call)` answers, `body` is `{}`, `runId` is fresh, there is no `threadId`, and `signal` aborts when the client cancels or the tool's `timeoutMs` passes. `ctx.generate` works. `ctx.attachments`, `generateImage`, `editImage`, `runAgent` and `jobs` throw a sentence saying a remote call has none, because there is no run, thread or attachment store behind it.
- Yields become `notifications/progress`. A yield with a numeric `progress` is sent as it is, a string as the message, and anything else as one step. `remote.progress(value, n)` maps each yield yourself (answer `undefined` to skip one).
- **A native tool is its own authorization.** A route tool goes through the route's middleware, but a native tool runs its own code, so it can do whatever that code does. Before you add `remote`, make sure the tool (or `remote.context`) checks what the caller may do. `call.caller.principal` holds the credential's user and scopes. A route the tool composes through `registry.execute(call.caller, ...)` is still dispatched through that route's middleware and held to the caller's scopes.
- A `ToolError` is an error result the model reads. Any other throw is logged and answered "failed on the server". When the tool has an `outputSchema`, its answer is parsed with it and sent as `structuredContent`.
- `mcpCallOf(ctx)` answers the call (caller, request, tool, input) inside a native tool called through the registry. It answers `undefined` when the agent holds the tool directly, or when the run was not started inside a request.

## Remote access

Enable the endpoint in `app/config/route.ts`, with at least one caller resolver:

```ts
import { McpApiKeyResolver } from "gemi/services";

export default {
  // api, view, ...
  mcp: {
    router: AppMcpRouter,
    remote: {
      enabled: process.env.MCP_REMOTE === "1",
      url: "https://example.com/mcp",
      resolvers: [
        new McpApiKeyResolver({
          prefix: "ex_mcp_",
          verify: async (key) => {
            const row = await ApiKey.findFirst({
              where: { hash: McpApiKeyResolver.hash(key), revokedAt: null },
              include: { user: true },
            });
            return row && { user: row.user, id: row.publicId, scopes: row.scopes };
          },
        }),
      ],
    },
  },
};
```

- **`enabled`** must be `true` (a boolean) for anything to be mounted.
- **`url`** is the endpoint's canonical URL: its path is where it is served, its host is the only host it answers on, and it is the OAuth `resource` tokens are issued for. `https`, or `http` on `localhost`. No query, fragment or trailing slash, and not `/`.
- **`resolvers`** turn the request's credential into a user. The boot is refused without one, and without `SECRET` (the transport signs what it hands clients).
- **`allowedOrigins`**: browser origins allowed besides the endpoint's own (a web-based inspector, say). Requests with any other `Origin` get 403. Non-browser clients send none and are not affected.
- **`rateLimit`**: each credential's budget at the endpoint, default `{ limit: 600, window: 60 }` requests; `false` turns it off.
- **`maxBodyBytes`**, **`server`** (`name`, `version`, `instructions`), **`nonces`**, **`approvalTimeoutMs`**, **`onCall`** (an audit hook): see below.
- **`files`**: how remote callers send files (below).
- **`feature`**: serves the endpoint only while this [feature](./feature-flags.md) is on (below).

The endpoint is answered ahead of routing, after the global middleware, so no route can shadow it.

### Switching it with a feature flag

`enabled` is read once at boot. To turn the endpoint on and off without a deploy, keep `enabled: true` and add `feature`:

```ts
remote: {
  enabled: true,
  feature: "mcp-remote", // defineFeature({ serverOnly: true }) in app/features
  url: "https://example.com/mcp",
  resolvers: [oauth],
},
```

While the feature is off, the endpoint and its resolvers' endpoints (the OAuth metadata, client registration, authorize, consent, token and revoke) answer as they do with `enabled: false`: the request falls through to the app's routes, usually a 404. The boot still checks `url`, `resolvers` and `SECRET`, so switching the feature on never surfaces a configuration error.

The feature is evaluated only for paths the endpoint can own: its path, paths under it, and `/.well-known/...`. Other traffic never evaluates it. With `feature` set, a custom resolver's `handle()` is also only asked about those paths. The check runs before any credential is read, so there is no user to target. Use the feature as an on/off switch, and declare it `serverOnly` so it stays out of every page's payload.

### Who the caller is

A resolver verifies the credential and answers a principal: `{ user, via, id, scopes }`. Every tool call is dispatched with that `user` on the request context, exactly as if they had signed in, and with nothing else from the client's request: no cookie, and never the bearer token. Route middleware (`auth`, policies, `rate-limit`) decides as it does for the user's own requests. `req.mcpGrant()` answers `{ via, id, scopes, clientId? }` on such a request (and `null` otherwise), for a route that wants a scope check of its own.

`McpApiKeyResolver` handles keys the app issued: a user creates one in the app's settings and pastes it into a client as a bearer token. `McpApiKeyResolver.generate(prefix)` makes a key (show it once), `McpApiKeyResolver.hash(key)` is what to store and look up by. The prefix is required, so a token that is not one of your keys is never looked up, and it makes a leaked key recognisable to secret scanners. A custom resolver implements `McpCallerResolver`; it must build the principal only from a credential it verified.

### OAuth: connecting Claude and other hosted clients

Hosted clients (Claude.ai and Claude Desktop connectors, ChatGPT) connect with OAuth: the user pastes the endpoint URL, signs in to your app in their browser, agrees, and the client gets a token. `McpOAuthServer` is the authorization server for that, and the resolver for its tokens:

```ts
// app/mcp/oauth.ts
import { McpOAuthServer, PrismaMcpOAuthStore } from "gemi/services";
import { McpOAuthClient, McpOAuthCredential, McpOAuthUse } from "@/app/models";

export const mcpOAuthStore = new PrismaMcpOAuthStore({
  clients: McpOAuthClient,
  credentials: McpOAuthCredential,
  uses: McpOAuthUse,
}); // see "The store" below

export const mcpOAuth = new McpOAuthServer({
  store: mcpOAuthStore,
  findUser: (id) => User.findUnique({ where: { id: Number(id) } }),
  consentPath: "/oauth/consent", // optional: your own consent view
});

// app/config/route.ts
mcp: {
  router: AppMcpRouter,
  remote: { enabled: true, url: "https://example.com/mcp", resolvers: [mcpOAuth, apiKeys] },
},
```

What it serves, on the endpoint's host only:

| Path | What |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | Protected resource metadata (RFC 9728). A 401 from the endpoint points here. |
| `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414). The issuer is the endpoint's origin. |
| `/mcp/oauth/register` | Dynamic client registration (RFC 7591). |
| `/mcp/oauth/authorize` | Authorization code + PKCE (S256 only). |
| `/mcp/oauth/consent` | gemi's own consent page (GET), and where the decision is posted (POST). |
| `/mcp/oauth/token` | Code and refresh token exchange. |
| `/mcp/oauth/revoke` | Revocation (RFC 7009). |

The endpoints sit under the MCP endpoint's path (`<path>/oauth/...`), so they cannot collide with your routes, and are answered before routing.

- **Tokens** are opaque (`gmcp_at_…`, `gmcp_rt_…`), stored as their SHA-256, and bound to the endpoint's URL as their audience (RFC 8707): a token issued for another resource is refused. Access tokens live an hour (`accessTokenTtl`), refresh tokens 30 days (`refreshTokenTtl`) and rotate on every use. A refresh token or a code used twice revokes the whole grant, since one of the two users is a thief.
- **`findUser(id)`** loads the token's user on every request, by `String(user.id)`, so a deleted user's tokens stop working and routes see current data. Return the same shape `req.ctx().user` has.
- **Scopes** are the router's `scopes`. A client that asks for none gets all of them; scopes the server does not know (`openid`, say) are dropped; a refresh can narrow the scopes but never widen them.
- **Registration** is open, as MCP clients expect, and limited to 20 per address per hour. Redirect URIs must be `https`, or `http` on a loopback address (whose port may vary, RFC 8252). `registration.allowRedirectUri(url)` narrows them further, for example to the clients you support; `registration: false` turns registration off. Client ID metadata documents are not supported yet (`client_id_metadata_document_supported: false`); every current client falls back to registration.
- **Refused credentials** are counted per address at the endpoint: 30 a minute, then 429.

#### Consent

The user agrees on a page served by your app, while signed in to it. Without `consentPath`, gemi serves a plain page: it sends a signed-out user to `auth.signInPath` (or `signInPath`) with `?redirect=` back to the consent page, which your sign-in must follow with a full page load. It names the user, the scopes with their descriptions, and the host the user will be sent to. That host is the one verified fact about the client. Its name is whatever it registered with, and the page says so.

With `consentPath`, the browser is sent to your view (put it behind `auth`, so sign-in comes back to it) as `/oauth/consent?request=…`. Ask the server what to show:

```ts
// in the view's data (behind "auth")
const consent = await mcpOAuth.consent(req.search.get("request"), req.ctx().user);
// null: expired or not valid; show an error and no form.
// Otherwise render consent.client.name (unverified), consent.client.redirectHost,
// consent.scopes and consent.user.label, and a form:
//   <form method="POST" action={consent.form.action}>
//     <input type="hidden" name="request" value={consent.form.fields.request} />
//     <input type="hidden" name="csrf" value={consent.form.fields.csrf} />
//     <button name="decision" value="deny">Deny</button>
//     <button name="decision" value="allow">Allow</button>
//   </form>
```

Serve the page with the headers in `CONSENT_PAGE_HEADERS` (from `gemi/services`), or at least `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. A consent page that can be framed can be clicked through an overlay.

The decision is accepted only from your own origin (`Origin`, or `Sec-Fetch-Site: same-origin`), only from the user the page was rendered for (the CSRF token is bound to them and to the request), only once, and within ten minutes. The code that comes back expires in two minutes and carries `iss` (RFC 9207).

#### The store

`McpOAuthStore` keeps clients, codes and tokens. `MemoryMcpOAuthStore` is for development and tests: it forgets everything on restart and is not shared between instances. In production use `PrismaMcpOAuthStore`, which keeps them in three tables of your database, shared by every instance. Add the models to `prisma/schema.prisma` and migrate:

```prisma
// Clients that registered themselves (Claude's connectors, ChatGPT, the Inspector).
model McpOAuthClient {
  clientId                String   @id
  clientSecretHash        String?
  tokenEndpointAuthMethod String
  redirectUris            String[]
  clientName              String?
  clientUri               String?
  createdAt               DateTime @default(now())
}

// Codes ("code"), access tokens ("access") and refresh tokens ("refresh"), by
// their SHA-256; never the value. A family is one user's grant to one client.
model McpOAuthCredential {
  hash          String    @id
  kind          String
  clientId      String
  userId        String // String(user.id)
  scopes        String[]
  resource      String
  familyId      String
  redirectUri   String?
  codeChallenge String?
  expiresAt     DateTime
  revokedAt     DateTime?
  createdAt     DateTime  @default(now())

  @@index([familyId])
  @@index([userId])
}

// Single-use keys spent: codes, refresh tokens, consent decisions, and the
// approvals of `store.nonces()`.
model McpOAuthUse {
  key       String   @id
  expiresAt DateTime
}
```

On MySQL or SQLite, which have no `String[]`, declare `redirectUris` and `scopes` as `Json`. The model and field names are what the store reads and writes; the tables may be `@@map`ped to other names.

Pass the models, as gemi ORM model classes or as a Prisma client's delegates:

```ts
new PrismaMcpOAuthStore({ clients: McpOAuthClient, credentials: McpOAuthCredential, uses: McpOAuthUse });
new PrismaMcpOAuthStore({ clients: prisma.mcpOAuthClient, credentials: prisma.mcpOAuthCredential, uses: prisma.mcpOAuthUse });
```

- **Single use.** A code, a refresh token and a consent decision are spent by inserting their key into `McpOAuthUse`: the primary key lets one insert in across every instance, so a code or refresh token used twice is caught (and its grant revoked) even when the two uses race on two servers.
- **Revocation.** Revoking a family stamps `revokedAt` on its rows, and a family with any revoked row is revoked, so a token saved after the revocation (a refresh racing it) is refused too.
- **`connectedApps(userId)`** answers the user's live grants, newest first, with the client's (unverified) name and the scopes, for a "Connected apps" screen. **`disconnect(userId, familyId)`** revokes one of them (`false` when it is not the user's). **`revokeUser(userId)`** revokes all of a user's grants, for example when they lose the role the tools need.
- **`prune()`** deletes codes and tokens a day after they expire and spent keys once they expire. Run it from a scheduled job, daily is plenty. A revoked family's revoked rows are kept while any of its rows has not expired, so pruning never brings a revoked grant back.
- **`nonces()`** is a `NonceStore` on the same `McpOAuthUse` table for `route.mcp.remote.nonces` (see [Approval](#approval)). Its keys carry a `nonce:` prefix.

Your own store implements the `McpOAuthStore` interface. `use(key, expiresAt)` must be atomic across instances: insert `{ key, expiresAt }` and answer `true` if the insert went in, `false` on a unique-key conflict. `findCode` and `findToken` answer `null` for a revoked family. `revokeFamily(familyId)` revokes every code and token of the family.

### Scopes: which tools a caller sees

`McpRouter.scopes` maps scope names to tools by `tags` and by `names`. A remote caller lists and calls only the tools its scopes reach; any other tool answers as if it did not exist. A router without `scopes` has a single scope, `"mcp"`, that reaches every tool.

### Approval

A tool with `requiresApproval: true` asks the user before it runs, through the client's elicitation (a form with one `approve` checkbox). With a 2026-07-28 client the call answers `input_required` and the client retries with the answer; the retry is signed, bound to the credential, the tool and its exact arguments, expires in ten minutes, and is accepted once. With an older client the question goes over the call's response stream. A client that cannot elicit cannot call the tool, and a declined approval answers an error result; the route never runs. A native tool whose `requiresApproval` is a function is asked only when the function answers `true` for the call; answered `false`, it runs without a question, for any client ([AI Tool Approvals](./ai-tool-approvals.md)).

The one-time approvals are remembered in `nonces`, in this process by default. With more than one instance, pass a shared store: `RedisNonceStore` from `gemi/ai`, or, without Redis, one on your database. `mcpOAuthStore.nonces()` keeps them in the OAuth store's `McpOAuthUse` table; `new PrismaNonceStore(model, { prefix })` from `gemi/ai` keeps them in any model with `key String @id` and `expiresAt DateTime`. Both spend a nonce by inserting it as the primary key, so two instances handed the same approval cannot both run it. Delete expired rows from time to time (`mcpOAuthStore.prune()`, or `nonces.prune()`).

```ts
remote: { /* ... */ resolvers: [mcpOAuth], nonces: mcpOAuthStore.nonces() },
```

 Older clients' approvals wait on the instance that asked, so they need sticky routing per session; without it the answer reaches another instance and the call fails closed.

### Progress and cancellation

A route reports progress with `req.reportProgress({ progress, total?, message? })`, which answers `false` when nobody is listening. When the client asked for progress, the response is a stream of `notifications/progress` followed by the result. When the client closes the stream or sends `notifications/cancelled`, the dispatched request's `signal` aborts.

### Files

A remote client has no attachment store, so a file input is `{ name, mimeType, data }` with base64 `data`, at most `files.maxBytes` (10 MiB by default). Fetching an `https` `url` instead is opt-in, and goes only through [`safeFetch`](./outbound-http.md):

```ts
remote: { /* ... */ files: { maxBytes: 5 * 1024 * 1024, fetchUrls: { allow: ["cdn.example.com"] } } },
```

Tools with a bound (non-`input`) file are not offered remotely.

### Errors

A `McpToolError` thrown by a route is the tool's answer: the client gets its message as an `isError` result, which the model can read and act on. Any other error answers a generic error result, and the details stay in the server log.

### Auditing calls

`onCall` is told about every remote tool call once it has been answered: the ones that ran, the ones that failed, and the ones that were refused. Use it for an audit log.

```ts
remote: {
  enabled: true,
  url: "https://example.com/mcp",
  resolvers: [mcpOAuth],
  onCall: async (call) => {
    await McpCallLog.create({
      data: {
        userId: call.user.id,
        clientId: call.clientId, // the OAuth client, or null for an API key
        credentialId: call.credentialId, // the OAuth grant (family) or the API key's id
        tool: call.tool,
        argumentKeys: Object.keys((call.arguments ?? {}) as object), // not the values
        outcome: call.outcome, // "ok" | "error" | "denied"
        reason: call.reason ?? null,
        durationMs: Math.round(call.durationMs),
      },
    });
  },
},
```

| Field | What |
|---|---|
| `user`, `via`, `credentialId`, `clientId`, `scopes` | Who called, from the resolver's principal. `credentialId` is the OAuth grant (one user's consent to one client) or the API key's id, never the secret. `clientId` is `null` for an API key. |
| `tool`, `arguments` | The tool's name and the arguments as the client sent them, file data included. Keep only what you need. |
| `outcome` | `ok`, `error` (invalid arguments, a `McpToolError`, a route that answered 4xx or 5xx, a timeout, a crash) or `denied`. |
| `reason` | For `denied`: `unknown-tool` (out of the credential's scopes, behind a feature that is off, or not there), `approval-declined`, `approval-unavailable` (the client cannot ask), `approval-invalid`, `approval-replayed`, `approval-required`, or `forbidden` (the route answered 401 or 403). |
| `message`, `status`, `error` | What the client was told, the route's error status, and, for an unexpected failure, what was thrown (logged; the client is only told the tool failed). |
| `approved` | Whether the user approved this call. |
| `durationMs` | How long the call took to answer. For a legacy client that includes the wait for the user's approval. |
| `req` | The endpoint's `HttpRequest`, for headers or `clientIp(req)`. |

- It is awaited before the answer is sent, and it never changes the answer: a hook that throws is logged and the call is answered as it would have been.
- A modern client's first call to a `requiresApproval` tool is answered `input_required` and is not reported. The retry carrying the user's answer is the call, and it is reported once. A user who never answers leaves no event.
- Only `tools/call` is reported. `tools/list`, and a request refused before it reaches a tool (no credential, an unknown method, a rate limit), are not.

### Protocol versions

The endpoint speaks both MCP eras on one URL: the stateless 2026-07-28 revision (`server/discover`, request metadata, `input_required`), and 2025-03-26 to 2025-11-25 (an `initialize` handshake and an `Mcp-Session-Id`). Legacy session ids are signed and bound to the credential that opened them, so nothing is stored per session and `DELETE` answers 405. `GET` (a standalone event stream) answers 405 too: the server sends nothing outside a call.

### Security notes

- The endpoint answers only on the configured host, which defeats DNS rebinding, and refuses foreign `Origin`s. Behind a proxy, the request must reach the app with the public `Host` (most proxies keep it); one that rewrites it to an internal name makes the endpoint answer nothing.
- Credentials are read from the `Authorization` header only: never the query string, never the session cookie, so a page the user visits cannot ride their browser session into the endpoint.
- Rate limits are keyed on the credential, at the endpoint and for routes' own `rate-limit` middleware, not on the address: every user of a hosted client shares its addresses.
- Tool annotations and descriptions are shown to models; do not put secrets in them.

### Trying it

```bash
npx @modelcontextprotocol/inspector
```

Choose "Streamable HTTP" and enter the endpoint URL. With an API key, add an `Authorization: Bearer <key>` header; with `McpOAuthServer`, use the Inspector's OAuth flow, which registers, sends you to the consent page and exchanges the code. In Claude Code: `claude mcp add --transport http example https://example.com/mcp --header "Authorization: Bearer <key>"`.
