# HTTP client extraction foundation

`extractHttpApi(ts, { file, exportName }, { cwd })` reads a router class or
instance through an in-memory TypeScript probe using that router's own
`CreateRPC`. It never imports or executes application modules. The model is
internal, with no public CLI or Swift/Kotlin output yet (part 1 of #1280).

Routes are sorted by their exact RPC key before types are named. GET input is
query data; the other supported verbs carry body input. Path parameter syntax
is recorded separately from the declared `HttpRequest` params type. Nested,
group and resource paths are resolved by `CreateRPC`, not duplicated here.
Agent and voice entries are excluded. `CreateFileRPC` file/stream routes are
explicitly deferred, as are uploads, authentication, transport, built-in auth
routes, native rendering and stale-build enforcement.

The shared AI `TypeMapper` is reused without changing its output. This is not a
complete HTTP wire schema: Date and bigint currently become raw JSON with
location-specific warnings (Date needs a future ISO-8601 mapping; bigint needs
a serialization policy). A top-level void/undefined response is explicitly
`void`; response unions containing void/undefined are diagnosed and kept as raw JSON. Tuples,
recursive types and other unsupported shapes retain the mapper's warnings.
Unknown/any are deliberately raw JSON. Numeric and individual string literals
are widened, including error status/kind literals; exact status enums and
exhaustive single-variant error cases are deferred. Typed errors describe
`CreateRPC`'s client error body, including its status, not the raw envelope.
`CreateRPC` itself erases some wire information (for example response headers,
success statuses and raw Response branches alongside typed data). This model
cannot recover that information or validate runtime serialization.

Run the focused and AI output regression tests from `packages/gemi`:

```sh
bun --bun x vitest run bin/http-client/extract.test.ts bin/ai-client/generate.test.ts
```
