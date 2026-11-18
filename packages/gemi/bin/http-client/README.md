# HTTP client extraction foundation

`extractHttpApi(ts, { file, exportName }, { cwd })` reads a router class or
instance through an in-memory TypeScript probe using that router's own
`CreateRPC` and its raw-output companion (which preserves status before body
projection). It never imports or executes application modules. The model is
internal, with no public CLI.

Routes are sorted by their exact RPC key before types are named. GET input is
query data; the other supported verbs carry body input. Path parameter syntax
is recorded separately from the declared `HttpRequest` params type, including
optional and catch-all segments. Declared key mismatches emit warnings when
params have a fixed set of keys. Empty
objects, default `Record<string, never>` and unknown request shapes normalize
to `none`; arbitrary `any` and nonempty inputs remain JSON/type shapes. Nested,
group and resource paths are resolved by `CreateRPC`, not duplicated here.
Agent and voice entries are excluded. `CreateFileRPC` file/stream routes are
explicitly deferred, as are uploads, authentication, transport, built-in auth
routes and app-level stale-build enforcement.

The shared AI `TypeMapper` is reused without changing its output. This is not a
complete HTTP wire schema: Date and bigint currently become raw JSON with
location-specific warnings (Date needs a future ISO-8601 mapping; bigint needs
a serialization policy). A top-level void/undefined response is explicitly
`void`; a 204 response is also `void`, while a plain 200 JSON null response is
`null`. Response unions containing void/undefined are diagnosed and kept as raw
JSON. With older gemi installations the extractor uses the app's web RPC
types and warns when a top-level null could also mean a 204. A null-only
response then falls back to raw JSON, and nullable unions keep their web type.
When a web RPC route is missing from the raw-output map, the
extractor warns and keeps raw JSON. Routes that only throw or return typed
errors keep their `never` success type.
Tuples, recursive types and other unsupported shapes retain the mapper's warnings.
Unknown/any response types are deliberately raw JSON. The HTTP mapper retains
individual string, number and boolean literals as a `literal` value alongside the
primitive kind, including error status/kind, without changing AI generator
output. For a union of objects, one shared field must have distinct values
that are all strings or all booleans. Otherwise the extractor warns and keeps
raw JSON.
Renderers must honor these literal constraints. Type-name collisions
produce warnings; final namespace/function naming remains deferred. Typed errors
describe `CreateRPC`'s client error body, including its status, not the raw envelope.
`CreateRPC` itself erases some wire information (for example response headers,
success statuses and raw Response branches alongside typed data). This model
cannot recover that information or validate runtime serialization.

Run the focused and AI output regression tests from `packages/gemi`:

```sh
bun --bun x vitest run bin/http-client/extract.test.ts bin/ai-client/generate.test.ts
```

The internal HTTP model renderers generate Swift and Kotlin object types. A
`PATCH /notes/:id` fixture exercises path parameters, a JSON body, a success
response and a route-specific error. Its fixed error kind and status are
single-value native types. The test targets compile callers of these models
and check their JSON encoding and decoding. Route methods and tagged-union
rendering are follow-ups.

From `packages/gemi`, run
`bun --bun x vitest run bin/http-client/render.test.ts` to check both generated
files against the route. Set `GEMI_UPDATE_FIXTURES=1` to regenerate them.
