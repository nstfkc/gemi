# MCP Server

An `McpRouter` exposes API routes as [Model Context Protocol](https://modelcontextprotocol.io) tools. Each tool is a route: a call is dispatched through the route's own middleware as the calling user, so a tool can never do what that user could not do with a direct request. The router's design (addressing, params, files, results) is in the [McpRouter RFC](https://github.com/nstfkc/gemi/blob/main/packages/gemi/rfc/mcp-router.md).

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
- **`maxBodyBytes`**, **`server`** (`name`, `version`, `instructions`), **`nonces`**, **`approvalTimeoutMs`**: see below.
- **`files`**: how remote callers send files (below).

The endpoint is answered ahead of routing, after the global middleware, so no route can shadow it.

### Who the caller is

A resolver verifies the credential and answers a principal: `{ user, via, id, scopes }`. Every tool call is dispatched with that `user` on the request context, exactly as if they had signed in, and with nothing else from the client's request: no cookie, and never the bearer token. Route middleware (`auth`, policies, `rate-limit`) decides as it does for the user's own requests. `req.mcpGrant()` answers `{ via, id, scopes, clientId? }` on such a request (and `null` otherwise), for a route that wants a scope check of its own.

`McpApiKeyResolver` handles keys the app issued: a user creates one in the app's settings and pastes it into a client as a bearer token. `McpApiKeyResolver.generate(prefix)` makes a key (show it once), `McpApiKeyResolver.hash(key)` is what to store and look up by. The prefix is required, so a token that is not one of your keys is never looked up, and it makes a leaked key recognisable to secret scanners. A custom resolver implements `McpCallerResolver`; it must build the principal only from a credential it verified.

### OAuth: connecting Claude and other hosted clients

Hosted clients (Claude.ai and Claude Desktop connectors, ChatGPT) connect with OAuth: the user pastes the endpoint URL, signs in to your app in their browser, agrees, and the client gets a token. `McpOAuthServer` is the authorization server for that, and the resolver for its tokens:

```ts
// app/mcp/oauth.ts
import { McpOAuthServer } from "gemi/services";

export const mcpOAuth = new McpOAuthServer({
  store: new PrismaMcpOAuthStore(), // yours; see "The store" below
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

`McpOAuthStore` keeps clients, codes and tokens. `MemoryMcpOAuthStore` is for development and tests: it forgets everything on restart and is not shared between instances. In production, implement the interface on your database:

```prisma
model McpOAuthClient {
  clientId                String   @id
  clientSecretHash        String?
  tokenEndpointAuthMethod String
  redirectUris            String[]
  clientName              String?
  clientUri               String?
  createdAt               DateTime @default(now())
}

model McpOAuthCredential {
  hash        String   @id // SHA-256 of a code or token; never the value
  kind        String   // "code" | "access" | "refresh"
  clientId    String
  userId      String
  scopes      String[]
  resource    String
  familyId    String
  redirectUri String?
  codeChallenge String?
  expiresAt   DateTime
  revokedAt   DateTime?

  @@index([familyId])
  @@index([userId])
}

model McpOAuthUse {
  key       String   @id // a code's or refresh token's hash, or a consent decision's nonce
  expiresAt DateTime
}
```

- `use(key, expiresAt)` must be atomic across instances: insert `{ key, expiresAt }` into `McpOAuthUse` and answer `true` if the insert went in, `false` on a unique-key conflict. Delete rows past `expiresAt` from time to time.
- `findCode` and `findToken` answer `null` for a revoked family.
- `revokeFamily(familyId)` marks every row of the family revoked. A family is one user's grant to one client, which is what a "Connected apps" screen in your settings lists (by `userId`) and revokes.

### Scopes: which tools a caller sees

`McpRouter.scopes` maps scope names to tools by `tags` and by `names`. A remote caller lists and calls only the tools its scopes reach; any other tool answers as if it did not exist. A router without `scopes` has a single scope, `"mcp"`, that reaches every tool.

### Approval

A tool with `requiresApproval: true` asks the user before it runs, through the client's elicitation (a form with one `approve` checkbox). With a 2026-07-28 client the call answers `input_required` and the client retries with the answer; the retry is signed, bound to the credential, the tool and its exact arguments, expires in ten minutes, and is accepted once. With an older client the question goes over the call's response stream. A client that cannot elicit cannot call the tool, and a declined approval answers an error result; the route never runs.

The one-time approvals are remembered in `nonces`, in this process by default. With more than one instance, pass a shared store (`RedisNonceStore` from `gemi/ai`). Older clients' approvals wait on the instance that asked, so they need sticky routing per session; without it the answer reaches another instance and the call fails closed.

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
