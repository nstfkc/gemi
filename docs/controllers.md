# Controllers

Controllers hold the server-side logic behind a route. A controller is a class exported from `app/http/controllers`, named in PascalCase with a `Controller` suffix (e.g. `OrganizationCustomerController`), extending either `Controller` or `ResourceController` from `gemi/http`. Bind a controller method to a route in an [`ApiRouter` or `ViewRouter`](./routing.md); the method receives an [`HttpRequest`](#httprequest) and returns the data for the response.

```typescript
import { Controller, HttpRequest } from "gemi/http";

export class HomeController extends Controller {
  async index() {
    return { message: "Hello from HomeController" };
  }
}
```

> **Note:** Controllers are **named exports** (`export class XController`). The router imports them by name and passes the class plus a method name: `this.get(HomeController, "index")`.

## Return values

Whatever a handler returns is the response body. Return a plain object (or array) and gemi serializes it to JSON for API routes, or passes it to the view component as props for view routes:

```typescript
export class HomeController extends Controller {
  async index() {
    return { message: "Hello" }; // → 200 application/json
  }
}
```

To change the response, use `HttpResponse`, the facades and errors rather than constructing a `Response` yourself. `HttpResponse` sets a status or headers (below). For errors see [Errors](#errors-and-validation), and for redirects see the [`Redirect`](./authentication.md) facade.

### Status and headers: `HttpResponse.json`

To answer with a status other than 200, or with extra headers, return `HttpResponse.json(data, options?)` from `gemi/http`:

```typescript
import { Controller, HttpRequest, HttpResponse } from "gemi/http";

export class PostController extends Controller {
  async store(req: HttpRequest<{ title: string }>) {
    const post = await Post.create({ data: (await req.input()).toJSON() });
    return HttpResponse.json(post, { status: 201 });
  }

  async publish(req: HttpRequest<{}, { id: string }>) {
    const post = await Post.findUniqueOrThrow({ where: { id: req.params.id } });
    if (post.publishedAt) {
      return HttpResponse.json({ error: { message: "Already published" } }, { status: 409 });
    }
    // ...
    return HttpResponse.json(post, { headers: { "X-Post-Version": String(post.version) } });
  }
}
```

`options` is `{ status?: number; headers?: HeadersInit }`, and `status` defaults to 200. A status the JSON body cannot go with is refused with a `RangeError`: one outside 200–599, or 204, 205 or 304.

**It stays typed.** The route's client type is `data`'s type, as if the handler had returned `data`. A handler that returns `HttpResponse.json(post, { status: 201 })` gives `usePost`, `useQuery` and `Query.instant` the type `Post`. A handler that returns a plain object on one branch and `HttpResponse.json` on another is typed as the union of the two. A hand-built `Response` has no type, and returning one also loses the route's type.

**It keeps what the request set.** It goes through the same path as a plain return, so the response also carries:

- cookies set during the request, such as a refreshed session or `req.ctx().setCookie()`;
- headers set with `req.ctx().setHeaders()`;
- whatever middleware added, such as CORS headers or `cache`'s `Cache-Control`.

On top of those, `options.headers` apply as follows:

- A header named in `options.headers` replaces the one the request set.
- A `Set-Cookie` in `options.headers` is added to the request's cookies. It does not replace them.
- `Content-Type` is `application/json` unless `options.headers` names another one, such as `application/problem+json`.
- A status of 400 or more is sent `Cache-Control: no-store` unless `options.headers` sets `Cache-Control`. gemi's own errors do the same, so a shared cache cannot replay one client's 404 to everyone from behind `cache`.

**What the client sees.** Any 2xx is data: `useQuery` stores it, and a mutation calls `onSuccess` with it. A 4xx or 5xx is an error, handled as gemi's own errors are:

- `useQuery` gets a `QueryError` whose `status` is the status and whose `body` is the JSON. The default retry policy applies, so a 4xx other than 408 and 429 is not retried.
- `useMutation`, `usePost` and `<Form>` pass the body's `error` field to `onError` and `error`, as they do for gemi's own `{ "error": … }` bodies. So `HttpResponse.json({ error: { kind: "form_error", message: "Taken" } }, { status: 409 })` renders in `<FormError>`. A body with no `error` field is handed over whole.
- A loader's `Query.instant` or `Query.prefetch` on the server behaves the same as the browser. A 2xx resolves to the data, and an error status rejects with the same `QueryError`.

`HttpResponse` is for API routes. A view handler returns its props, and returning an `HttpResponse` from one throws. For a status there, throw an [error](#errors-and-validation) or use `Redirect`.

## HttpRequest

Every controller method (and every inline route callback) receives an `HttpRequest`. It is generic over the request **body** and the route **params**:

```typescript
import { HttpRequest } from "gemi/http";

// HttpRequest<Body, Params>
async show(req: HttpRequest<{ name: string }, { orgId: string }>) { /* ... */ }
```

### Members

| Member | Type | Description |
| --- | --- | --- |
| `req.params` | `Params` | Route parameters from `:param` segments (e.g. `req.params.orgId`). |
| `req.search` | `Input` | Parsed query string. Use `req.search.get(key)` / `req.search.has(key)`; repeated keys come back as an array. **Not** a native `URLSearchParams`. |
| `req.cookies` | read-only `Map<string, string>` | Request cookies. `req.cookies.get("access_token")`. |
| `req.headers` | read-only `Headers` | Request headers. `req.headers.get("User-Agent")`. |
| `req.rawRequest` | `Request` | The underlying Fetch API `Request` (method, url, body, etc.). |
| `req.routePath` | `string` | The matched route pattern. |
| `await req.input()` | `Promise<Input<Body>>` | Parses **and validates** the request body — see below. |
| `await req.safeInput()` | `Promise<{ isValid, errors, input }>` | Same parsing, but returns validation errors instead of throwing. |
| `req.locale()` | `string` | The resolved request locale. |
| `req.ctx()` | request context | Access to the per-request store (used by facades, `setHeaders`, etc.). |

### Reading query params

`req.search` wraps the query string. `get` returns the value (a string, or `string[]` for repeated keys):

```typescript
import { paginate } from "gemi/orm";

async list(req: HttpRequest) {
  const search = req.search.get("search");
  const { take, skip } = paginate({
    page: req.search.get("page"),
    perPage: req.search.get("perPage"),
  });
  // ...
}
```

Everything the query string holds is a string, so a numeric param has to be converted, and
`Number(...)` alone is not enough for the ones that become query arguments: `?limit=1.5` is a
fractional `take`, which the ORM refuses rather than truncates, and a blank `?page=` is `0`,
which computes a negative `skip`. `paginate` takes them as they arrive and always returns
integers — see [ORM](./orm.md#querying).

### Reading the body: `req.input()`

`await req.input()` reads and parses the body (`application/json`, `application/x-www-form-urlencoded`, or `multipart/form-data`), runs [validation](#errors-and-validation), and returns an `Input` wrapper. Call `.toJSON()` for the plain object, or `.get(key)` / `.has(key)` for individual fields:

```typescript
async post(req: HttpRequest<{ name: string; email: string }>) {
  const input = await req.input();
  const data = input.toJSON();     // { name, email }
  const name = input.get("name");  // string
  return { data };
}
```

Multipart uploads come through the same API; a file field is a `Blob`/`File`, and repeated fields arrive as arrays:

```typescript
async upload(req: HttpRequest<{ file: File | File[] }>) {
  const input = await req.input();
  const file = input.get("file");
  const files = Array.isArray(file) ? file : [file];
  return files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
}
```

## ResourceController

`ResourceController` is an abstract base for REST resources. It requires five methods — `list`, `store`, `show`, `update`, `delete` — which [`this.resource(Controller)`](./routing.md) maps to the standard REST routes:

```typescript
import { HttpRequest, ResourceController } from "gemi/http";

export class OrganizationCustomerController extends ResourceController {
  async list(req: HttpRequest)   { /* GET  collection */ }
  async store(req: HttpRequest)  { /* POST collection */ }
  async show(req: HttpRequest)   { /* GET  item */ }
  async update(req: HttpRequest) { /* PUT  item */ }
  async delete(req: HttpRequest) { /* DELETE item */ }
}
```

See [Routing → Resource routes](./routing.md) for the exact method-to-path mapping and per-action middleware.

## Errors and validation

gemi handles control flow through **thrown errors** that the framework catches and turns into the right response. All of them extend `RequestBreakerError` (exported from `gemi/http`), which carries separate `api` and `view` payloads.

### ValidationError

`throw new ValidationError(errors)` produces a **400** response shaped as:

```json
{ "error": { "kind": "validation_error", "messages": { "name": ["Name is required"] } } }
```

`errors` is a `Record<string, string[]>` (field → messages). Use it directly instead of inventing a per-endpoint error shape:

```typescript
import { ValidationError } from "gemi/http";

async store(req: HttpRequest<{ name: string }>) {
  const { name } = (await req.input()).toJSON();
  if (!name.trim()) {
    throw new ValidationError({ name: ["Name is required"] });
  }
  // ...
}
```

### Schema-based validation

Rather than validating by hand, subclass `HttpRequest` and declare a `schema`. `req.input()` validates the body against it and throws a `ValidationError` automatically before your handler code runs:

```typescript
class CreateCustomerRequest extends HttpRequest<{ name: string; email?: string }> {
  schema = {
    name: { required: "Name is required", "max:120": "Too long" },
    email: { email: "Email is invalid", "max:160": "Too long" },
  };
}

export class CustomerController extends ResourceController {
  async store(req: CreateCustomerRequest) {
    const input = await req.input(); // throws 400 if invalid
    const data = input.toJSON();
    // ...
  }
}
```

The schema is a map of field → `{ rule: message }`. The built-in rules are `required`, `string`, `boolean`, `number`, `email`, `password`, `min:N` / `max:N` (length of a string or array), `gte:N` / `lte:N` (size of a number), `file`, `fileType:png|jpg|pdf|…`, and `fileSize:5MB`. `string`, `boolean` and `number` check the JSON type and do not coerce, so `"true"` is not a boolean; a form-encoded or multipart body carries only strings and files. A rule name the list does not have, or a parameter it cannot read (`min:abc`, `fileSize:5mb`), throws `InvalidValidationRuleError` when the request is validated, instead of passing silently. A rule value may also be a function for custom messages (its key is then only a label), and `refine()` can be overridden for cross-field checks. When you need errors without throwing, use `await req.safeInput()`, which returns `{ isValid, errors, input }`. See [Forms](./forms.md).

> **Note:** Fields with no value (missing, `null` or `""`) and no `required` rule are skipped, so optional fields (e.g. an omitted `email`) don't fail their format rules. `0` and `false` are values and are checked. A field that fails `required` reports only the `required` message. This makes partial-update schemas easy — leave `required` off `update` fields.

### Auth and other errors

The following are exported from `gemi/http` and thrown by [middleware](./middleware.md) or your own code:

| Error | Status (API) | Use |
| --- | --- | --- |
| `AuthenticationError` | 401 | No/invalid session. On a view request it redirects to `/auth/sign-in`. |
| `AuthorizationError` | 401 | Authenticated but not allowed. |
| `InsufficientPermissionsError` | 403 | Authenticated, lacks a specific permission. Thrown by `Auth.guard`. |
| `RequestBreakerError` | (custom) | Base class — extend it to define your own throw-to-respond errors with `api`/`view` payloads. |

## See also

- [Routing](./routing.md) — binding controllers and resources to URLs.
- [Middleware](./middleware.md) — guarding controller methods with `auth`, `admin`, etc.
- [Forms](./forms.md) — client-side forms that consume these validation errors.
- [Authentication](./authentication.md) — sessions and the current user.
