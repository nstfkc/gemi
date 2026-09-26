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
