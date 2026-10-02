# Unreleased

## `useQuery` aborts requests nobody renders; controllers get `req.signal` (#659)

**Behaviour change.** When the last mounted reader of a query variant lets go
of it (its `search`/`params` changed again before the answer landed, or it
unmounted), the request still on the wire is now aborted instead of running to
completion and landing in the cache. This covers the `keepPreviousData`
pending variant under suspense too. The abort is silent: no `error`, no
retry, cached data untouched. A variant another component still renders, and a
request no reader had mounted (a hover `prefetch()`), are never aborted.

What you may notice: going back to a variant whose request was aborted fetches
it again rather than finding it cached.

**New: `req.signal`** on `HttpRequest` is the incoming request's `AbortSignal`;
it fires when the client disconnects (and, during a server render, when the
page request does). Pass it to slow work such as model calls or upstream
`fetch`es so they stop early. No action required.

## `this.proxy(...)` takes `.middleware()` (#7)

A proxy route could not carry middleware of its own: `createFlatApiRoutes`
registered it with an empty list, so the only way to guard one was to move it
into a nested router with `middlewares = [...]`. It now has `.middleware()`
like every other route, run after the global list and the enclosing routers':

```ts
"/billing": this.proxy("http://billing.internal/api").middleware(["auth"]),
```

No existing route changes behaviour. **Check your `proxy()` routes:** one
without middleware is public and forwards the client's headers, cookies and
`Authorization` included, to its target.

## Breaking: `X-Forwarded-For` is no longer trusted by default; set `GEMI_TRUST_PROXY` behind a proxy (#8)

**Behaviour change.** `gemi start` used to pass a client-sent `X-Forwarded-For`
through to the app unchanged, and `clientIp` (the default rate-limit key) read
its left-most entry, which is the one the client writes. Any client could pick
its own rate-limit bucket. The production server now decides which address to
believe, leaves exactly one in `X-Forwarded-For`, and drops `X-Real-IP`:

| `GEMI_TRUST_PROXY` | client address |
| --- | --- |
| unset, `false`, `off`, `0` (default) | the socket's peer address; forwarding headers are discarded |
| `1`, `2`, … | the address the outermost of that many proxies was reached from (counted from the right of `X-Forwarded-For`) |
| `true` | `X-Forwarded-For` and `X-Real-IP` passed through as sent (the old behaviour) |

**Action required behind a proxy or load balancer** (Railway, Fly, a CDN): with
the default, every request appears to come from the proxy, so all clients share
one rate-limit budget. Set `GEMI_TRUST_PROXY` to the number of proxies in front
of the app: `1` for Railway alone, `2` for Cloudflare in front of Railway. Use
`true` only behind a proxy that overwrites `X-Forwarded-For` instead of
appending to it. Any other value fails the boot. `gemi dev` is unchanged.

## `EMAIL_DEBUG` records the envelope; sends use the filtered recipients (#672)

**`EMAIL_DEBUG=true` writes a JSON sidecar.** Next to each
`.debug/emails/<iso><subject>.html`, `Email.send` now writes
`<iso><subject>.json` with `to`, `cc`, `bcc`, `from`, `subject`, `headers`,
`attachments` (`{ filename, bytes }`, no contents), `scheduledAt`, `locale` and
`text`. The HTML path and contents are unchanged, so existing readers keep
working; a test can now read the sidecar to check who a mail went to. Readers
that list the directory and expect only `.html` files should filter by
extension.

**Subjects are sanitised in debug filenames.** `/`, `\` and control characters
become `_`, so `"Invoice 2026/10"` writes `…Invoice 2026_10.html` instead of a
subdirectory (or failing).

**The driver receives the filtered `to`.** `filterRecipients` used to only
decide whether to send: if it returned anything, the driver was handed the
original `to`, so a filter that dropped or rewrote some addresses had no effect
on the others. The driver now gets the list the filter returns, as the docs
always said. Check your `filterRecipients` if it was written to return a
placeholder (anything non-empty) rather than the real list.

## Breaking: refusals are objects `{ kind, message, status }` (#673)

**Breaking change.** Every refusal's `error` is now an object. Before, most were
bare strings with no status, so the client guards could only recognise the
framework's default messages: `throw new AuthorizationError("You cannot edit
this post")` was `"unknown"`, and apps compared strings.

| refusal | `error` before | `error` now |
| --- | --- | --- |
| `AuthenticationError` (401) | `"Authentication error"` | `{ kind: "authentication", message, status: 401 }` |
| `AuthorizationError` (401) | `"Not authorized"` or the custom message | `{ kind: "authorization", message, status: 401 }` |
| `InsufficientPermissionsError` (403) | `"Insufficient permissions"` or the custom message | `{ kind: "permission", message, status: 403 }` |
| `InvalidCSRFTokenError` (403) | `"Invalid CSRF token"` | `{ kind: "csrf", message, status: 403 }` |
| unhandled 500 | `"Internal Server Error"` (the exception's message under `gemi dev`) | `{ kind: "server_error", message, status: 500 }` |
| policy denial (403) | `{ message: "Forbidden" }` | `{ kind: "permission", message: "Forbidden", status: 403 }` |
| not found (404) | `{ message: "Not found" }` | `{ kind: "not_found", message: "Not found", status: 404 }` |
| range (416) | `{ message: "Range not satisfiable" }` | `{ kind: "range_not_satisfiable", message, status: 416 }` |
| rate limit (429) | `{ message: "Rate limit exceeded" }` | `{ kind: "rate_limit", message, status: 429 }` |
| `ValidationError` (400) | `{ kind: "validation_error", messages }` | the same, plus `status: 400` |

**Web code.** `error` in `onError` and the mutation hooks is never a string now
(`MutationError` lost `string`), and the guards match custom messages. Code that
rendered it directly (`toast(error)`) or compared it (`error === "Not
authorized"`) must read `error.message` or use the guards:

```ts
if (isPermissionError(error)) toast(error.message); // custom messages now match
```

The typechecker finds the string comparisons. The web client wraps a bare string
from an older server into the same object (using the response's status), and the
guards still accept the old strings and `{ message }` bodies, so a new client
works against an old server during a rolling deploy. That fallback goes in 0.86.

**Other bodies the hooks hand over** gain `status`, and a `kind` from the status
when they have a `message` and no `kind`: an app's `HttpResponse.json({ error:
"Slug taken" }, { status: 409 })` is now `{ kind: "form_error", message: "Slug
taken", status: 409 }`, which `<FormError>` renders. `MutationMessageError` is
deprecated and no longer part of `MutationError`.

**`RequestBreakerError` takes a message and a status.** `throw new
RequestBreakerError("Slug taken", { status: 409 })` answers the shape above,
with `kind` following from the status (or `kind: "…"` to name it). A bare
`new RequestBreakerError(message)` used to answer a 400 with an empty body; it
now answers a 400 `form_error` with that message. A subclass that sets
`this.payload` itself is unchanged.

**Native and other non-gemi clients** that read `body.error` as a string must
read `body.error.message`. Ship the client change first, or set this at boot for
one release (it turns the five refusals that were strings back into strings; the
ones that were already objects stay objects):

```ts
RequestBreakerError.legacyStringPayload = true;
```

**Agents.** `useChat` and the Swift/Kotlin chat clients already read
`error.message`, so a refusal on an agent route (an `auth` middleware's 401, say)
now reports its message instead of the status text. Agent routes' own errors
(`{ code, message }`) and run errors (`AgentRunFailure`) are unchanged. A route
tool's refusal shown to the model includes the new fields.

## Behaviour change: every file in `public/` is served, whatever its extension (#583)

`gemi start` used to decide whether a root-level path was a static file from a
fixed extension list. A `public/` file the list missed (`.wasm`, `.csv`,
`.wav`, `.mov`, `.zip` …, and `.mp4`/`.webm` before 0.63) never reached the
static handler: the router answered it, usually with a locale redirect and a
rendered 404 page.

The server now reads the files the build copied into `dist/client` once at
boot, and serves a request whose path names one of them exactly — any
extension, any depth. `/assets/*` and `/.well-known/*` are unchanged.

- **A public file wins over a route with the same path.** A view's data URL
  is `/<path>.json`, so a `public/pricing.json` now answers `/pricing.json`
  instead of the `/pricing` view's data (this already held for
  `public/manifest.json`). Rename the file if you ship one like that.
- **Names starting with a dot are never served** (`.DS_Store`, `.env`, and
  everything under a dot-directory), except `/.well-known/*` as before.
- **Byte ranges.** Static files answer a single `Range` with a `206` (and an
  unsatisfiable one with a `416`), so a `<video>` pointed at a public `.mp4`
  can seek. A controller that streamed public videos only to get this can be
  deleted.
- **Files written into `dist/client` after the server started** are not served
  outside `/assets` until the next restart.

# Upgrading from 0.84.0 to 0.84.1

## Azure attachments upload with purpose `assistants` (#682)

`AzureOpenAIProvider.upload` sent `purpose: "user_data"`. Azure accepts that
upload, but its Responses API refuses the `file-…` id it returns ("Expected
an ID that begins with 'assistant'"), so every chat turn with an attachment
failed on Azure. Every later turn of that thread failed too, because the file
part is stored in it. Azure uploads now use `purpose: "assistants"` (ids start
with `assistant-`). `OpenAIProvider` still uploads as `user_data`.

- Nothing to change in your app. If you subclassed `AzureOpenAIProvider` to
  override `upload` with `assistants`, delete the override.
- Threads that already hold a `file-…` id from an Azure `user_data` upload
  still fail. Start a new thread, or remove that file part from the stored
  history.

## A file the provider refuses is a 422, not a 500

When the provider refuses an upload with 400, 413, 415 or 422 (for example,
Azure answers an `.exe` with "Invalid extension exe. Supported formats: …"),
`AgentController.upload` now answers **422** with
`{ error: { code, message } }`. `message` is the provider's own sentence, and
`code` is `unsupported_file_type` when the provider says the type is the
problem and `file_rejected` otherwise. Before this the error went unhandled
and became a 500. A 401, 403, 429 or 5xx from the provider is still a server
error. With `assistants` Azure also accepts `.docx`, which it refused under
`user_data`; a `.docx` attachment is read in a turn (measured 2026-10-01).

## Fix: `useUpload`'s `cancel()` settles `trigger`, and `state` tracks the upload (#671)

- `cancel()` mid-upload now resolves `trigger`'s promise with `undefined`. It
  used to leave it pending forever (code after `await trigger(file)` never ran)
  and log an unhandled `RangeError`. `onCanceled` runs; `onError` does not.
- `state` reads `"uploading"` while the upload is in flight and `"done"` after
  it succeeds. Before, it read `"idle"` during the upload and `"uploading"`
  once it had finished. Code that waited for `state === "uploading"` as a
  "finished" signal should wait for `"done"` (or use `onSuccess`).
- `progress` no longer becomes `NaN` when the browser cannot compute the
  upload's length, and a cancelled upload's `progress` stays at `0`.
- `cancel()` after the upload has settled does nothing (it used to call
  `onCanceled`).

# Upgrading from 0.83 to 0.84

Breaking and behaviour changes first, in the order to check them:

1. **Broadcasting and websockets are removed.** Delete any use of
   `gemi/broadcasting`, the `Broadcast` facade, `BroadcastManager` and the
   `useSubscription`/`useBroadcast` hooks. The typechecker finds them all.
2. **`ctx().setUser(user)` now signs that user in** for every `auth` route,
   with or without an `access_token`. Audit every `setUser(` call before
   upgrading.
3. **Error codes for model output:** an agent's schema mismatch is now
   `invalid_output` (was `unknown`), and the new `generate()` reports
   `invalid_output`, `timeout` and `aborted`.
4. **Shutdown exit code:** a shutdown that cuts off a queued job or a cron tick
   exits `1` (was `0`).

## Breaking: broadcasting and websockets are removed (#31, #679)

**Breaking change.** The broadcasting subsystem is gone. Nothing in gemi used
it, and apps that need real-time delivery are better served by a dedicated
service than by a half-built one in the framework.

Removed:

- the `gemi/broadcasting` entry point and `BroadcastingChannel`
- `Broadcast` from `gemi/facades`
- `BroadcastManager`, `BroadcastServiceProvider`, `defineBroadcastConfig`,
  `broadcastConfigDefaults` and the `BroadcastConfig` type from
  `gemi/services`, and the `broadcast` config slice
- `useSubscription` and `useBroadcast` from `gemi/client`, and the websocket
  provider `ClientRouter` wrapped every page in
- `App.websocket`, `App.onPublish()` and `Kernel.broadcast()`
- the broadcasting entries in the `gemi migrate` codemod tables

`Auth.user()` no longer reads a websocket connection's headers and cookies;
it reads the current request only, as every non-websocket caller already did.
Outside a request there is no token, so it throws `AuthenticationError` as
before.

What to delete in your app:

- `app/config/broadcast.ts`, and its entry wherever you collect config
- `app/broadcasting/` (your `BroadcastingChannel` subclasses)
- any `Broadcast.channel(...).publish(...)` call, and any `useSubscription` /
  `useBroadcast` in components
- test stubs of `BroadcastManager`. folio's
  `apps/web/app/auth/legacySessionMigration.postgres.bun-check.ts` imports
  `BroadcastManager` from `gemi/services` only to stub the broadcasting branch
  of `Auth.user()`; delete that import and the stub. `Auth.user()` no longer
  resolves `BroadcastManager`, so nothing replaces it.

The typechecker finds each of these: every removed name is now a missing
export.

## Behaviour change (security): `setUser` signs a user in, and `Auth.user()` reads the `access_token` header (#577, #587, #676)

What counts as signed in is now one rule, shared by the `auth` middleware and
`Auth.user()`:

1. **A user on the request context.** One a global middleware, or a route
   middleware listed before `auth`, put there with `ctx().setUser(user)`.
2. **Otherwise the `access_token`**: the cookie, or else the `access_token`
   header, naming a live session.

- **`auth` passes a context user with no token** (#577). It used to require an
  `access_token` cookie or header as well, and then trusted the context user
  without checking that token against a session, so the token was never a
  check on that user, only a requirement to send one. An app that signs users in
  by SSO header, API key or a signed service token can now use `auth` instead
  of writing its own.
- **`Auth.user()` reads the `access_token` header** (#587), through the same
  reader as the middleware. A native client was signed in on a route with
  `auth` and refused on one without it; it is now signed in on both.
- **One token reader** (`readAccessToken`, internal) replaces the middleware's,
  `Auth.user()`'s two and sign-out's. An empty `access_token` cookie now counts
  as absent, so a header sent beside it is read. When both are sent the cookie
  still wins.

Unknown, expired and pre-`v2.` tokens are refused exactly as before.

**Behaviour change, and a security one: audit every `setUser` call.** Anything
your middleware puts on `ctx().user` is now a signed-in user to every `auth`
route, token or not. Before you upgrade, search your app for `setUser(` and
check that each one runs only after the user is verified:

- A global middleware that sets a placeholder, such as a guest or anonymous
  user for logging, analytics or policies, now signs every visitor in. Move
  that value off `ctx().user`.
- A middleware that sets a user from an unverified header, query parameter or
  token (for rate limiting or logs, say) now signs that request in as whoever
  it names. Verify the credential first, or don't set a user.
- A route middleware listed before `auth` that sets a user is trusted too. One
  listed after `auth` still cannot sign anyone in.

An app whose middleware never calls `setUser`, or calls it only with a user
that `Auth.user()` returned, behaves as before, apart from header clients now
being signed in on routes without `auth`. See
[Who counts as signed in](docs/middleware.md#who-counts-as-signed-in).

## Behaviour change: an agent's schema mismatch reports `invalid_output`, not `unknown` (#641)

`AgentErrorCode` gained `invalid_output`. When an agent's final answer does not
match its `output` schema, the `error` event it emits now has
`code: "invalid_output"` instead of `"unknown"`; the message is unchanged. Only
code that matched on `"unknown"` to detect this needs updating. An exhaustive
`switch` over `AgentErrorCode` needs the new case.

## Behaviour change: a job or cron tick cut off at the shutdown deadline exits 1 (#580, #668)

The docs said a queued job still running at the provider shutdown deadline
makes the shutdown exit with code 1. It exited 0: the queue bounds its own
drain, so it never overran, and the abandoned job showed up only in the log.

- `QueueServiceProvider` and `ScheduleServiceProvider` now report work they
  abandoned at the deadline, and the provider is listed in
  `ShutdownReport.timedOut`. `gemi start` and `gemi queue:work` then exit `1`
  with "Shutdown finished with errors", so an orchestrator or a log alert sees
  the unclean stop. The log line naming the jobs or ticks is unchanged.
- `ServiceProvider.shutdown()` may now resolve `{ abandoned: true }` (type
  `ProviderShutdownResult`). A custom provider that bounds its own wait can
  use it to report work it gave up on in the same way. Returning nothing
  works as before.

**Behaviour change:** a shutdown that cuts off a queued job or a cron tick
exits `1` where it exited `0`. If your platform alerts or restarts on a
non-zero exit, make `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` long enough for your
jobs, or expect the alert when they are cut off.

## New: `generate()` and `ctx.generate()`, one model call with an output schema (#594, #641)

A typed answer without an agent: no tool loop, no nested transcript streamed to
the browser, nothing written to the thread.

```ts
import { generate, s } from "gemi/ai";

const result = await generate({
  provider,
  instructions,
  prompt: `The business: ${description}`, // or `messages`, or both
  output: s.object({ copies: s.array(s.object({ headline: s.string(), cta: s.string() })) }),
  temperature: 0.9,
  // maxOutputTokens, reasoning, signal, throwOnError, logErrors
});

if (result.ok) save(result.output); // typed from the schema
```

Inside an agent tool, call `ctx.generate({ ... })` instead. It is the same
function with the turn bound in: it aborts when the user stops the turn, and its
usage counts toward the turn's `usage`, the way a sub-agent's does. A `signal`
you pass (say `AbortSignal.timeout(30_000)`) is combined with the tool call's
`ctx.signal`, so a stop, the run's `maxRunDurationMs` and the tool's
`timeoutMs` all cancel it. A stop or the run's deadline makes `ctx.generate`
throw, so the tool body doesn't carry on; the tool's own `timeoutMs` comes back
as `code: "timeout"`.

**A bad answer is returned, not thrown.** The result is
`{ ok: true, output, messages, usage, finishReason }` or
`{ ok: false, error, messages, usage, finishReason }`:

- `messages` is the whole transcript (what you passed, the prompt, the model's
  reply) on both arms. On failure the reply holds the raw text the model wrote,
  so a retry continues the conversation:

  ```ts
  let messages: AgentMessage[] = [];
  let prompt = `The business: ${description}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await generate({ provider, instructions, messages, prompt, output });
    if (result.ok) return result.output;
    messages = result.messages;
    prompt = `Your output was rejected:\n${result.error.message}\nReturn it again, fixed.`;
  }
  ```

- `usage` is on both arms, because a failed answer was still billed.
- `error.code` is `invalid_output` (did not match the schema, cut off at
  `maxOutputTokens` — then `finishReason` is `"length"` — or missing),
  `timeout` (the signal aborted with a `TimeoutError`, such as
  `AbortSignal.timeout`; retryable), `aborted` (any other abort, such as a
  stop), or the provider's normalized code (`rate_limited`,
  `content_filtered`, ...). `timeout` is the same code an agent run's deadline
  and a tool's `timeoutMs` report.
- `error` is an `AgentRunFailure`, like an agent run's `result().error`: when
  the provider answered with an error it also has the HTTP `status` and the
  provider's `requestId`. Neither ever reaches a client.

It behaves like an agent run in two more ways:

- **`throwOnError: true`** rejects with an `AgentRunError` instead of resolving
  `ok: false`, and the result is then typed as the `ok: true` arm. The error
  has the `code`, `retryable`, `status` and `requestId`, a `gen_` id in
  `runId`, and the `messages`, `usage` and `finishReason` on `result`. Unlike a
  run, a stop rejects too (`code: "aborted"`), because there is no output to
  resolve with.
- **A failure is logged** through `Log.error`, so it lands in `storage/logs`
  and `onLogCreated`. In `gemi dev` it also goes to the console, and outside an
  application it goes to `console.error`. A stop is not logged. Inside a tool
  the line names the agent, run and tool call. Pass `logErrors: false` when you
  handle `result.error` yourself, for example in a retry loop that expects an
  occasional `invalid_output`.

An `s.json()` schema works as it does for an agent: it is sent non-strict.

`ctx.generate` is **not memoized**. `ctx.runAgent` and `ctx.generateImage` replay
from what they recorded on the tool call when an escalating tool is re-entered;
`ctx.generate` records nothing, so a re-entered tool calls the model again.

## Fixes with no upgrade step

- **A field reports each validation message once** (#675, #678). When two
  rules on a field share a message (the default sign-up schema's
  `"Invalid email"`, say), the field listed it twice. Each identical message
  now appears once per field, and a `refine()` message the rules already
  reported is not repeated. Different messages still all appear, in rule order.
- **`useQuery`: an older response can no longer overwrite newer data** (#677,
  #680). When two `mutate()` or `refetch()` requests for the same query
  overlapped and the older one came back last, it replaced the newer data. A
  response older than the newest applied write (a newer response or an
  optimistic update) is now dropped, and only the latest request can store an
  error. No API change.

# Upgrading from 0.82 to 0.83

## `reasoning` takes `"none"`, and any effort the model accepts (#658)

`ReasoningEffort` was `"minimal" | "low" | "medium" | "high"`. Newer models
take a different set: Azure's gpt-6-sol answers 400 to `"minimal"` and accepts
`none | low | medium | high | xhigh | max`, so the lowest effort an app could ask
for on it was `"low"`, and reasoning could not be turned off at all.

- `ReasoningEffort` now lists `"none"`, `"xhigh"` and `"max"` as well, and
  takes any other string. The value is sent to the model as is; gemi does not
  check it against a list, because which values a model takes depends on the
  model. A value the model rejects ends the run with `finishReason: "error"`
  and the API's message (which names the values it does take) on
  `result().error`.
- `reasoning: "none"` is sent as `reasoning: { effort: "none" }`, without
  `summary: "auto"`, since there is nothing to summarize. Every other value is
  sent with the summary as before.
- `"none"` is not the same as leaving `reasoning` unset: unset gets the model's
  default effort (usually `"medium"`). Use `"none"` for short, latency-bound
  calls; with any effort, `maxOutputTokens` caps reasoning tokens too, and a
  small cap can be spent entirely on reasoning, leaving no text.
- On a model gemi knows has no reasoning parameter (gpt-4o, gpt-4.1, gpt-3.5),
  every value, `"none"` included, is still dropped from the request.
- Older reasoning models do not take `"none"` (gpt-5 takes `"minimal"`
  instead; o-series models take neither). Keep using `"minimal"` or `"low"`
  there.

If you worked around the old type with a cast (`"none" as ReasoningEffort`),
the cast can go. Nothing else changes for existing values.

# Upgrading from 0.81 to 0.82

## Agent runs have a deadline, and tools can have a timeout (#455)

A tool that never settled (a `fetch` with no timeout, say) kept its run open
for the life of the process, and the live-run registry kept the run, its
frames and everything it closed over with it.

- **`Agent.create({ maxRunDurationMs })`**, default **10 minutes**
  (`DEFAULT_MAX_RUN_DURATION_MS`, exported from `gemi/ai`). When a run reaches
  it, the run is stopped the way `stop()` stops it: `ctx.signal` aborts (its
  `reason` is a `TimeoutError`), the provider request is cancelled, and every
  tool call still in flight gets a `denied` result with `cause: "stopped"`.
  The run then ends with `finishReason: "error"` and
  `result().error.code === "timeout"`, so it's logged (unless `logErrors:
  false`) and `result({ throwOnError: true })` rejects. The client gets an
  `error` frame with code `"timeout"`, then `run-end` with `"error"`, and the
  finished transcript is stored like any other turn's.
  `agent.stream({ maxRunDurationMs })` overrides it for one run. `null` (or
  `Infinity`) turns it off. `0` or a negative number throws.
- **`AgentTool.create({ timeoutMs })`**, no limit by default. When a call
  reaches it, `ctx.signal` aborts with a `TimeoutError`, the model gets an
  `error` result for that call with code `"timeout"`, and the run carries on.
  The run stops waiting for the call at that point even if the tool ignores the
  signal, and anything the tool yields or returns afterwards is dropped.
- **`ctx.signal` is now per call** when the tool has a `timeoutMs`. It still
  aborts on `stop()` and at the run's deadline. Image calls and sub-runs a
  tool starts get the same signal, so a timeout cancels them too.
- **`MemoryLiveRuns` has an age ceiling**, `maxAgeMs`, default 1 hour, `null`
  to turn it off. An entry still there at that age, ended or not, gets its run
  stopped and is evicted `ttlMs` later. `AgentController` passes the agent's
  `maxRunDurationMs`, so a run allowed to be longer than an hour is never cut
  off before its own limit plus `ttlMs`, and an agent with
  `maxRunDurationMs: null` is exempt.
- `AgentErrorCode` gains `"timeout"`. If you `switch` over it exhaustively, add
  the case.

**Behaviour change:** a run longer than 10 minutes used to be allowed and now
ends as a `timeout` error. An agent whose runs are legitimately long (a batch
job, a long research loop) should set `maxRunDurationMs` to its own bound, or
`null`. A sub-run started with `ctx.runAgent` has no default limit of its own.
It's bounded by its parent, unless its agent sets one explicitly.

# Upgrading from 0.80 to 0.81

## A failed agent run says why on `result()`, and is logged (#656)

When a provider call failed, `run.result()` resolved with
`finishReason: "error"`, no `output`, and nothing else. The cause was only an
`error` event on the stream, so a server-side caller that just awaited
`result()` never saw it, and nothing was logged.

- **`AgentRunResult.error`** is set exactly when `finishReason` is `"error"`
  (type `AgentRunFailure`). It has the same `code`, `message` and `retryable`
  as the stream's `error` event. When the provider answered with an HTTP
  error, it also has the `status` and the provider's `requestId`. A
  successful, aborted, `max-steps` or `length` result has no `error` key, as
  before. `NestedRunResult` (from `ctx.runAgent`) has the same field.
- **`result({ throwOnError: true })`** rejects with an `AgentRunError`
  (exported from `gemi/ai`) for a run that ends in `"error"`. It carries
  `code`, `retryable`, `status`, `requestId`, `runId` and the whole `result`,
  so the messages and usage of the steps before the failure are still there.
  Every other finish reason resolves as usual. Without the option nothing
  changes: `result()` still resolves.
- **Failed runs are logged by default** through `Log.error`, so they land in
  `storage/logs` and reach the log config's `onLogCreated`. In development
  (`gemi dev`) the line also goes to the console. Outside an application (a
  script, a test) it goes to `console.error` instead. Pass
  `Agent.create({ logErrors: false })` if the app already reports the failure
  itself and doesn't want a second line.

Unchanged: the `error` frame a client receives. It carries only `code`,
`message`, `retryable` (and `toolCallId` when set), exactly as before. The
`status` and `requestId` stay on the server.

For a custom `AgentProvider`: an `error` event may now carry optional
`status` and `requestId` next to `error`, and a provider that throws an error
with a numeric `status` (and optionally a string `requestId`) gets them
recorded too. Neither is required.

If you implement `AgentRun` yourself (a test stub, say), `result()` now takes
an optional `{ throwOnError }`. A `result()` that ignores it still
typechecks, but won't reject.

## `Storage.fetch` takes an abort signal (#654)

`Storage.fetch(params, { signal })` now accepts an `AbortSignal`, as
`Storage.put` already did. An abort rejects `fetch()`, or errors the returned
body if it lands later, so `await res.arrayBuffer()` rejects instead of
hanging on a stalled read. Existing calls are unaffected.

A custom driver's `fetch()` receives the options as its second argument
(`FetchFileOptions`, exported from `gemi/services`). A driver that ignores it
keeps working, and `Storage.fetch` still rejects a signal that is already
aborted before calling it.

# Upgrading from 0.79 to 0.80

## `gemi dev` shuts the replaced application down on every reload (#652)

Each `bun --hot` reload of server code boots a new application, and nothing
stopped the one it replaced. Its database pool stayed open, so every save left
10 idle Postgres connections behind (Bun's default pool size). After a few
saves the dev server used up `max_connections`, and every process sharing that
Postgres then failed with `too many clients already`.

Now, once the new application is serving, the replaced one gets up to 10
seconds to finish its requests and then runs its providers' `shutdown()`
hooks. That closes its database pool and its Redis client, stops its cron
schedule and drains its queue. The reload doesn't wait for any of this, and a
failure in it is logged instead of shown in the error overlay.

What changes for an app:

- **Your providers' `shutdown()` runs in development too**, on each reload,
  for the application being replaced. If a hook closes something you keep on
  `globalThis` so that it survives reloads, it now closes it under the new
  application as well. Leave shared state like that alone in `shutdown()`.
- **The database pool and the Redis client are closed at shutdown** in every
  mode: when `gemi start` or `gemi queue:work` is stopped, and on a dev reload.
  Before, only the process exit closed them. The database closes last, after
  the queue and the scheduler have waited for their jobs.
- **A memory-queue job still waiting when you save is dropped** with the old
  application, as it would be on a restart. Before, the old application's
  queue kept running it on the old code. Jobs on the database driver are
  unaffected: the new application already took over their loop.

# Upgrading from 0.78 to 0.79

## A tool input or agent output must be an object at the root (#478)

`AgentTool.create` now throws when a tool's `inputSchema` does not emit
`type: "object"` at its root, and `Agent.create` does the same for `output`.
Before, a root `s.union(...)` (which lowers to `anyOf`), a primitive, an array,
`s.json()` or a `.nullable()` object was accepted and then failed at request
time: OpenAI's strict function parameters and structured output reject `anyOf`
or a non-object at the root, so the first turn carrying the schema was a 400.
The error now happens at startup and names the tool or agent.

To upgrade, wrap the schema in an object and read the field off the result:

```ts
// before
output: s.union([s.object({ kind: s.literal("a") }), s.object({ kind: s.literal("b") })]),
// after
output: s.object({
  value: s.union([s.object({ kind: s.literal("a") }), s.object({ kind: s.literal("b") })]),
}),
// ...and read `result.output.value`
```

A tool's `outputSchema` is never sent to the provider and is not checked.

# Upgrading from 0.77 to 0.78

## `attachmentScope` and `authorizeRequest` get the request body (#603)

A chat with no signed-in user and no thread (a stateless page builder that
sends `useChat("/page-builder", { body: { pageId } })`) had no attachment scope,
so `ctx.attachments` threw and `ctx.generateImage` could not run in it. The page
was in the body, and neither method could see it: the route has already read
the body by the time they run.

- **`attachmentScope(req, threadId, { body })`.** A new third argument, the same
  `body` `instructions()` gets, typed as the controller's `Body`. It is passed on
  `stream` and on `upload`. The first two arguments are unchanged, so existing
  overrides (`attachmentScope(req, threadId)`, `attachmentScope()`) and
  `super.attachmentScope(req, threadId)` keep working.
- **`authorizeRequest(req, { route, threadId, body })`.** `body` is set on
  `stream` and `upload` and absent on `attach` and `stop`, which carry none.
  The params type is exported as `AuthorizeRequestParams<Body>`; narrow on
  `route` to read `body`. Overrides typed against the old `{ route, threadId }`
  still compile.
- **`useChat.uploadFile` sends the `body` option** as a `body` form part (one
  JSON object) beside the file. The GemiChat (Swift) and `dev.gemijs.chat`
  (Kotlin) `upload` do the same with the session's `body` when it is not empty.
  So an upload resolves the same scope as the turn that uses it.
- **A malformed `body` part is a 400** (`invalid_request`) from `/files`, before
  `authorizeRequest` runs and before any bytes are stored or sent. A missing
  part is `{}`, as before. The envelope's names (`turn`, `clientRunId`,
  `threadId`, `messages`) are taken out of it, as they are on `stream`.

Only key a scope on a body value the server looks up and that works as a
capability, like a thread id: an unguessable page `publicId` that you find in
the database, keyed on what the lookup returned.

```ts
protected async attachmentScope(req, threadId, { body }) {
  const scope = await super.attachmentScope(req, threadId);
  if (scope) return scope;
  // Checked first: to an ORM, `{ publicId: undefined }` is no filter at all.
  if (typeof body.pageId !== "string") return null;
  const page = await Page.findFirst({ where: { publicId: body.pageId } });
  return page ? { key: `page:${page.publicId}` } : null;
}
```

Never ``{ key: `org:${body.orgId}` }``: an org id can be guessed, and the caller
may not belong to that org. A tenant comes from `req.ctx().user`. Derive the
key from a field that stays the same for the whole conversation (the page, not
the selected element). A key that differs between the upload and the turn makes
the upload's id an `AttachmentNotFoundError` in the turn.

If you worked around this by overriding `stream` to read
`req.rawRequest.clone().json()` into a field, that still works. You can delete
it and read `body` in `attachmentScope` instead, which also covers `upload`.

# Upgrading from 0.76 to 0.77

## `HttpResponse.json(data, { status?, headers? })` (#646, #647)

Return a JSON response with a custom status or headers from an API route
without losing the route's type:

```ts
import { HttpResponse } from "gemi/http";
return HttpResponse.json(post, { status: 201 });
return HttpResponse.json({ error: { message: "Already published" } }, { status: 409 });
```

- The route's client type is `data`'s type, as if `data` had been returned
  directly (a union with plain returns works too).
- It goes through the same path as a plain return, so cookies, `ctx().setHeaders()`
  headers and middleware headers (CORS, `cache`) are kept. `options.headers`
  override by name, and `Set-Cookie` accumulates. `Content-Type` defaults to
  `application/json`. A status of 400 or more gets `Cache-Control: no-store`
  unless you set one.
- `status` defaults to 200. 204, 205, 304 and anything outside 200–599 throw a
  `RangeError`. API routes only: returning it from a view handler throws.

**Behaviour change, client:** a non-2xx JSON body with no `error` field is now
passed to `onError` / `error` whole. Before, it came through as `undefined`. A
JSON `null` error body becomes `{ message: "Request failed with status N" }`
instead of throwing a TypeError. Bodies shaped `{ error: … }` behave exactly as
before.

# Upgrading from 0.75 to 0.76

## A threaded turn is stored as it runs, and a lost one reads as `interrupted` (#617)

`AgentController` used to store a turn only when its run ended. A restart, crash
or deploy mid-run left the thread with nothing from that turn, not even the
user's message, while its tools might already have saved something.

Now, on a thread:

- **The store is written while the run goes.** The user's message is stored
  when the run starts, then the assistant message in progress: when it opens,
  when a tool call's arguments are complete, and when a tool result lands. A
  message still being written has no `finishReason` and carries the run's id
  in a new optional field, `AgentMessage.runId`. Each message is written again
  once finished, and the end-of-run write stores the whole transcript as
  before. Every write goes through `appendMessages`, which already upserts by
  id, so a store needs no new method. It is called more often, and with the
  same message several times; the last write wins.
- **A message whose run is gone is closed as `interrupted`.** New
  `FinishReason` `"interrupted"`. Any tool call the message left open gets a
  `denied` result with a new `cause: "interrupted"`. The model is told the call
  was cut off and may have run in part or in full, rather than that it did not
  run. This happens when the next turn starts on the thread (and is written
  back then), and when you read the thread with the new
  `controller.readThread(threadId)`. That read does not write.
- **Liveness is `isRunLive(runId, threadId)`**, a protected method that asks
  this process's `liveRuns`. That's the whole answer on one instance. Behind
  several instances, a message whose run lives on another instance reads as
  interrupted here until that run's own writes replace it. #459 tracks a
  lasting record of running runs; override `isRunLive` to consult one.

**What to change:** the route that hands a thread to `useChat` (or a native
session) should read it through the controller, so a lost turn shows as cut off
rather than as an answer still streaming:

```ts
messages: await new ChatController().readThread(threadId),
```

**What to check:**

- A `switch` over `FinishReason`, or over a denied result's `cause`, that is
  exhaustive stops compiling until it handles `"interrupted"`.
- A custom `AgentStore` must upsert by message id, as its contract already
  says. One that inserts will now duplicate messages within a single turn.
- `onMessage` is unchanged: it still fires after the run ends.
- Stateless turns (no `threadId`) are unchanged.
- The wire frames are unchanged. `"interrupted"` only appears on messages read
  back from the store. The Swift and Kotlin clients read both values as open
  strings, and both gain `FinishReason.interrupted` / `FinishReason.Interrupted`
  constants.

# Upgrading from 0.74 to 0.75

## `useQuery` stops retrying client errors — behaviour change (#421, #643)

A non-suspense `useQuery` used to retry a failed request forever, every 10s,
whatever the status. So `useUser` on a public page polled `/auth/me` for as long
as the page was open.

- **Not retried:** 4xx except 408 and 429 (400, 401, 403, 404, 410, 422, …). The
  error is returned once.
- **Retried:** network failures, a 2xx body that isn't JSON, 408, 429 and 5xx.
  At most 3 retries in a row, waiting 1s, 2s and 4s (capped at 30s). A
  `Retry-After` header on 429/503 sets the wait (`QueryError.retryAfter`).
- **Reconnect:** when the browser comes back online, a query whose last failure
  is retryable is fetched again. `revalidateOnFocus` is unchanged.
- **Non-JSON error bodies** (e.g. a proxy's HTML 502) are now a `QueryError`
  with the status and `body: null`, instead of a `SyntaxError`.

**Config:**
- `retry` per call: a number, `false`/`0`, `true` (uncapped, still never 4xx),
  or `(failureCount, error) => boolean`.
- `retryDelay` per call: ms, or a function of the failure count.
- Both are also accepted app-wide in `queryConfig`.
- `retryIntervalOnError` is deprecated. It now only sets the backoff's base
  delay.
- `useUser(config?)` and `queryConfig.user` accept `staleTime`, `retry`,
  `retryDelay`, `revalidateOnFocus`, `focusThrottleInterval` and
  `refreshInterval`. Example: `queryConfig: { user: { staleTime: 30 * 60_000 } }`
  stops refetching `/auth/me` on every navigation.

**What to check:** code that relied on a query eventually recovering from a 4xx
by retrying. Call `refetch()` (or `mutate()`) when the condition changes
instead.

# Upgrading from 0.74.0 to 0.74.1

## Password sign-in never 500s on a missing or unreadable hash (#276, #642)

Signing in with a password for a user who has none (e.g. OAuth-only), or whose
stored hash is empty or unreadable, used to throw inside `Bun.password.verify`
and answer 500. It now answers `invalid_credentials`, like a wrong password.
`changePassword` answers its existing "Incorrect password" validation error
instead of a 500.

No password, unknown address and wrong password now take about the same time:
gemi runs `verifyPassword` against a decoy hash in the first two cases. As a
result, a sign-in for an unknown address costs one hash check, like a wrong
password. A custom `verifyPassword` is never called with a null hash, and its
type is unchanged. The default is exported as `verifyPasswordHash`.

# Upgrading from 0.73 to 0.74

One addition. Nothing to rewrite unless a `proxy()` route relied on forwarding
your proxy-secret header.

## `route.domains.trustProxy`: read the host from a configurable header (#607, #640)

`trustProxy` accepts an object as well as `true`:

```ts
trustProxy: {
  hostHeader: "x-kyte-host",                       // default "x-forwarded-host"
  secret: { header: "x-kyte-proxy-secret", value: process.env.PROXY_SECRET! },
}
```

`hostHeader` replaces `X-Forwarded-Host` (which is then not read). With
`secret`, the host header is trusted only when the secret header matches, using
a constant-time comparison. A missing or wrong secret falls back to the
request's own `Host`; the request isn't rejected. The trusted host feeds domain
matching, `req.domain.host`, the cookie domain, `Url.forDomain` and
`useDomain().url()`. `X-Forwarded-Proto` is unchanged and independent.
`trustProxy: true` behaves exactly as before.

Checked at boot: both header names must be valid, the secret header must differ
from the host header, and `secret.value` must be a string of at least 16
characters, so an unset env var fails the boot. `proxy()` routes no longer
forward the configured secret header upstream.

# Upgrading from 0.72 to 0.73

## Request validation: `string` / `boolean` are checked, unknown rules throw — behaviour change (#609, #637)

`string` and `boolean` schema rules were accepted but never checked. They now
check `typeof` (no coercion: `"true"` is not a boolean). `email` and `password`
accept strings only. An optional field is skipped only when it is missing,
`null` or `""`, so `0` and `false` are now validated. A field that fails
`required` reports only that message.

**Unknown rule names and malformed rule parameters now throw**
`InvalidValidationRuleError` (exported from `gemi/http`) instead of silently
passing. Examples are a typo like `requried`, `min:abc`, `lte:`, `fileType`
with no type, and `fileSize:5mb`. All rules are resolved before any value is
checked, so a schema with a bad rule makes every request to that endpoint
answer 500, from both `input()` and `safeInput()`.

**What to check:** grep your request schemas for rule names gemi doesn't
define. A rule whose value is a function is still treated as a custom check
under any name.

## `migrateLegacySession`: sign-out revokes converted sessions, and conversion can't race sign-out (#638, #639)

This only matters if `auth.migrateLegacySession` is set. Conversion and
sign-out for the same old token are now serialized (a Postgres advisory lock;
an in-process queue on SQLite; the row lock on MySQL). A conversion creates the
new session only if it claimed the old row. Signing out with an old token also
revokes the session it was converted to, within the grace window. Sign-out now
goes through `AuthManager.revokeSession`. A conversion deletes the old row
through `UserProvider.claimLegacySession`, not `deleteSession`, so a
`deleteSession` override (e.g. for cache invalidation) isn't called for that
one delete. Without the hook, nothing changes.

# Upgrading from 0.72.0 to 0.72.1

## `Storage.delete()` deletes — behaviour change for Azure (#608, #636)

`Storage.delete(name | { name, bucket })` was a no-op. It now forwards to the
configured driver: `FileSystemDriver` unlinks the file (a name that resolves
outside the storage folder is refused), `S3Driver` sends `DeleteObject`, and
`AzureBlobDriver` deletes the blob. Deleting an object that doesn't exist
resolves on every driver; other failures (e.g. a 403) still reject.

**Azure:** `AzureBlobDriver.delete()` used to throw `FileNotFoundError` for a
missing blob. It now resolves. Code that called the driver directly and relied
on that throw must check existence itself.

**Custom drivers:** `delete()` is not abstract. A custom driver that doesn't
implement it now throws "`<Driver>` does not implement delete()" when
`Storage.delete()` is called, instead of silently doing nothing.

# Upgrading from 0.71 to 0.72

Two additions, one of them type-only. No runtime behaviour changes. The typed
errors may surface type errors where an app reads fields off `onError`'s error
without checking what it is. Those reads were already unsafe.

## Typed mutation errors: `MutationError` and guards (#626, #635)

`onError` on `<Form>` and every mutation hook, and the hooks' `error`, are now
typed `MutationError` instead of `any`:
`MutationValidationError | MutationFormError | MutationServerError |
MutationMessageError | string | Error`. The runtime value is unchanged.

Use the guards exported from `gemi/client` before reading fields:
`isValidationError`, `isFormError`, `isAuthenticationError`,
`isPermissionError`, `isCsrfError`, `isNotFoundError`, `isRateLimitError`,
`isServerError`, `isNetworkError`, or switch on `mutationErrorKind(error)`.

**What to fix:** code that read `.kind`, `.messages` or `.message` straight off
the error, and callbacks annotated with a narrower hand-written error type.
Narrow with a guard first, or annotate the parameter as `MutationError`.

**Known limit:** most refusals reach the client as bare strings with no status.
The string guards match gemi's default messages, so an `AuthorizationError`
thrown with a custom message classifies as `"unknown"`.

## Paged lists: `useInfiniteQuery`, and updating every search variant (#624, #634)

`useInfiniteQuery(path, { params, search }, { getNextPage, getKey?, getItems?,
pageParam? })` returns `pages`, `items`, `hasMore` and `fetchNextPage()`.
Page 1 is a regular `useQuery`, so SSR prefetch, suspense and
`keepPreviousData` behave as they do there. Later pages are cache variants of
the same path. A change of params or search resets to page 1 while the previous
list stays on screen.

`useMutate` accepts a search predicate:
`mutate({ path, params, search: (s) => boolean }, fn?)`. It updates every
matching cached variant (`() => true` for all), refetches the ones on screen,
and marks the rest stale. For clamping `page`/`limit` on the server, use the
existing `paginate()` from `gemi/orm`.

# Upgrading from 0.70 to 0.71

Three additions and no behaviour changes. Nothing to rewrite.

## `Features.set(key, active, { actor })` (#625, #631)

Writes a feature switch through the configured `FeatureFlagSource` and
invalidates the snapshot. An undeclared key throws `UndeclaredFeatureError`, a
read-only source throws `FeatureSourceReadOnlyError`, and a reload failure after
the write throws `FeatureReloadError`. The database source upserts the row, so a
switch that was never written gets created. Custom sources gain an optional
`write()`; sources without it are read-only.

To record who changed a switch, add an optional `updatedBy String?` column to
your flag model. `Features.list()` then carries `updatedBy` and `updatedAt`.
Without the column the write still happens, and a warning is logged once.

## Row locks: `lock` on `find*` queries (#627, #632)

`findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow` and
`findMany` accept `lock: "update" | "share"`, or
`{ mode, skipLocked: true }` / `{ mode, noWait: true }`, inside
`Model.transaction` / `DB.transaction`. On Postgres the query ends with
`FOR UPDATE|SHARE OF "<table>"`, so only the queried model's rows are locked.
Included relations are not locked. Outside a transaction a locking read throws
`LockOutsideTransactionError`. On SQLite the lock is validated but does nothing,
since SQLite transactions already run one writer at a time. Results are typed
exactly as the same read without a lock.

## Changing the session query: `UserProvider.sessionSelect()` (#349, #633)

`findSession`, `updateSession` and `createSessionV2` now all query with
`select: this.sessionSelect()`. The default returns `SESSION_SELECT`, now
exported from `gemi/kernel`, which is the same select as before. Override it to
add columns or order or filter `accounts`, spreading `SESSION_SELECT`. Type the
provider as `UserProvider<AppSession>` (derived with `Payload<...>`), so all
three queries return the extra fields typed. `AuthManager` accepts any
`UserProvider<...>`. Existing providers compile and behave unchanged.

# Upgrading from 0.69 to 0.70

One behaviour change in `<Form>`, and new, opt-in session-token APIs. Nothing to
rewrite unless a `<Form>` of yours passes `onSubmit` or `ref`.

## `<Form onSubmit>` no longer replaces gemi's submit, and `ref` works — behaviour change

An `onSubmit` passed to `<Form>` used to replace gemi's handler, so the browser
submitted the form natively and no request was sent. It is now called alongside
gemi's handler, after the default is prevented, and the request is sent. It
cannot cancel the request, and calling `event.preventDefault()` in it changes
nothing. To skip a request, return `false` from the new
`onSubmitStart(formData, form)`, which runs just before the request with the
exact `FormData` that will be sent. `onSettled(form)` runs after `onSuccess` or
`onError`.

A `ref` passed to `<Form>` used to replace gemi's internal ref, so every submit
returned early. It now receives the `<form>` element and submits still send.

**What to check:** a `<Form>` that passed `onSubmit` in order to take over the
submit itself. That never worked as a `Form`, because no request was sent. Move
the logic into `onSubmitStart` (and return `false` if the request should not
go), or use `usePost` and friends directly. (#622, #628)

## Session tokens: public helpers and an opt-in migration from pre-0.64 tokens

`mintSessionToken`, `isSessionToken` and `SESSION_TOKEN_PREFIX` are now exported
from `gemi/services`.

Apps upgrading from before 0.64 can convert old session tokens on first use
instead of signing everyone out. Set `auth.migrateLegacySession`, a function
that gets the old session and answers `true` to convert it. gemi then writes a
`v2.` session, deletes the old row and rotates the cookie. Leaving it `null`,
the default, keeps today's behaviour: a non-`v2.` token is refused without a
lookup. See "Converting sessions from before 0.64" in the authentication docs.
(#621, #629)

# Upgrading from 0.68 to 0.69

Two behaviour changes, both of them statuses that used to be wrong. Nothing to
rewrite unless you were relying on one of them.

## A missing record answers 404, not 500 — behaviour change

`findUniqueOrThrow`, `findFirstOrThrow`, and `update`/`delete` on a row that is
not there raise the ORM's `RecordNotFoundError`. It is a plain `Error`, and the
HTTP layer gave a non-500 status only to a `RequestBreakerError` — so the most
ordinary route there is answered **500** for an id that simply does not exist:

```ts
// GET /api/pages/:pageId
"/pages/:pageId": this.get((req) =>
  Page.findUniqueOrThrow({ where: { publicId: req.params.pageId } })),
```

The 500 carried `No Page found (Page.findUniqueOrThrow).` as its body, which
also told anyone who could guess a url what the model was called.

It is now a 404 with the body `FileNotFoundError` and an unmatched api route
already answer — `{ "error": { "message": "Not found" } }` — under
`Cache-Control: no-store`, because creating the record changes the answer at the
same url. The model name and the operation stay out of the response and go to
the log.

**It is no longer reported to `onRequestFail`.** A route keyed on an id answers
this for every stale link and every crawler, and reporting them buries the
failures that really are the server's. It is still a 404 in the access log. If
you were counting on the report to catch an `update` against a wrong id, that
one is now quiet — catch it at the call site instead:

```ts
try {
  await Page.update({ where: { id }, data })
} catch (error) {
  if (!isRecordNotFoundError(error)) throw error
  // your own handling
}
```

`isRecordNotFoundError` is exported from `gemi/orm`. Use it rather than
`instanceof`: it also matches across a duplicate copy of `gemi/orm`, which is
the same reason `isUniqueConstraintError` exists.

**What to check:** a client that branched on 500 for a missing record, and any
alerting keyed on `onRequestFail` for these.

## A view whose record is missing renders your `404` view — behaviour change

`ViewRouteDispatcher` set `is404` only when no route matched the *path*, so
`/pages/:pageId` with an unknown id rendered the page anyway: the prefetch
failed during SSR, the server fell back to client rendering, the browser retried
the same failing query, and the status told crawlers the page exists.

A `RecordNotFoundError` from a view middleware or a loader now makes the request
an unmatched one, which is exactly what a gated route (`.feature()`) already
does — so you get the application's `404` view, a 404 status on a page load, and
the `404` view on a client navigation, indistinguishable from a path that was
never routed.

Guard the route at the top of the loader:

```ts
"/pages/:pageId": this.view("PageBuilder", async (req) => {
  await Page.findUniqueOrThrow({
    where: { publicId: req.params.pageId },
    select: { id: true },
  });
  Query.prefetch("/pages/:pageId", { params: { pageId: req.params.pageId } });
}),
```

Two details worth knowing:

- **A `.json` client navigation answers 200 carrying `is404`, not a 404 status.**
  That is not an oversight: the client's payload loader treats any non-ok
  response as "nothing usable came back" and leaves the current route on screen,
  so a 404 status there would strand the browser on the previous page. The 404
  travels in the envelope, the same way an unmatched path and a gated route
  already reach the client router.
- **A prefetch that 404s does not make the view a 404.** A prefetch for a
  secondary panel should not hide the whole page; the explicit check in the
  handler is what decides.

## Two dev servers can run side by side

`gemi dev` used to leave Vite's HMR websocket on its default port, so every dev
server bound 24678. `PORT` moved the HTTP server and nothing else, and a second
one logged `WebSocket server error: Port undefined is already in use` and then
hot-reloaded on the *other* checkout's file changes.

gemi now picks the port, derived from `PORT` so two servers differ before either
binds: `5173` still gets `24678`, and a single dev server on the default port is
unchanged.

**One thing to check:** a dev server on a *non-default* `PORT` now gets a
non-default HMR port — `PORT=3000` derives 22505. If a container mapping, proxy
or firewall rule pins 24678 for such a setup, set it explicitly:

```ts
// gemi.config.ts
vite: { server: { ws: { port: 24678 } } }
```

`server.ws`, not `server.hmr` — the latter's port/host/path options are
deprecated in Vite 8 and warn on every boot.

# Upgrading from 0.67 to 0.68

One breaking change and one addition. The breaking one is the first section
below: an agent run no longer takes a request.

## Agent runs take a `context`, not a `req` — breaking

`Agent.stream()` no longer accepts `req`, and tools no longer get `ctx.req`.
A run is given an `AgentContext` instead: the data and functions its tools need,
such as who the run is for, the ids it is about, and callbacks like a notifier.
The app declares the shape once:

```ts
declare module "gemi/ai" {
  interface AgentContext {
    userId: string | null;
    notify?: (message: string) => Promise<void>;
  }
}
```

Tools read it as `ctx.context`, and every sub-run started with `ctx.runAgent`
gets the same object. If the interface has a required field, `Agent.stream()`
refuses to compile without a `context`. With none, `context` is optional and
defaults to `{}`.

Why: a run needed an `HttpRequest`, and one could not be built outside a request.
`new HttpRequest()` in a queued job throws before a model is ever called, so an
agent could only run from a controller. Now a job passes what it knows:

```ts
await agent.stream({ messages, turn: { text }, context: { userId: job.userId } }).result();
```

What to change:

- **`AgentController`:** override the new `context(req, { body })` and move there
  whatever your tools read off the request. It runs once per turn, after
  `authorizeRequest()`. The default returns `{}`, so if your `AgentContext` has a
  required field, you must override it. The compiler cannot see that for you.

  ```ts
  context(req: HttpRequest<any, any>) {
    const user = req.ctx().user;
    return { userId: user ? String(user.id) : null };
  }
  ```

- **Tools:** replace `ctx.req.ctx().user` and similar with `ctx.context.<field>`.
  During a run started from an **api** route, ambient request state such as
  `Auth.user()` and policied queries still works, because the run executes
  inside that request and holds it open until it settles.

  Do not rely on that anywhere else. Only api routes honour the hold: a view
  request ends regardless, so a run started from a view loader has its request
  torn down mid-run and a tool's `Auth.user()` will re-resolve from the token or
  throw. A run from a job has no request at all. Putting what the tools need in
  `context` is the rule; ambient state is a convenience that happens to survive
  in one case.
- **Direct `agent.stream({ ..., req })` calls:** drop `req` and pass `context`
  if your tools need it.
- **MCP tools (`toAgentTools`):** no change. They act as the user by that user's
  credentials, so they read the request the run is executing inside. From a
  run with no request they now return a tool error that says so, rather than
  dispatching.
- **Controller hooks** (`AgentHookContext`) still get `req`: they belong to the
  request, not the run.

## New: `useChat`'s `onToolProgress`, the per-yield sibling of `onToolResult`

A tool whose `execute` is an async generator can now be reacted to per yield,
not only when it returns:

```tsx
const { messages } = useChat("/chat", {
  onToolProgress: (progress) => {
    if (progress.name === "buildPage") refetchSection(progress.data.section);
  },
});
```

It is for a tool that **saves its work in stages**. One that builds a page
section by section has something worth refetching after each section, and
`onToolResult` does not arrive until the last one is done — until then the user
is looking at a page the server has already moved past.

`progress` is `{ toolCallId, name, data }`, discriminated on `name` exactly as
`onToolResult`'s part is: checking it narrows `data` to what that tool yields.
A tool whose `execute` returns a promise cannot yield, so its `data` is `never`.
The type is exported as `ToolProgress` from `gemi/ai/client` for apps that write
the handler as a named function.

Three things it deliberately does not do:

- **It does not fire for progress this client already had.** A reattach, or a
  run replayed onto a restored transcript, redelivers yields — and an app
  refetching in here would refetch on every refresh. It fires only when the
  value actually joined the call's log.
- **A sub-agent's yields do not fire it**, the same line `onToolResult` draws.
  They belong to the parent tool call that started the sub-run and are reduced
  into that call's own nested transcript.
- **It is not needed to render the log.** Yields are in the transcript already,
  on the tool call's `progress` array. This is for *acting* on one.

This one is purely additive: nothing about `useChat` changes until you pass the
callback.

# Upgrading from 0.66 to 0.67

## `required` accepts values it used to reject — behaviour change

`required` tested `.length`, which is `undefined` for anything that is not a
string, an array or a Blob. So a number failed it, a boolean failed it, and a
plain object failed it — a 400 on a correct request, from the rule meant to catch
the incorrect ones.

It now asks whether the field is present:

| value | before | now |
|---|---|---|
| `{ a: 1 }`, `5`, `true` | rejected | **accepted** |
| `0`, `false` | rejected | **accepted** |
| `"hi"`, `["x"]` | accepted | accepted |
| `""`, `[]`, `null`, empty upload | rejected | rejected |

**`0` and `false` now pass.** If you were relying on `required` to reject them —
which is to say relying on this bug — add an explicit rule instead: `gte:1` for a
quantity that must be positive, or your own check for a flag that must be true.
`required` means present, not truthy.

Two smaller changes in the same rule table:

- **`min` / `max` read length only from strings and arrays.** They always meant
  length and still do; what changed is that a value which merely *has* a `length`
  property no longer satisfies them. A JSON body of `{"tags": {"length": 5}}`
  used to pass `min:3`, because the client picks the field names.
- **`gte:` and `lte:` are new**, for numeric magnitude. Additive; nothing existing
  changes meaning. `min:3` on a string is still three characters, and `gte:3` on a
  number is three.

Unchanged and worth knowing: `string` and `boolean` appear in the schema key type
but have no implementation, so they check nothing. Making them enforce would start
rejecting requests apps accept today, so it is left for a deliberate decision.

`fileType:` and `fileSize:` also now typecheck. They were declared with quotes
instead of backticks, making them the literal text `` `fileType:${string}` ``
rather than template literal types, so `fileType:image/png` was a type error while
the runtime handled it fine. If you cast around that, you can drop the cast.

## The default `FileSystemDriver` folder moves out of `undefined/`

`new FileSystemDriver()` with no argument used to write to `./undefined/storage`.
Its constructor default was `` `${process.env.ROOT_DIR}/storage` ``, evaluated
while `app/config/filesystem.ts` was being read — which happens *before* the
server sets `ROOT_DIR` — so the string interpolated `undefined` and froze that
way for the life of the process.

It failed silently, which is why it lasted: reads and writes agreed on the same
wrong folder, so nothing threw and nothing 404'd. Files simply accumulated in a
stray `undefined/` directory beside the project.

The folder is now resolved per access from `projectRoot()`, the same rule the
server computes `ROOT_DIR` from, so an app that configured nothing gets
`<project>/storage` — the directory it always meant.

**What to do.** If you have a `undefined/` directory at your project root, its
contents are files this bug put there. Move them into `storage/` and delete it:

```
mv undefined/storage/* storage/ && rmdir -p undefined/storage
```

Most apps will find only development uploads there. Nothing needs doing in
production unless you deployed with the default driver and are serving files it
wrote.

**If you passed a folder explicitly** — including the
`new FileSystemDriver(`${process.cwd()}/storage`)` workaround — nothing changes.
An explicit path still wins and is never overridden.

# Upgrading from 0.65 to 0.66

Additive, with one exception that only touches test code. Nothing in an app's
runtime behaviour changes.

## New: image generation and editing in `gemi/ai`

`ImageModel.create({ name, provider, size, quality })` with `.generate()` and
`.edit()`, over `OpenAIImageProvider` / `AzureOpenAIImageProvider`. Inside an
agent tool, use `ctx.generateImage(model, params)` and `ctx.editImage(...)`
instead of calling the model directly — they memoize the render against the tool
call, so a tool that escalates and is replayed does not pay for the image twice.

They answer an `Attachment` rather than bytes for that reason: the memo lives in
the message history and cannot hold an image. `ctx.attachments.file(id)` hands the
bytes back, and copying them under a storage key of your own is what makes a
generated image outlive the run.

Nothing existing calls any of this, so upgrading changes nothing until you do.

## `ToolContext` gained two members — a compile error in hand-built contexts only

`generateImage` and `editImage` are required members of `ToolContext`. The
framework builds every real one, so this cannot fail at runtime; what it can
break is a **test** that constructs a `ToolContext` literal to exercise a tool's
`execute` in isolation. Such a literal now fails to typecheck.

Add the two members, or — simpler and what we would suggest anyway — type the
helper as `Partial<ToolContext>` and cast at the call, since a test that does not
generate images has no business supplying those two.

## `Usage` gained `imageInputTokens` and `imageOutputTokens`

Both optional, both absent on usage from a text call. They are a **breakdown** of
`inputTokens` / `outputTokens`, not a separate bucket — the provider's own totals
already contain them, the same way `reasoningTokens` sits inside `outputTokens`.
Anything summing the existing fields keeps working and keeps being correct.

## A timed-out provider request is no longer always retried

`requestWithRetry` gained `retryTimeouts`, defaulting to the previous behaviour,
and only the image path passes `false`. Streaming calls are unaffected: their
timer covers the handshake, so a timeout there means nothing was generated and
retrying is free. For a call that returns its whole result in one body the timer
bounds the work, and a retry pays for it again — measured, a `quality: "high"`
1536x1024 render takes 117.8 seconds against a 120-second default, so one request
could become three billed renders and then an error.

If you call `requestWithRetry` directly — you almost certainly do not; it is not
exported from `gemi/ai` — the default is unchanged.

# Upgrading from 0.64 to 0.65

## A relative SQLite `DATABASE_URL` now means what Prisma means by it — behaviour change

`DATABASE_URL=file:./dev.db` used to open two different files. Prisma resolves a
relative SQLite path against the directory holding the schema, so `prisma migrate`
wrote `prisma/dev.db`; gemi resolved it against the process working directory and
opened `./dev.db`, which SQLite then created, empty. Every query failed with
`no such table` against a database that had connected fine.

gemi resolves it the way Prisma does now. **For most apps this is the fix and
nothing else**: keep `file:./dev.db` and both tools open `prisma/dev.db`.

Two cases need action.

**If you worked around this by hand.** Anyone who hit it wrote either
`file:./prisma/dev.db` for gemi, or a second variable pointing the two tools at one
file. Both stop being workarounds and become wrong: `file:./prisma/dev.db` now
resolves to `prisma/prisma/dev.db`. gemi refuses to start rather than open the
empty file — `AmbiguousSqlitePathError`, naming both paths — when the location it
used to open still holds a database. Point `DATABASE_URL` at `file:./dev.db` and
delete the extra variable.

**If you keep a second SQLite connection.** Only the url your Prisma datasource
actually names is resolved. A connection declared under `connections` with some
other url is left exactly as it was, because Prisma has never migrated it.

Untouched either way: `:memory:` in every spelling, an absolute path, every
networked dialect, and any app with no `prisma/schema.prisma` or whose datasource
is not SQLite.

## A run cut off by the output ceiling hands back no output — behaviour change

`Agent.create` takes `maxOutputTokens` and `temperature` now, and a run that hits
either the cap you set or the model's own ends with `finishReason: "length"` and
**no `output` value**.

That is a change for an app that declares an `output` schema, whether or not it
sets a cap — `length` has always been reachable from the model's own ceiling:

- `result().output` is `undefined` on a truncated run. It used to be the
  best-effort parse of the half-written JSON, which for a loose schema (anything
  built with `s.json()`) parsed cleanly and was indistinguishable from a finished
  answer. That is the reason for the change.
- The schema-mismatch `error` event a truncated prefix used to raise when it
  failed `safeParse` is gone. One answer for every schema now: no output, and a
  finish reason that says why.

Branch on `finishReason === "length"` where you were reading `output` or
listening for that error:

```ts
const result = await agent.stream({ ... }).result();
if (result.finishReason === "length") {
  // Ask again, more compactly. There is no partial answer to salvage.
}
```

The transcript agrees with `result()`: a truncated message carries no `output`
part, and `outputTruncated: true` is set on the `message-end` frame **and on the
message itself**, so a live client and a transcript restored from `onMessage`
answer the same way. It is the field to render "the answer was cut short" from,
and it exists because `finishReason` cannot say it — a step that hits the ceiling
while also calling a tool closes its message `awaiting-input` or `max-steps`.
If you have ported the reducer yourself, that is the one frame field to add.

## `ProviderStreamParams.output` requires `strict`

Only relevant if you build a `ProviderStreamParams` yourself — a custom provider,
a recorded-request harness. `output` went from `{ name, schema }` to
`{ name, schema, strict }`.

`strict` is derived from the schema rather than chosen: a schema containing an
`s.json()` node cannot be sent under a provider's strict mode. It is required
rather than defaulted so that a new caller has to answer it instead of inheriting a
400 from the API. `supportsStrict(schema)` from `gemi/ai` gives the right value.

## The union of every view path is exported as `ViewPaths`

`Link` became overloaded in 0.63 so that it could accept an external URL as well
as a route, and an overloaded component has no single `ComponentProps`. So
`ComponentProps<typeof Link>["href"]`, which an app on 0.62 could use to name every
view path, stopped compiling — `Property 'href' does not exist on type '{}'`, the
same error the 0.62 → 0.63 notes below show. 0.64 exported `LinkProps` to replace
it, but `LinkProps` takes the path as a type parameter, and the union to put there
was not exported: the map behind it is internal.

```ts
import type { ViewPaths } from "gemi/client";

// Every view path the app declares. `LinkProps<ViewPaths>["href"]` is the same
// type, if you would rather derive it.
function BackLink({ to }: { to: ViewPaths }) { /* ... */ }
```

Two things about it are worth knowing before you put it in a signature.

**It is `never` in a file where the app's route augmentation does not resolve.**
`ViewPaths` is built from an interface `gemi.d.ts` augments against
`@/app/http/routes/view`, so a shared package in a monorepo, an app on a `src/`
layout, an app using a different alias and a playground all see an empty union
rather than a permissive one. A component in a shared package declaring `to:
ViewPaths` compiles there and fails at every call site with "not assignable to
type `never`". That is not new — `Link` itself is unusable in those files for the
same reason — but it is the first time the type has a name you can put in your
own code, so it is the first time it will be read as a bug in yours.

**Its members are route patterns, not URLs.** `/orgs/:orgId/reports` is a member.
It is what `Link`, `Redirect`, `useNavigate` and `Url` take, alongside the
`params` that fill it in; it is not something to put in an `href` directly.

## Navigating to a path built at runtime compiles again — behaviour unchanged

`push`, `replace` and the prefetcher accept a path your code built — what
`useIntendedUrl()` returns, a redirect target off an API response — and that
stopped compiling as soon as an app declared its first parameterised route:
`TS2554: Expected 2 arguments, but got 1`. It is fixed, and nothing about how a
route is navigated changed.

One narrowing comes with it. The options for a runtime-built path take
`params?: Record<string, string | number | undefined>`, so passing an **array**
is now a `TS2322` where it used to compile:

```ts
const path: string = "/docs/:rest*/edit";
push(path, { params: { rest: ["a", "b"] } });   // TS2322 since 0.65
push(path, { params: { rest: "a/b" } });        // and this is what you wanted
```

That call was already broken. `applyParams` does `String(value)`, so the array
produced `/docs/a,b/edit` — a comma, not a path. The spelling on the second line
is the one that builds the url you wanted, and it compiled before this release
too; what changed is that the array no longer does. Only runtime-typed paths are
affected: a declared wildcard route still takes `params: { rest: string[] }` and
still requires it.

# Upgrading from 0.63 to 0.64

This release fixes session and account-recovery tokens that could be computed
by anyone who knew a user's email. **Check `SECRET` is set before you deploy,
and expect every user to sign in once more.** Almost no code has to change —
the two `UserProvider` notes below cover the exceptions, if you stub
`findSession` or override `updateSession` yourself.

## Session tokens are minted, and a sign-in never extends someone else's session — security

A session token used to be `sha256(email + User-Agent)`. Anyone who knew a
user's email and could guess their client (a native app sends a fixed
User-Agent) could compute a token the server accepted, from a cookie or the
`access_token` header. The same token came back on every sign-in, and a user
who later took over the email address was handed the previous owner's session.

Every sign-in now creates a new row with a token of its own:
`v2.` + HMAC-SHA256(secret, user id + 16 random bytes).

The secret is the app's existing `SECRET`, which CSRF and agent approvals
already use. **Check it is set, and not the template's placeholder, before
you deploy**: without it, signing in fails. The token is looked up, not verified against the
secret, so changing the secret later signs nobody out.

## Session expiry is enforced — behaviour change

`expiresAt` and `absoluteExpiresAt` were written but never checked; only a
browser's cookie `Expires` honoured them, so a token sent in the
`access_token` header never expired. `AuthManager.getSession` now treats a
session past either one as no session, and deletes it.

`sessionExpiresInHours` is now an idle timeout, as the docs always said: a
session used after half of it has passed is pushed to `now + N` hours, capped
at `absoluteExpiresAt`, and the cookie is written again. A browser user who
stays active is no longer signed out once a day.

## Existing sessions end — every user signs in again

A token issued before this release is computable, so it is no longer a
session: `getSession` refuses any token that doesn't start with `v2.`, from a
cookie or the `access_token` header, without looking it up. Each user signs
in once more after the deploy and gets a minted token.

If your native app has no path back to its sign-in screen when a request
answers `401`, ship one before you deploy.

If signing everybody out is not acceptable, a later release lets the app convert
the old tokens on first use instead: set `auth.migrateLegacySession`, described in
[Authentication](./docs/authentication.md#converting-sessions-from-before-064),
and delete the rows below once its sunset has passed.

The old rows grant nothing, but they still hold computable tokens. Delete
them:

```sql
DELETE FROM "Session" WHERE token NOT LIKE 'v2.%';
```

**If you stub `UserProvider.findSession` in tests**, two things matter and they
are separate. The token the test *asks* with has to start with `v2.`:
`getSession` checks its argument and returns before the lookup, so a stub that
returns a `v2.` row is no help if the call passes a bare one. And the row it
*returns* needs `expiresAt`/`absoluteExpiresAt` more than half of
`sessionExpiresInHours` away, or `getSession` counts the session as spent, or
slides it through `updateSession` — which a stub usually doesn't have either.

**If you override `UserProvider.updateSession`**, `UpdateSessionArgs` no longer
carries `absoluteExpiresAt`. It only ever arrived when a legacy session was
being retired, and nothing retires one now. An override that wrote it when
present is simply never asked to again; one that took it as required stops
typechecking. `absoluteExpiresAt` is stamped once, at creation, and nothing
moves it afterwards — it is what bounds a session whose owner never goes idle,
so a provider that slid it along with `expiresAt` would mean the cap never
arrives.

## Signing out revokes the header transport too, and no longer answers `401`

`POST /auth/sign-out` read the `access_token` cookie, and resolved the user
through `Auth.user()`, which reads the cookie too. A client authenticating
with the `access_token` header therefore got a `401` — thrown before the
revocation — and its row stayed in the table with its token still valid. The
token is now taken from the cookie or the header, in the order the `auth`
middleware uses, and the row is deleted either way.

A sign-out with nothing behind it — no token, or one that has just run out,
which enforcing expiry above makes an everyday case — now clears the cookie
and answers `{}` rather than refusing. The old `401` left that stale cookie in
the browser with nothing able to clear it.

`onSignOut` is unchanged where it fired before: it is handed the session's
user, extended as always. It does not fire for a sign-out that had no session
to revoke, so an override may assume its argument is a real user.

## Password-reset, email-verification and magic-link tokens are random

Their defaults were `sha256(email + Date.now())`. Someone who requested a
reset for another user's email could try each millisecond around their own
request and reset that user's password. They are now 32 random bytes. A
token already sent by email keeps working until it is used. If you override
`generateForgotPasswordToken`, `generateEmailVerificationToken` or
`generateMagicLinkToken`, check that yours can't be computed from the email
and the time either.

# Upgrading from 0.62 to 0.63

Almost no code has to change, but several responses do: a refusal now answers
`403`, and an unhandled error in production answers a generic `500`. Nothing
here fails to compile, and a server-side test suite only notices where it
asserts on a status. **Check what your clients do with these responses before
you deploy** — especially a shipped native client, which cannot be updated in
the same deploy as the server.

**One schema migration**, and only if your app has social sign-in:
`SocialAccount` needs a `providerId` column and a new unique index. It is the
one change here that fails at runtime rather than changing a status code —
see [A social account is identified by
`(provider, providerId)`](#a-social-account-is-identified-by-provider-providerid--needs-a-migration).

## `InsufficientPermissionsError` answers `403`, not `401` — breaking

`Auth.guard()` throws it, and so does any middleware of yours that throws it
directly.

| | 0.62 | 0.63 |
|---|---|---|
| API route | `401` `{ error: "Insufficient permissions" }` | `403`, same body |
| View data (a `.json` navigation, from a loader or view middleware) | `401` `{ data: { error: "Insufficient permissions" } }` | `403`, same body |
| Full page load (same place) | `400` (the view dispatcher's default) | `403` |
| `error.name` / `error.message` | `"AuthenticationError"` / `"Authentication error"` | `"InsufficientPermissionsError"` / the refusal, `"Insufficient permissions"` by default |

A `.json` navigation is how gemi's own client router fetches a view's data,
and it answers from the same payload an API route does. So it changed the way
the API did, not the way the page did.

`401` tells a client to re-authenticate, so a client that sends every `401` to
sign-in looped a signed-in user without the role straight back to where they
started. A request with no user still answers `401`: that is
`AuthenticationError`, thrown by `Auth.user()` before the guard's predicate
runs.

`AuthorizationError` still answers `401`, but its name and message changed the
same way: it was also `"AuthenticationError"` / `"Authentication error"`, and
it is now `"AuthorizationError"` with the refusal as its message (`"Not
authorized"` by default).

**Who breaks:** a client that branches on `401` for this refusal: one that
refreshes or retries on `401` only, or one that shows "you don't have access"
for a `401`. That includes a native client that fetches `.json` view data. A
test asserting `payload.api.status === 401` for it also breaks. Server code,
an `onRequestFail` or `onException` hook, or a log filter that matched
`name === "AuthenticationError"` to catch every auth refusal now misses both
`InsufficientPermissionsError` and `AuthorizationError`. Match on
`instanceof` for each class instead.

**Keeping `401` while your clients catch up.** Set the old status once, at
module scope in `app/kernel/Kernel.ts`, and delete the line when every client
you still support handles `403`:

```ts
import { InsufficientPermissionsError } from "gemi/http";

InsufficientPermissionsError.apiStatus = 401;
```

That restores `401` everywhere it used to be: API routes and `.json` view
navigations. A full page load answers `403` either way, since no client could
have depended on the `400` it replaced.

## An error thrown by an `Auth.guard()` predicate is no longer a refusal

In 0.62, `guard` caught anything the predicate threw and answered it as
`InsufficientPermissionsError`, so a database outage reached the client as
"you may not do this" and never reached `onRequestFail`. It now propagates as
itself: a `500`, reported like any other failure.

A policy denial raised inside the predicate — a model read the policy refuses —
propagates the same way, and so reaches `onRequestFail` now. It is then
answered like any other policy denial (next section): it goes from `401`
`"Insufficient permissions"` to `403` `{ error: { message: "Forbidden" } }`,
and `apiStatus` does not bring the `401` back. If that denial is an expected
refusal rather than something to report, return `false` from the predicate
instead of letting the read throw. `Auth.guardSafe()` is unchanged: it still
treats a throw as `false`.

## A policy denial answers `403`, not `500`

A `PolicyDeniedError` from a handler or middleware used to answer `500`, and
the body carried the policy's message. On API routes it now answers `403`
`{ error: { message: "Forbidden" } }`. From a view loader or view middleware,
including a loader's `Query.instant` refused with `403`, it answers `403` too:
the API body on a `.json` navigation, and a `403` page otherwise.
`onRequestFail` still receives the original error, message included.

A client or monitor that treated these `500`s as server faults and retried
them now sees a refusal instead. A client that displayed the policy's message
from the body no longer gets it.

## In production, an unhandled error answers a generic `500`

The body used to carry the error's text: `/api` answered the raw
`err.message`, and a failed page render answered its stack trace as
`text/plain`. `/api` now answers `{ error: "Internal Server Error" }`, and a
page answers a generic HTML `500`. The error still goes to `console.error`,
and `onException` now runs for `/api` failures as well, which it used to
skip. A client that showed a server error's message to the user shows the
generic one now. Development is unchanged.

## A missing `.js` file reloads the page only under `/assets/`

When a chunk a page asks for is missing from `dist/client`, `gemi start`
answers with a module that reloads the page. It used to do that for any
missing path containing `.js`, including `app.js.map` and anything outside
`/assets/`. Now it does it only for a `.js` or `.mjs` file under `/assets/`,
and sends `Cache-Control: no-store` so no browser or CDN caches the stub. A
missing source map under `/assets/` answers `404`, and a missing `.js` path
elsewhere goes to your routes like any other request. Nothing to change unless
something relied on the reload for a script outside `/assets/`.

A new, optional [asset base](docs/configuration.md#asset-base)
(`GEMI_ASSET_BASE` or `assetBase` in `gemi.config.ts`) serves the client
build from a CDN. Unset, every asset URL is what it was — unless
`gemi.config.ts` already sets an absolute `vite.base`: the document's client
entry, `modulepreload` hints, loaders and navigation stylesheets now use that
base too, where they used to be root-relative. Check that whatever sits in
front of the app answers `<vite.base>assets/*`.

## Everything under `/assets/` is served from `dist/client`

`gemi start` used to decide what was a file by an allowlist of extensions, so
a `.woff2`, `.gif` or `.json` Vite emitted into `assets/` went to your routes
instead and came back as a rendered 404 page. Now every path under `/assets/`
is served from `dist/client` whatever its extension, and a miss there answers a
plain `404` without reaching your routes. Root-level public files are still
recognised by extension; the list gained `gif`, `xml`, `webmanifest`, `woff`,
`woff2`, `otf`, `webm`, `mp4`, `mp3` and `pdf`, and a path with one of those
extensions that has no file behind it still goes to your routes. Nothing to
change unless a route of yours answers a path with one of those extensions
*and* `public/` has a file at the same path: the file now wins.

## `SIGTERM` drains the server, and `gemi start` exits with its code

`gemi start` used to ignore signals and exit `0` whatever its server did. Now
it relays `SIGTERM` and `SIGINT` to the server, and the server stops accepting
connections, lets in-flight requests finish, runs each provider's new
`shutdown()` hook, and exits — within 25 seconds by default. `gemi start`
exits with the server's code, so a crashed server is no longer reported as a
clean exit. See
[Graceful shutdown](docs/configuration.md#graceful-shutdown).

What to check:

- **A platform that allows less than 25 seconds** between `SIGTERM` and
  `SIGKILL` (Cloud Run, Fly) cuts the drain off. Lower
  `GEMI_SHUTDOWN_TIMEOUT` and `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` to fit. Either
  may be `0`, which skips that phase rather than reporting it as a failure.
- **A wrapper that works around the dropped exit code**, or that relays
  signals to the server's process itself, can stop doing so. Signalling the
  process group still works: the copies of one signal that reach the server
  within a second — directly and through `gemi start` — count as one shutdown.
  Only a signal more than a second after the first skips the drain.
- **An app that installed its own `SIGTERM` listener** now runs beside gemi's,
  which exits the process when the drain is done. Pass
  `handleSignals: false` to `new Server()` to keep only yours.
- **`gemi dev` and `gemi run` relay the same two signals** to what they
  spawn, and wait for it. A `SIGTERM` to either used to end the CLI alone,
  leaving the dev server on its port or the command running unwatched. A
  command ended by a signal now makes `gemi run` exit `128 + n` (`143` for
  `SIGTERM`) where it exited `1`; a script that tests for exactly `1` should
  test for non-zero.
- **A request that arrives after the drain is answered `503`.** Bun leaves a
  kept-alive connection open after the listener closes, so a client that
  ignores `Connection: close` could still reach your routes while the
  providers shut down. Such a request now gets `503` with `Connection: close`
  and never reaches the app or its instrumentation.

## The queue runs over a driver, and `Job.dispatch()` returns a promise

Jobs are still kept in memory by default and **still lost when the process
exits**. What changed is that the memory queue is now one `QueueDriver`
among any an app supplies (`defineQueueConfig({ driver })`), and the manager
around it changed shape to suit.

**`Job.dispatch()` returns `Promise<string>`, the job's id, instead of
`void`.** A call that ignores the result still compiles, and with the memory
driver the promise never rejects. A lint rule such as
`@typescript-eslint/no-floating-promises` will now flag an unawaited
dispatch; await it, or mark it `void`. Arguments JSON cannot carry still throw
synchronously, as before.

**`QueueManager`'s internals are gone:** `queue`, `isRunning`,
`activeRunningJobsCount`, `next()`, and `push()`'s third argument. `push()`
returns a promise too. A test that read `app(QueueManager).queue.size` reads
the driver instead:

```ts
import { MemoryQueueDriver } from "gemi/services";

const driver = app(QueueManager).driver as MemoryQueueDriver;
expect(driver.waiting + driver.leased).toBe(0);
```

A test that held the queue with `isRunning = true` calls `await
queue.stop()`, and `queue.start()` to let it go.

**A dispatched job no longer starts inside `dispatch()`.** An idle queue used
to call the job's `run` synchronously, up to its first `await`, before
`dispatch()` returned. It now starts once the driver has recorded the job and
handed it back to the worker loop, a few microtasks later. A test that
dispatches and then asserts straight away — `SomeJob.dispatch(x);
expect(spy).toHaveBeenCalled()` — now fails; wait a macrotask first, for
example `await new Promise((r) => setTimeout(r, 0))`, before asserting.
Awaiting `dispatch()` happens to be enough with the memory driver today, but
it only promises that the job was recorded, not that it has started.

**A job no longer runs inside the request that dispatched it.** It used to
run in the async context of whichever dispatch started the drain, so a job
could read that request's user or open transaction — and every job drained
behind it saw the same one, whoever dispatched it. It now runs in the
application's context and no request's. A job that relied on the old
behaviour takes what it needs as arguments.

**Two things that used to wedge the queue no longer do:** a throw from
`onFail` or `onDeadletter` is logged and the job's slot is freed, and a full
queue wakes when a slot frees instead of polling once a second.

New, and optional: `backoff` on a job (milliseconds before each retry),
`visibilityTimeout` and `pollInterval` on the queue slice, and
`drain(timeoutMs)` / `stop()` / `start()` on `QueueManager`. See
[Jobs & Queues](docs/jobs-and-queues.md).

## Jobs can be kept in the database, and a shutdown waits for running jobs

**`driver: "database"` keeps jobs in a `gemi_jobs` table**, so a deploy, a
scale-in or a crash no longer loses them. Nothing changes until you opt in.
To opt in, add the table (the Prisma model is in
[The database driver](docs/jobs-and-queues.md#the-database-driver)), set
the driver, and make sure your jobs can safely run twice: the driver
delivers at least once, not exactly once.

A driver factory is now called with the application,
`driver: (app) => …`. A factory that takes no argument works as before.

**A replica leaves a job it has no class for to the replicas that have
it.** During a blue/green rollout both releases claim from one table, so a
job only the new release has used to be dead-lettered by whichever old
replica claimed it first. The database driver now claims only the names a
replica has registered. A job under any other name is claimed and
dead-lettered only after `unknownJobGrace`, one hour by default, when the
name is taken to be gone. With the memory driver an unknown name is still
dropped at once. See
[Deploys and unknown job names](docs/jobs-and-queues.md#deploys-and-unknown-job-names).

**A `QueueDriver` of your own needs a `release(job, { retryInMs })`**, if
you wrote one against a 0.63 release candidate. It ends a claim without
counting it: the job becomes claimable after `retryInMs` with `attempt` one
lower, and like `fail` it ignores a stale claim. `claim` may also honour
`registered: { names, graceMs }`. A driver that ignores it still works; the
queue then releases the jobs it cannot run.

**A dispatch inside a transaction waits for the commit.** `Job.dispatch()`
inside `Model.transaction` or `DB.transaction` used to record the job at
once, so it survived a rollback and could run before the commit, reading
rows that were not there yet. Now the database driver on Postgres or MySQL
writes the job's row on the transaction, and every other driver's dispatch
is held and recorded just after the commit. A rollback drops the job either
way, and so does a savepoint that rolls back. `dispatch()` still resolves
inside the transaction, to the job's id. Two things to check:

- A test that dispatches inside a transaction and asserts the job ran
  before the transaction returned now fails. Assert after it.
- With the database driver on Postgres or MySQL, a job row that cannot be
  written now rolls the transaction back, awaited or not, caught or not —
  a queued listener's dispatch included. The transaction rejects with the
  database's error, or with `TransactionDependencyError` (its `cause`) when
  the dispatch was not awaited or its rejection was caught. Before, the
  transaction committed and the job was lost with a line on stderr.

A queued listener is pushed the same way, so it no longer needs
`static afterCommit` to wait for the commit. See
[Dispatching inside a transaction](docs/jobs-and-queues.md#dispatching-inside-a-transaction).

**A `QueueDriver` of your own must honour `enqueue({ id })`**, if you
wrote one against a 0.63 release candidate: when `id` is given, record the
job under it and resolve to it. The queue passes one for a dispatch it held
until a commit. A driver can also add `joinsTransaction()`, returning `true`
when its `enqueue` will write into the caller's open ORM transaction; the
queue then hands it the job inside the transaction instead of holding it.

What changes for every app, whatever the driver:

- **A production server told to stop now waits for its running jobs.** The
  queue provider's `shutdown()` stops claiming and waits for them within
  `GEMI_SHUTDOWN_PROVIDER_TIMEOUT`. With the memory driver, jobs dispatched
  while requests drain are still claimed and run before that. With a driver
  that outlives the process, claiming stops as soon as the signal arrives,
  and waiting jobs are left to other replicas. A job still running then
  makes the shutdown exit with code 1. That code used to be 0 whatever
  happened to the job. If your jobs take longer than 5 seconds, raise the
  timeout to fit the platform's grace period.
- **With a custom durable driver, a dispatch outside a server no longer
  runs jobs.** A console command, seed or script that dispatches records the
  job and leaves it for a server. Before, it started claiming from the shared
  driver and could exit in the middle of the jobs it took. The memory driver
  is unchanged.
- **A dispatch wakes a polling driver's queue at once.** Before, it waited up
  to `pollInterval`. The memory driver was never polled, so apps that use it
  see no difference.
- **The database driver gives a SQLite connection a one-second busy
  timeout** if it has none. Before, a write that met another process's lock
  on the file failed at once with `SQLITE_BUSY`. Now it waits up to a
  second, and the process is blocked while it waits. With
  `driver: "database"` this is the app's default connection, so the ORM's
  writes wait too. Pass `{ busyTimeout: 0 }` to the driver to keep the old
  behaviour.
- **Jobs can run in worker processes of their own.** `gemi queue:work`
  boots the app and claims from the queue without serving HTTP, and
  `GEMI_QUEUE_CLAIM=off` stops a server claiming, so web and worker
  replicas scale separately. Both need a driver other processes can reach,
  such as `"database"`. Nothing changes unless you use them. See
  [Worker processes](docs/jobs-and-queues.md#worker-processes--gemi-queuework).
- **Under `gemi dev`, a save hands the database queue to the new code.**
  Before, the loop from before the save kept claiming rows with the old
  code, one more loop per save, until `gemi dev` was restarted. Now the
  reloaded application stops it and claims in its place.

## A shutdown stops the cron schedule and waits for running ticks

The scheduler provider now has a `shutdown()`. When a production server is
told to stop, it stops the schedule once requests have drained, so no new
tick starts, and waits for the ticks already running within
`GEMI_SHUTDOWN_PROVIDER_TIMEOUT`. Before, the schedule kept firing until the
process exited, and a running tick was cut off halfway through. A tick still
running at the deadline is named in the log, `Cron jobs still running at
shutdown: …`. If your cron jobs take longer than 5 seconds, raise the timeout
to fit the platform's grace period.

The cron drain runs before the queue drain and both come out of that one
timeout. Before, the queue had all of it; now a long-running tick can leave the
queue almost nothing, so its running jobs are abandoned (and, with the memory
driver, its pending ones lost). Budget for the longest tick plus the longest
job.

`Scheduler` gains `drain(timeoutMs)` and `running`. See
[Stopping the schedule](docs/cron.md#stopping-the-schedule).

## A social account is identified by `(provider, providerId)` — needs a migration

**Only if your app has social sign-in.** The OAuth callback now resolves a
returning login by the provider's own stable identifier — Google's `sub`, X's
user id — before it looks at anything else, so a user who changes their email
or display name at the provider still reaches the same account, and two
accounts sharing a display name no longer collide.

`AuthController` reads it through `UserProvider.findUserBySocialAccount(provider, providerId)`,
so this is framework surface, not a template detail: a `SocialAccount` table
without the column and index breaks social sign-in at runtime.

```prisma
model SocialAccount {
  provider   String
  // The provider's stable account identifier — Google's `sub`, X's user id.
  // Nullable only for rows written before the callback recorded it.
  providerId String?
  username   String?
  email      String?

  @@unique([provider, providerId])
  @@index([userId])
}
```

The old unique key was `(username, provider)`, which constrained a display
name and left the one stable value unconstrained.

`providerId` is nullable on purpose. The old callback wrote `""` there, and a
unique index cannot hold more than one of those per provider, so carry legacy
empty values over as `NULL` — which a unique index treats as distinct — rather
than inventing an identifier from a name or an email:

```sql
-- in the backfill, however your dialect spells it
NULLIF("providerId", '')
```

Nothing needs filling in by hand afterwards: the callback claims a legacy row
with its real identifier on that user's next sign-in.

Both templates ship the Prisma migration as
`20260922000000_social_account_provider_identity` if you want a reference; an
app with its own schema applies the equivalent.

## A mutation's `onError` is handed the error, not the envelope around it

`useMutation` — and `usePost`, `usePut`, `usePatch`, `useDelete`, and `<Form>`
on top of it — used to pass `onError` the whole response body, `{ error: {...} }`,
while setting the hook's own `error` from `data.error` inside it. The callback
is typed `(error: MutationError) => void`, so the type did not describe what
arrived and no handler could read `kind`. It now receives the same value the
hook exposes:

```ts
// before
usePost("/agents", {}, { onError: (body) => report(body.error.kind) });

// now
usePost("/agents", {}, { onError: (error) => report(error.kind) });
```

If a handler of yours reaches through `.error` to get at `kind` or `messages`,
drop that step. `<Form onError={(error) => ...}>` gets the same value.

Three fixes in the same pass need no change but are worth knowing, because each
one used to put something in `error` that no `<Form>` could render:

- **Cancelling a mutation is no longer reported as a failure.** `cancel()`
  aborts the request, and the rejection used to land in `error` as a
  `DOMException` and call `onError`. It now only calls `onCanceled`.
- **A submit that was replaced no longer writes over the one that replaced it.**
  Two submits in flight used to resolve in network order, so a slow first
  submit's validation error could land after the corrected second one had
  already succeeded.
- **A rejected submit keeps the last `data`** instead of blanking it, matching
  the pending state, which has always kept it.

## Derive link prop types from `LinkProps`, not `ComponentProps<typeof Link>`

`Link` became an overloaded component in 0.63.0, and `ComponentProps` cannot
read props off an overloaded generic call signature — it comes out `{}`. Any
type derived through it silently collapses:

```ts
// 0.62: "/dashboard" | "/invoices" | …      0.63.0: Property 'href' does not
type BackHref = ComponentProps<typeof Link>["href"];  // exist on type '{}'
```

`LinkProps` and `ExternalLinkProps` are exported from `gemi/client` for this:

```ts
import type { LinkProps } from "gemi/client";

type BackHref = LinkProps<"/dashboard">["href"];
```

The same collapse is why `<Redirect>` accepted only `action` on 0.63.0, and
rejected every `href` and `params` passed to it. `Redirect` is typed against
`LinkProps<T>` directly now, so its props are back without any change on your
side.

## If you used the global middleware list in 0.63.0-rc.1

The `global` list is new in 0.63, so an app coming from 0.62 has nothing to
change. An app that adopted it on `0.63.0-rc.1` sees two differences:

- **The route starts with the user the list left.** A user a global
  middleware puts on the context, with `Auth.user()` or `ctx().setUser(...)`,
  used to stay behind; now the route's context starts with it, and trusts it.
  `auth` then checks only that an `access_token` cookie or header is present,
  and `Auth.user()` returns that user. If a global middleware sets a user it
  has not verified, from an unchecked token or an API-key header read for rate
  limits or logs, stop it doing so: keep that identity somewhere other than
  the context's user. See
  [Global middleware](docs/middleware.md#global-middleware).
- **In `gemi dev`, the list also runs for `/refresh.js` and
  `/render-error.js`.** A gate that refuses requests without a header now
  refuses those too; an exemption by path has to name them.

---

# Upgrading from 0.55 to 0.56

One change, and it is a deletion. **Do it as part of the upgrade** — leaving the
old wiring in place is not a no-op, it stops your project typechecking.

## Delete `gemi.d.ts` and its `tsconfig.json` entry

Your app root has a `gemi.d.ts`, and your `tsconfig.json` has a `types` entry
naming it:

```jsonc
// tsconfig.json
"types": ["vite/client", "bun", "./node_modules/gemi/gemi.d.ts"]
```

Delete both. The file:

```bash
rm gemi.d.ts
```

and the entry, leaving your own toolchain behind:

```jsonc
"types": ["vite/client", "bun"]
```

That is the whole migration. `gemi/client` and `gemi/facades` now reference the
augmentation themselves, so importing from either is all it takes to get
`useQuery`, `Link`, `Form`, `Query` and the rest typed against your routes.
Nothing replaces the deleted file.

**Why it is not optional.** Both of those named
`./node_modules/gemi/gemi.d.ts`, and the augmentation now ships at
`node_modules/gemi/dist/gemi.d.ts` instead. An unresolvable `types` entry is a
configuration error that `tsc` reports *instead of* compiling:

```
error TS2688: Cannot find type definition file for './node_modules/gemi/gemi.d.ts'.
```

and you get that one line and no other diagnostics, on 0.56 exactly as on 0.55.

**If it was already broken, this is the fix.** That path never resolved in a
published install — `gemi.d.ts` was not in any tarball before 0.56 — so if
`useQuery("/your/route")` has never typechecked outside this repository, or your
CI typecheck has been failing on TS2688, deleting these two things is what
repairs it rather than what breaks it.

---

# Upgrading from 0.50 to 0.51

Three changes need a hand, and the third is a look rather than an edit — it only
becomes work if you were using an unlisted job as an off switch. `bunx gemi
migrate` does none of those three for you; it is the 0.42→0.43 tool, and all
three are decisions a codemod cannot make.

Two more sections follow them, and they apply only if you are moving queries off
the Prisma client and onto gemi's ORM. Both are breaks you are not told about —
the code compiles, runs, and passes its tests on either side of the move — so
they are worth reading before the port rather than after. Those two the codemod
*does* now find and annotate; see [Both of these are annotated by `bunx gemi
migrate`](#both-of-these-are-annotated-by-bunx-gemi-migrate).

## Declare your model modules on the Kernel

**Do this even if nothing else in your app changes.** Until you do, a policy on
a model subclass is skipped inside every nested `include`.

A relation read resolves its target through the ORM registry *by name*. The
generated `index.ts` registers each base under its model's name, so unless your
own subclass replaces it there, `User.findMany({ include: { memberships: true } })`
runs the generated `MembershipModel` — which carries none of the policies you
wrote on `Membership`. Scoped at the root, unscoped inside the include, with
nothing to notice it. A model you only ever read *through* an include never
raises, because the query-time guard compares the class being run against the
registered one and they are the same class.

Put your model classes in a barrel and list it:

```ts
// app/models/index.ts
export { User } from "./User"
export { Membership } from "./Membership"
```

```ts
// app/kernel/Kernel.ts
import * as generated from "../models/generated"
import * as models from "../models"

export default class extends Kernel {
  models = [generated, models]
}
```

`boot()` registers every class those modules export under the name its schema
carries — later modules winning, so each subclass takes the name its generated
base was holding — and then refuses to start if any policied class lost its name
to something else. The `register("User", User)` lines become unnecessary; they
still work, and are still what you write for a class in a module the Kernel is
not handed.

In development, a Kernel with an empty `models` and a populated registry now
warns at boot, so an app that skips this hears about it once per start rather
than never.

See [docs/orm.md](./docs/orm.md#your-model-class) for the full rules, including
what happens with a typed view that carries its own policies.

### And then run the check once

`Kernel.models` can only audit the modules it is handed, so the mistake it
removes has a smaller version one level up: a policied class in a file the
barrel does not re-export. Nothing raises for that either.

```sh
bunx gemi check models
```

It walks `app/models`, imports every file, and reports any policied class the
declared modules do not register — with the `export` line that fixes it. Exit
code `1` on a finding, so it is worth a step in CI. It imports what it walks,
which matters if a file under `app/models` does work on import; `--ignore` takes
a comma-separated list, and the command prints what it skipped.

## Regenerate — this one is required

One command, and unlike the rest of this page it is not optional:

```sh
bunx prisma generate
```

**The schema artifact's version moved from 1 to 2**, so a `app/models/generated`
emitted before 0.51 is now refused at registration with `StaleSchemaArtifactError`
telling you to run exactly that. The bump is deliberate. Artifact version 1 also
covered a *newer* artifact being read by an *older* runtime — the two do not
travel together, because the generated directory is committed to git while the
gemi version lives in a lockfile, so a teammate who pulls without installing had
a real chance of pairing them. Version 1 said nothing in that case, and the
mismatch surfaced as a column bound to NULL rather than as an error.

Two things arrive with it, and both need the regenerate to take effect:

- **`@default(nanoid())` and `@default(ulid())` now work.** Both were classified
  as database-side defaults, and neither has a database default to fall back on
   — Prisma fills them in its client. Every `create` on a model using one failed
  on NOT NULL. See [docs/orm.md](./docs/orm.md#column-defaults).
- **`@default(uuid(7))` mints a v7.** The version argument used to be dropped, so
  a column declared v7 got random v4s — still valid UUIDs, no longer sorted by
  creation time, and indistinguishable by eye.

The generator also marks each base it emits with `static $generated = true`, and
`Kernel.models` reads that mark to decide which of several classes claiming one
name is the generated one and which is yours. Artifacts generated before 0.51
carry no mark, so registration falls back to the older signal — whether a class
declares `$schema` itself — which a subclass that redeclares `static $schema`
defeats, handing the name to the base.

### One schema may now fail to generate

`@default(cuid(2))` is refused, naming the field. Prisma builds a cuid2 through
`@paralleldrive/cuid2`, which hashes with SHA-3; gemi cannot reproduce that, and
the two formats do not agree anyway — a cuid2 is 24 characters and letter-first,
a cuid v1 is 25 and always starts `c`. Before this, gemi dropped the argument and
wrote v1s into the column, so the rows it created and the rows Prisma created had
different shapes. Use `@default(cuid(1))`, or keep the Prisma client for that
model.

## `@prisma/client` is gone

0.51 removed the type-only `@prisma/client` import from the generated model
bases, so an app installs `prisma` alone. Delete the `generator client` block
from every `.prisma` file, `bun remove @prisma/client`, and re-run
`bunx prisma generate`.

Your queries do not change. Two things start failing to compile that used to
type-check and throw at runtime — `cursor` and `distinct`, which gemi refuses by
design — and `_sum` / `_avg` are now restricted to numeric columns. If you
passed `Prisma.DbNull`, `Prisma.JsonNull` or `Prisma.AnyNull`, import them from
`gemi/orm` instead.

### What to write instead of `distinct` and `cursor`

The compile error says the key is unknown, which does not tell you the useful
part: both were doing something you probably did not want.

**`distinct` was applied in memory.** Prisma's query log shows no `DISTINCT` at
all — the engine reads the rows and deduplicates them in JavaScript. So a
`take` beside it neither reduced the rows pulled from the database nor
paginated by distinct group, which is a performance and a correctness problem
rather than a stylistic one. Write it as SQL.

On **Postgres**, `distinct on` says it directly:

```ts
const rows = await DB.query(sql`
  select distinct on ("userId") "userId", "createdAt"
  from "Session" order by "userId", "createdAt" desc
`);
```

`distinct on` is Postgres-only — SQLite answers `near "on": syntax error`. The
portable form is a window function, which both dialects have:

```ts
const rows = await DB.query(sql`
  select "userId", "createdAt" from (
    select "userId", "createdAt",
           row_number() over (partition by "userId" order by "createdAt" desc) as "rn"
    from "Session"
  ) where "rn" = 1
`);
```

Reproducing Prisma's behaviour faithfully would have meant hiding a full read
and a JavaScript dedupe behind an argument that reads like a database
operation; emitting a real `DISTINCT ON` under the same name would have
silently diverged from Prisma. Hence neither.

**`cursor` is only correct under a total ordering**, which Prisma does not
enforce — under a non-unique `orderBy` it silently skips or repeats rows at the
page boundary. Use `take` with a `where` on the last row's sort key, or compose
the keyset comparison with `sql`.

If you reach either from untyped code the runtime says the same thing, at
length, rather than failing generically.

The full detail, including the `Prisma.*` type mapping, is under
**Setup** in [docs/orm.md](./docs/orm.md#setup); the reasoning for these two is
under [Not in scope](./docs/orm.md#not-in-scope).

## Check `app/cron` and `app/jobs` before you drop the explicit list

0.51 discovers jobs from the filesystem. Every `Job` subclass under `app/jobs` is
registered and every `CronJob` under `app/cron` is scheduled — unless the config
slice declares `jobs` itself, which still wins and still reads no directory.

**Nothing to do if your `app/config/queue.ts` and `app/config/schedule.ts`
already declare `jobs`.** That includes `jobs: []`, which every app scaffolded
before 0.51 has in `app/config/queue.ts`: an empty array is an application saying
it has no jobs, it is honoured as such, and nothing starts running under you.
Delete the key when you want the directory read instead.

Two things to look at before you do:

- **A job you switched off by unlisting it.** Deleting a class from the array and
  leaving the file in place used to disable it. Discovery finds the file, so it
  starts running on the next boot. Delete the file, or keep the explicit list.
- **Anything in those directories that is not a declaration.** Finding the
  classes means importing the files — a class does not exist until its module has
  run — so a helper sitting in `app/cron` that opens a connection or seeds a
  cache at the top level now does that at boot, on every start. Move it out, or
  keep the explicit list and skip the walk.

The walk itself skips `.d.ts` files, tests and benchmarks by their filename
suffix, dot-directories, `node_modules`, and anything under a directory with its
own `package.json`. Nothing else is guessed at, so a file it cannot import fails
the boot naming itself rather than being quietly left out.

Both directories are covered in [docs/cron.md](./docs/cron.md) and
[docs/jobs-and-queues.md](./docs/jobs-and-queues.md).

## A `code === "P2002"` check stops firing when its write moves onto the ORM

Do this before you move the first write, because afterwards nothing will tell
you:

```sh
rg -n '"P2002"'
```

From the repository root rather than from `app/`: these guards live wherever the
retry does, and a shared `lib/errors.ts` is as likely a home as a controller.

Prisma reports a unique collision as a `PrismaClientKnownRequestError` carrying
`code: "P2002"`. gemi reports it as a `UniqueConstraintError`, which carries
`model`, `operation`, `fields` and `constraint` — and no `code`, anywhere on its
prototype chain. So the moment the write inside the `try` becomes an ORM call,
`error.code === "P2002"` is `false`, the recovery branch stops running, and the
`throw error` line under it — the one you wrote for *some other error* —
rethrows the collision you were handling.

Every guard of this shape sits in code that *expects* the collision: catch it,
re-read, retry. That is the only reason to test for it. So the branch that stops
running is the branch holding a race together.

**It is silent in four independent ways at once, which is why this is a grep
rather than a note.**

- **`tsc` is happy.** The guard takes `unknown` and narrows before reading
  `.code`. That is the correct way to write it, and it stays correct against an
  error that has no `code` — a type error here would need TypeScript to know
  which error your `try` can now produce, which is a runtime fact.
- **The runtime is happy.** Nothing new throws. The `catch` still runs, the
  condition is false, and the rethrow arm does its job perfectly — that arm
  exists to absorb exactly this.
- **The tests are happy.** They reject with `{ code: "P2002" }`, because that is
  what the code under test used to receive. They still pass, over a branch
  production can no longer reach.
- **Production is happy until the race happens.** A unique collision is rare and
  load-dependent by nature. The symptom is not a missing retry; it is whatever
  the rethrown error becomes three frames up, at a moment nobody can reproduce.

In the first real port this reached review inside a merge-ready pull request —
`tsc` clean, ~2700 tests green — carrying two dead guards: one on a credit
balance read, one on an idempotent credit purchase. A human reading the diff
caught them, and nothing else in the pipeline was capable of it.

### The replacement

```ts
import { isUniqueConstraintError } from "gemi/orm";

try {
  return await Invite.create({ data: { token } });
} catch (error) {
  if (!isUniqueConstraintError(error)) throw error;
  return await Invite.findUniqueOrThrow({ where: { token } });
}
```

```ts
function isUniqueConstraintError(error: unknown): error is UniqueConstraintError
```

It tests `instanceof UniqueConstraintError` **or** `error.name ===
"UniqueConstraintError"`, and the second half is why it is worth importing
instead of writing `instanceof` at the call site. `instanceof` compares against
*one module instance's* class object, so it is false across a duplicate copy of
`gemi/orm` — two versions in one dependency tree, a linked build beside a
bundled one, a monorepo package resolving its own. The error is the right error,
thrown by the right code, and your guard silently does not fire. That is not
hypothetical: duck-typing rather than importing the class is precisely what the
ported application had already done for *Prisma's* error, for precisely this
reason.

Other `P` codes have gemi errors too — `P2025` is `RecordNotFoundError`, for
instance — but `P2002` is the one gemi ships a predicate for and the only one the
codemod looks for. If you branch on others, the full table is under
[Errors](./docs/orm.md#errors).

### While some writes are still on Prisma

A port is not atomic, and during one a collision on the same table can arrive as
either error depending on which module wrote the row. Keep both, in one place,
with the temporary arm marked as temporary:

```ts
// app/lib/errors.ts
import { isUniqueConstraintError } from "gemi/orm";

// TODO(port): drop the second arm — and this wrapper with it — when the last
// write leaves the Prisma client.
export const isUniqueCollision = (error: unknown) =>
  isUniqueConstraintError(error) ||
  (typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002");
```

Wrap gemi's predicate rather than re-testing `instanceof` yourself: the name
branch is the half you cannot write correctly by hand, and it is the half that
survives a duplicate module copy.

**gemi deliberately does not ship that second arm.** A Prisma code in gemi's
permanent surface would imply the rest of the taxonomy came with it — `P2003`,
`P2025`, `P2034`, and the fifty others an application would then reasonably
expect to catch — and a compatibility surface that covers `P2002` and not
`P2034` fails in exactly the same silent way, one layer further in. It would
also be a bridge with no end: inside the framework there is nowhere to write the
line saying when to delete it. In your own module there is, and it is the
comment above.

### Fix the tests in the same pass, not after

A mock that rejects with `{ code: "P2002" }` keeps a dead guard green — that is
the third silence above, and it outlives the fix unless you go and get it.
Reject with the real error:

```ts
import { UniqueConstraintError } from "gemi/orm";

vi.mock("@/app/models", () => ({
  Invite: {
    create: vi
      .fn()
      .mockRejectedValue(new UniqueConstraintError("Invite", "create", ["token"])),
    findUniqueOrThrow: vi.fn(),
  },
}));
```

`UniqueConstraintError` is exported from `gemi/orm` for exactly this. The
mocking pattern itself is under **Transactions → Unit-testing code that opens
one** in [docs/orm.md](./docs/orm.md#transactions).

## `take` and `skip` built from a query string must be integers

The rule is not new and is not changing. gemi refuses a `take` or a `skip` that
is not an integer, where Prisma truncated it toward zero:

```
InvalidArgumentError: Invalid 'take' (Post.findMany). Expected an integer, got 1.5.
```

It refuses rather than coercing because there is no coercion both dialects agree
on: binding `limit 1.5` is an opaque `SQLITE_MISMATCH` on SQLite and two rows on
Postgres, which rounds. One rule, failing loudly, beats three behaviours — the
reasoning is under [Querying](./docs/orm.md#querying) and it stands. What is new
is only this: a Prisma application has been getting the truncation for free, and
the code that relied on it keeps compiling.

**It is invisible by construction, in three ways:**

- **`tsc` cannot see it.** `Number(x)` is a `number` and `take` takes a
  `number`. TypeScript has no integer type, so there is no annotation that would
  have caught this and none is coming.
- **The unit tests cannot see it.** Every test passes an integer, because an
  integer is what a developer types. `take: 25` has never been a bug.
- **The failing input is not written by your code.** It is a hand-edited URL, a
  shared link carrying a stale query string, an infinite-scroll client computing
  a page size from the viewport, or a form's cleared field arriving as
  `?perPage=` — and `Number("")` is `0`, so that one computes `skip: -25`, which
  is refused as well.

In the first real port, nine controllers derived pagination straight from the
query string in the same two copied lines. Seven of them broke. The two that
were caught were caught by a human reading the diff.

It takes two greps, because the argument and the value that reaches it are
usually in different files:

```sh
rg -n '\b(take|skip):' app/
rg -n 'Number\(' app/ | rg -i 'page|limit|per.?page|offset|take|skip'
```

### The replacement

```ts
import { paginate } from "gemi/orm";

async list(req: HttpRequest) {
  const { take, skip } = paginate({
    page: req.search.get("page"),
    perPage: req.search.get("perPage"),
  });
  return Post.findMany({ take, skip, orderBy: { createdAt: "desc" } });
}
```

```ts
function paginate(
  args: { page?: unknown; perPage?: unknown },
  options?: { perPage?: number; maxPerPage?: number },
): { take: number; skip: number }
```

The arguments are `unknown` on purpose: a query string is where these values
come from, and typing them `number` would mean every caller writes the
`Number(...)` that is the bug. `req.search.get` hands back `string | string[]`,
a JSON body hands back whatever was sent, and both go in unconverted.

**The guarantee is that its output cannot be refused.** Every return is a pair
of integers with `take >= 1` and `skip >= 0`, for every input — `"2.5"`, `"-1"`,
`""`, `"abc"`, `"1e400"`, an array, `undefined`, a missing key. So a route built
on it has no page argument that can 500.

- `perPage` defaults to **25**, which is the number gemi's own examples used to
  teach as `|| 25` — so moving a call site onto the helper does not change
  anybody's page size.
- A *request* may not ask for more than **100** rows, because `?perPage=100000`
  otherwise reads the table into memory. An endpoint that legitimately serves
  larger pages says so where it is written: `paginate(args, { maxPerPage: 500 })`.
- A `page` below 1 is clamped up rather than refused. The values that land there
  are `""`, `"0"` and `"-1"`, and none of them is a request for a page that does
  not exist; a 500 on a hand-edited link is the wrong answer.

**`Number(x) || 1` is not the fix**, and it is worth knowing how far it does
get: it rescues `?page=` and `?page=0`, because both are falsy. It does not
rescue `?page=-1`, `?page=2.5` or `?page=1e400` — a negative `skip` and a
fractional one are both refused, and `1e400` is `Infinity`, which `Math.trunc`
cannot fix either.

### On the client

`paginate` belongs to the query layer and has no business in a browser bundle.
The value still needs truncating where it is read, because a page number the
client increments arrives at the server *multiplied* — as a fractional `skip`:

```tsx
const asked = Number(searchParams.get("page"));
const page = Number.isFinite(asked) ? Math.max(1, Math.trunc(asked)) : 1;
```

The `Number.isFinite` is not decoration, and it is the half that is easy to drop:
`?page=1e400` is `Infinity`, which `Math.trunc` returns unchanged and `Math.max`
keeps — so a shorter clamp hands the component `Infinity`, writes `?page=Infinity`
back into the URL on the next click, and renders `NaN` on any `page - 1` control.
That is the same test the server-side `toWholeNumber` makes, for the same reason.

## Both of these are annotated by `bunx gemi migrate`

The codemod carries two annotate-only passes over everything under `app/`. They
are re-run-safe, so this is worth doing even on an app already on 0.43:

```sh
bunx gemi migrate --dry-run   # print the plan, write nothing
bunx gemi migrate
rg 'TODO\(gemi-migrate\)'
```

- **The `"P2002"` pass** annotates every `P2002` literal in a file that also
  imports from your model surface (`gemi/orm`, or a path ending in `models`),
  and points at `isUniqueConstraintError` and the two-armed bridge above. Two
  things it cannot find: a guard living in a shared `lib/errors.ts` that imports
  nothing from your models — which is what the plain `rg` above is for — and a
  check spelled `err.code?.startsWith("P200")`, since it matches the exact
  literal only.
- **The `take` / `skip` pass** annotates any `take:` or `skip:` whose value is
  not provably an integer, and points at `paginate`. Integer literals (including
  `1_000`), a whole `Math.trunc(…)` / `Math.floor(…)` / `parseInt(…)` call, and
  `take?: number` in a type declaration are *not* flagged — so a call site you
  have already truncated is silent for a reason rather than by oversight.

The second pass asks you to confirm rather than telling you it found a bug, and
it is worded that way on purpose: whether a value holds an integer is a runtime
fact, most non-literal `take`s are fine, and a marker that is wrong most of the
time is a marker people learn to skim past. Neither pass rewrites anything.

The full description, including what each annotation says, is under [Porting a
Prisma app onto the ORM](./docs/cli.md#porting-a-prisma-app-onto-the-orm).

## `@updatedAt` now needs a column beside it

**This one changes behaviour for apps already on gemi's ORM, not only for apps
porting off Prisma** — it is the only entry here that does, which is why it is
worth reading even if you have no Prisma left.

The stamp used to fire on every `update` call. It now fires on every call that
**sets at least one column**, which is the rule Prisma follows. Measured against
6.19.2 by seeding the column to the epoch and reading it back:

```
data: {}                                epoch    not stamped
data: { profile: { create: … } }        epoch    not stamped     nested write, child holds the key
upsert hit, update: {}                  epoch    not stamped
updateMany({ data: {} })                epoch    { count: 0 }
data: { name: "real" }                  now      stamped
data: { organization: { connect: … } }  now      stamped          writes this row's foreign key
```

Nothing that writes a column changes. What changes is the calls that write
none — and there is one spelling worth searching for before you upgrade:

```ts
await User.update({ where: { id }, data: {} })   // no longer moves updatedAt
```

If you used that as a *touch* — a write with an empty payload, to bump the
timestamp — it is now a read and the stamp stays where it was. It never worked
that way under Prisma, so a ported app cannot depend on it; an app written
against gemi's ORM directly could. Set the column yourself where you meant to:

```ts
await User.update({ where: { id }, data: { updatedAt: new Date() } })
```

The same applies to a `data` of only nested writes whose child holds the foreign
key. Those write the *child* and nothing on the parent, so the parent's stamp no
longer moves — which is what Prisma does, and what the ORM previously did not.

**Why it changed rather than being left alone.** Stamping unconditionally made
the empty-`data` read unreachable on any model carrying the attribute, because
the stamp was itself the assignment keeping the statement from being empty — so
the fix for `data: {}` was the same fix. And it put a timestamp Prisma does not
write on every nested to-one write, where the differential harness could not see
it: `updatedAt` is compared as a volatile descriptor, so two different instants
match. It took asserting the epoch by hand to find.

**One divergence remains, deliberately.** An owning-side `disconnect` writes the
foreign key and so stamps here; Prisma writes the same column through the same
operand family and does *not*, while its `connect` one operand over does. That is
Prisma disagreeing with itself, and matching it would mean special-casing one
operand to reproduce an inconsistency.

An owning-side `upsert` — `data: { organization: { upsert: … } }` — inherits it
on the branch that **updates**. The foreign key is written back unchanged there,
because the create branch needs that column in the statement and which branch
runs is not known until the call runs, so the parent's stamp moves where
Prisma's does not. The far row is updated identically on both. Worth searching
for in the same places as the `disconnect` above: a row whose `updatedAt` you
show, written through a relation rather than through a column.

---

# Upgrading from 0.42 to 0.43

0.43 replaces the 16 hand-written `*ServiceContainer` singletons and the
`*ServiceProvider` config-bag classes with one Laravel-style container. This is
a **hard break**: there are no deprecation aliases and no back-compat shims.
Everything you need to change is listed below, and most of it is automated.

```sh
# from your app's root, with gemi 0.43 installed
bunx gemi migrate --dry-run   # see the plan
bunx gemi migrate             # apply it
```

The codemod prints a per-file summary of everything it could not translate and
leaves a `TODO(gemi-migrate):` comment at each of those spots. Grep for it when
it finishes:

```sh
rg 'TODO\(gemi-migrate\)'
```

---

## 1. Providers became config

In 0.42 you configured the framework by subclassing a provider and overriding
properties. In 0.43 those same values are a plain object exported from
`app/config/<slice>.ts`.

```ts
// 0.42 — app/kernel/providers/EmailServiceProvider.ts
import { EmailServiceProvider, ResendDriver } from "gemi/services";

export default class extends EmailServiceProvider {
  driver = new ResendDriver();
}
```

```ts
// 0.43 — app/config/mail.ts
import { defineMailConfig, ResendDriver } from "gemi/services";

export default defineMailConfig({
  driver: new ResendDriver(),
});
```

Overridden **methods** become callback keys — `async onSignUp(user, token) {}`
in a class body is `async onSignUp(user, token) {},` in the object literal. The
codemod does this conversion mechanically and preserves your comments and
formatting.

| 0.42 provider | 0.43 config file | helper | import from |
| --- | --- | --- | --- |
| `AuthenticationServiceProvider` | `app/config/auth.ts` | `defineAuthConfig` | `gemi/services` |
| `EmailServiceProvider` | `app/config/mail.ts` | `defineMailConfig` | `gemi/services` |
| `LoggingServiceProvider` | `app/config/log.ts` | `defineLogConfig` | `gemi/services` |
| `FileStorageServiceProvider` | `app/config/filesystem.ts` | `defineFilesystemConfig` | `gemi/services` |
| `QueueServiceProvider` | `app/config/queue.ts` | `defineQueueConfig` | `gemi/services` |
| `RedisServiceProvider` | `app/config/redis.ts` | `defineRedisConfig` | `gemi/services` |
| `BroadcastingServiceProvider` | `app/config/broadcast.ts` | `defineBroadcastConfig` | `gemi/services` |
| `ImageOptimizationServiceProvider` | `app/config/image.ts` | `defineImageConfig` | `gemi/services` |
| `RateLimiterServiceProvider` | `app/config/ratelimiter.ts` | `defineRateLimiterConfig` | `gemi/services` |
| `CronServiceProvider` | `app/config/schedule.ts` | `defineScheduleConfig` | `gemi/services` |
| `I18nServiceProvider` | `app/config/translation.ts` | `defineTranslationConfig` | `gemi/i18n` |
| `MiddlewareServiceProvider` | `app/config/middleware.ts` | `defineMiddlewareConfig` | `gemi/http` |
| `ApiRouterServiceProvider` | `app/config/route.ts` (`api`) | `defineRouteConfig` | `gemi/services` |
| `ViewRouterServiceProvider` | `app/config/route.ts` (`view`) | `defineRouteConfig` | `gemi/services` |

The two router providers collapse into a single `route` slice:

```ts
// app/config/route.ts
export default defineRouteConfig({
  api: { rootRouter: RootApiRouter },
  view: { rootRouter: RootViewRouter, root: createRoot(RootLayout) },
});
```

`route` is the only mandatory slice — `route.api.rootRouter`, `route.view.root`
and `route.view.rootRouter` have no defaults. Everything else can be omitted
entirely.

### One property was retired

`AuthenticationServiceProvider.adapter` briefly became `auth.userProvider`, and
then the seam it selected between was removed altogether: auth persistence is
now the ORM-backed `UserProvider`, and `AuthConfig` has no field for it.

The codemod comments the member out and leaves a TODO carrying the replacement —
subclass `UserProvider` from `gemi/kernel`, override the methods the adapter
implemented, and install it by rebinding `AuthManager` (from `gemi/services`) in
a ServiceProvider, which takes the provider as its second constructor argument.
The same TODO is written over a `userProvider` field left in an
`app/config/auth.ts` by an earlier migration. See
[docs/authentication.md](docs/authentication.md) for the worked example.

---

## 2. The Kernel

```ts
// 0.42
export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  emailServiceProvider = EmailServiceProvider;
  // ...one field per provider
}
```

```ts
// 0.43
import { Kernel } from "gemi/kernel";
import auth from "../config/auth";
import mail from "../config/mail";
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = { auth, mail };
  providers = [AppServiceProvider];
}
```

`config` is merged into the container's config `Repository` and read lazily.
`providers` runs **after** the 14 framework providers, so an app provider can
rebind anything the framework bound.

Two Kernel bugs disappear with the old shape: the misspelled
`broadcastingsServiceProvider` field (which made broadcast channels
unoverridable) and `imageServiceProvider`, which was never honoured at all. Both
are ordinary config slices now.

---

## 3. Facades

Only two identifiers changed, both from `gemi/facades`:

| 0.42 | 0.43 |
| --- | --- |
| `FileStorage` | `Storage` |
| `I18n` | `Lang` |

Method names and signatures are unchanged, so this is a pure rename — the
codemod handles it everywhere, including inside provider bodies on their way to
`app/config`.

`Auth`, `Log`, `Redis`, `Broadcast`, `Query`, `Cookie`, `Redirect`, `Url` and
`Meta` are untouched. `Facade` is now exported too, if you want to write your
own:

```ts
import { Facade } from "gemi/facades";

export class Billing extends Facade {
  static getFacadeAccessor() {
    return BillingManager;
  }
  static charge(amount: number) {
    return this.getFacadeRoot().charge(amount);
  }
}
```

---

## 4. `*ServiceContainer.use()` is gone

Every `SomethingServiceContainer` is now a plain class resolved from the
container. If you called `.use()` anywhere, replace it:

```ts
// 0.42
import { EmailServiceContainer } from "gemi/services";
const mail = EmailServiceContainer.use().service;

// 0.43
import { app } from "gemi/foundation";
import { MailManager } from "gemi/services";
const mail = app(MailManager);
```

The codemod renames the identifier and drops a `TODO(gemi-migrate):` on the call
site, but **it does not rewrite the call itself** — `.use().service` unwrapping
varied enough across call sites that a blind rewrite would be wrong more often
than right.

| 0.42 | 0.43 | token |
| --- | --- | --- |
| `AuthenticationServiceContainer` | `AuthManager` | `auth` |
| `EmailServiceContainer` | `MailManager` | `mail` |
| `LoggingServiceContainer` | `LogManager` | `log` |
| `FileStorageServiceContainer` | `FilesystemManager` | `filesystem` |
| `QueueServiceContainer` | `QueueManager` | `queue` |
| `RedisServiceContainer` | `RedisManager` | `redis` |
| `BroadcastingServiceContainer` | `BroadcastManager` | `broadcast` |
| `ImageOptimizationServiceContainer` | `ImageManager` | `image` |
| `ApiRouterServiceContainer` | `ApiRouteDispatcher` | `router.api` |
| `ViewRouterServiceContainer` | `ViewRouteDispatcher` | `router.view` |
| `I18nServiceContainer` | `Translator` | `translator` |
| `RateLimiterServiceContainer` | `RateLimiter` | `ratelimiter` |
| `CronServiceContainer` | `Scheduler` | `scheduler` |
| `MiddlewareServiceContainer` | `MiddlewareRegistry` | `middleware` |
| `KernelIdServiceContainer` | `KernelId` | `kernel.id` |

`ApiRouter` and `ViewRouter` — the classes you subclass to declare routes — are
**not** affected. They keep their names and their `gemi/http` export.

---

## 5. `Singleton` was removed

`SingletonServiceContainer` and the `Singleton` base class are gone;
`Container.singleton()` subsumes them.

```ts
// 0.42
import { Singleton } from "gemi/services";
export class Clock extends Singleton {}
const clock = Clock.use();

// 0.43
import { app } from "gemi/foundation";
export class Clock {}

// in a ServiceProvider's register():
this.app.singleton(Clock, () => new Clock());

// anywhere:
const clock = app(Clock);
```

The codemod cannot do this one — the replacement depends on where you want the
binding registered. It flags every `Singleton` import with a
`TODO(gemi-migrate):`.

---

## 6. Writing your own provider

`ServiceProvider` moved from `gemi/services` to `gemi/support` and changed
meaning: it registers *into* a container rather than being a config bag handed
*to* one. `boot()` is no longer abstract-and-ignored — it actually runs.

```ts
import { ServiceProvider } from "gemi/support";

export default class BillingServiceProvider extends ServiceProvider {
  // Phase 1. Bind only. Nothing may be resolved here.
  register() {
    this.app.singleton(
      BillingManager,
      () => new BillingManager(this.app.config.get("billing", {})),
    );
  }

  // Phase 2. Every provider has registered, so resolving is safe.
  async boot() {}
}
```

Register it in the Kernel's `providers` array. The codemod moves the import to
`gemi/support` and, for any provider under `app/kernel/providers/` it does not
recognise, leaves the file on disk and lists it in `providers` with a TODO.

### The boot split matters

`register()` is synchronous and runs during `Kernel.boot()`. `boot()` is async
and runs during `Kernel.waitForBoot()`, which `Server.start()` awaits before
binding the port. If you have async setup, it goes in `boot()`, not
`register()`.

### Services are now built lazily

In 0.42 every `*ServiceContainer` was constructed during `Kernel.boot()`. In
0.43 `singleton()` bindings are built on first `make()`, so a service whose
constructor throws now fails at its first use rather than at startup. Three
providers opt back into eager construction with a `boot()`, because their
readiness is a genuine startup concern:

| Provider | Why it resolves in `boot()` |
| --- | --- |
| `RouteServiceProvider` | Flattens the route tables and runs the reserved-path assertion — a bad route table must fail the boot, not the first request. |
| `LogServiceProvider` | Creates the log directory once, instead of adding file IO to whichever handler logs first. |
| `KernelIdServiceProvider` | Binds a pre-built id with `instance()` so the value is stable from the moment the app exists. |

Everything else is lazy on purpose. The two worth calling out:

- **Redis.** `new RedisClient(url)` does not connect (Bun connects on the first
  command), so nothing is deferred except URL parsing. Keeping it lazy is what
  lets `gemi build` run without a valid `REDIS_URL`.
- **Cron.** `ScheduleServiceProvider.boot()` registers the `Bun.cron` handles.
  0.42 registered them in the container's constructor, which meant `gemi build`
  scheduled jobs it then had to tear down; that no longer happens.

If you want startup validation for one of your own services, resolve it in your
provider's `boot()` — that is the whole mechanism.

---

## 7. New public modules

```ts
import { Kernel, frameworkProviders } from "gemi/kernel";
import { app, Application } from "gemi/foundation";
import { Container, BindingResolutionError, type ServiceToken } from "gemi/container";
import { ServiceProvider, Repository, withDefaults } from "gemi/support";
```

`withDefaults(defaults, config)` is the merge the framework's own providers use:
a shallow spread that treats an explicit `undefined` the same as an omitted key,
so a config slice can't erase a default by naming it. Use it in your own
`register()` if your service has defaults.

`app()` returns the `Application`; `app(Token)` resolves a binding and is typed
from the token class, so `app(MailManager)` is a `MailManager` with no cast.

Note that `gemi/config` is the **build** config (`gemi.config.ts`) and is
unrelated — runtime config lives in `gemi/support`'s `Repository`.

---

## What the codemod will not do for you

These are the cases it reports rather than guesses at.

1. **`Singleton` subclasses.** Section 5. The import is flagged; the class body
   and every `.use()` call are left alone.

2. **`.use()` call sites.** The identifier is renamed so the import resolves,
   but the call is flagged, not rewritten. Change
   `X.use().service` to `app(X)` yourself.

3. **Constructors and `static` members on a provider.** A config object has no
   equivalent. They are commented out inside the generated `app/config/*.ts`
   with a TODO, so nothing is lost — decide whether the logic belongs in a
   `ServiceProvider.register()` or in the config value itself.

4. **Providers that extend something the codemod does not know.** Left on disk
   untouched (apart from the `ServiceProvider` import move) and carried into the
   Kernel's `providers` array with a TODO. Make them extend `ServiceProvider`
   from `gemi/support`.

5. **Extra members on your `Kernel` subclass.** Anything that is not a provider
   slot is commented out in the rewritten `Kernel.ts` with a TODO.

6. **Getters on a provider.** `get headers() { … }` is carried over as an object
   getter, which is valid but rarely what you want in a config file. Review it.

7. **Import order and grouping.** The codemod preserves your original import
   order rather than reflowing it. The result is correct but may not match how
   you would have grouped things by hand.

8. **Classes declared inside a provider file.** These are extracted to their own
   module by base class — `HttpRequest` to `app/http/requests/`, `CronJob` to
   `app/cron/`, `Job` to `app/jobs/`, `BroadcastingChannel` to
   `app/broadcasting/`, `Middleware` to `app/http/middleware/`, `Email` to
   `app/email/`, `Policy` to `app/policies/`. A class extending anything else is
   copied into the generated config file as-is and reported — move it somewhere
   sensible.

9. **Anything outside `app/`.** The codemod only walks `app/`. Scripts, tests
   and tooling elsewhere in your repo need the section 3–5 renames applied by
   hand.

---

## A trap worth knowing about

If you set `verifyEmail: false`, make sure you are not calling
`authConfigDefaults()` with no argument anywhere in your own code. The default
`generateEmailVerificationToken` reads `config.verifyEmail` off the merged
config to decide whether to short-circuit; called with no argument it defaults
to `true` and silently keeps minting verification tokens. The framework's own
`AuthServiceProvider` passes the user config through correctly — this only bites
if you build the config yourself.
