# File Storage

gemi ships a driver-based file storage service with a single facade, `Storage`, that reads and writes files without your controllers ever knowing whether the bytes live on the local disk or in an S3 bucket. It also includes an on-the-fly image optimization service and a client `Image` component that requests resized, WebP-encoded variants automatically.

Configure it in `app/config/filesystem.ts` — see [Kernel & Service Providers](./project-structure.md) — and call it through the [`Storage` facade](./facades.md).

## The `Storage` facade

Import the facade from `gemi/facades`:

```typescript
import { Storage } from "gemi/facades";
```

`Storage` is a static proxy over the `FilesystemManager` that the framework's `FilesystemServiceProvider` binds into the container from your `filesystem` config. Every method delegates to the configured driver, so the surface is intentionally small.

### `put(params | Blob, options?)`

Stores a file and returns the stored object's **name** (a string) that you persist and later use to fetch the file back.

```typescript
// Store an uploaded file with an explicit name
const name = await Storage.put({
  name: "avatars/user-42.png",
  body: file, // Blob | File | Buffer
  contentType: "image/png", // optional
  bucket: "public",         // optional — defaults to process.env.BUCKET_NAME
});
```

`PutFileParams` is:

```typescript
interface PutFileParams {
  name: string;
  bucket?: string;
  body: Blob | File | Buffer;
  contentType?: string;
}
```

You can also pass a bare `Blob`/`File` — the driver generates a UUID-based name from the blob's MIME type and returns it:

```typescript
// name is auto-generated, e.g. "0192f...c3.png"
const name = await Storage.put(uploadedBlob);
```

> **Note:** `put` returns the object name, not a URL. Store that name against your record; you serve the file later by handing the name to `Storage.fetch` (typically from a controller route).

#### Cancelling an upload

`put` takes an optional second argument, `{ signal }`, to abort the upload with an `AbortController`. It works with both forms:

```typescript
const controller = new AbortController();
const upload = Storage.put({ name: "videos/intro.mp4", body: file }, {
  signal: controller.signal,
});

controller.abort(); // `upload` rejects with an AbortError

// Or give up after 30 seconds
await Storage.put(file, { signal: AbortSignal.timeout(30_000) });
```

An aborted `put` rejects and the object should be treated as not written. The S3 and Azure drivers hand the signal to their SDK, which cancels the request in flight. The local disk driver checks the signal before it writes but does not interrupt a write already under way.

### `putFromUrl(url, options?)`

Downloads a remote file and stores it: an image link a user pasted, a provider's short-lived signed URL, the images of a site being migrated. It resolves with what was stored:

```typescript
const { name, contentType, size, url } = await Storage.putFromUrl(imageUrl, {
  directory: `sites/${site.id}`,  // or `name: "sites/42/logo.png"`
  contentTypes: ["image/*"],
  maxSize: 10 * 1024 * 1024,      // default 10 MiB
  timeout: 30_000,                // the whole download, default 30 s
  bucket: "public",
  signal: req.rawRequest.signal,
});
```

What it guarantees:

- **It goes through [`safeFetch`](./outbound-http.md).** Loopback, private, link-local and cloud-metadata addresses are refused (the address is checked after DNS resolution and again on every redirect), only ports 80 and 443 are allowed, and at most 5 redirects are followed. Other `safeFetch` options go under `fetch`: `{ headers, allow, deny, ports, maxRedirects, connectTimeout }`. Never build `fetch.allowPrivate` from user input.
- **The type comes from the bytes.** The stored content type is sniffed from the first 4 KiB (PNG, JPEG, GIF, WebP, AVIF, HEIC, SVG, PDF, MP4, WebM, MP3, fonts, archives, HTML, …), never taken from the server's `Content-Type` header. Bytes that are UTF-8 text come out as `text/plain` (that includes JSON and CSV), and anything unrecognized as `application/octet-stream`. The sniffer is exported as `sniffContentType(bytes)` from `gemi/services`.
- **`contentTypes` is checked before anything is stored.** Entries are exact types or wildcards (`"image/*"`). A wildcard never covers `image/svg+xml`, `text/html` or XML, which can carry script; list them by name to accept them. Without `contentTypes` any type is stored, so pass it whenever the URL comes from a user.
- **No partial objects.** A download that fails, is aborted or grows past `maxSize` halfway rejects and stores nothing. A `Content-Length` over `maxSize` is refused before the body is read.
- **Memory.** `FileSystemDriver` streams to a temporary file next to the target and renames it into place, so memory stays at one chunk. The S3 and Azure drivers read the file into memory (bounded by `maxSize`) and upload it with `put()` once it is complete.

A generated name is `<directory>/<uuid v7>.<extension of the sniffed type>`; pass `name` instead to choose it (not both). `url` in the result is the URL the file finally came from, after redirects.

It rejects with `safeFetch`'s errors, all `SafeFetchError` subclasses with a `code`, so you can tell the user what went wrong without parsing messages:

| Error | `code` | When |
| --- | --- | --- |
| `HttpStatusError` | `http-status` | The server answered with a non-2xx status (`error.status`). |
| `ContentTypeError` | `content-type` | The sniffed type (`error.contentType`) is not in `contentTypes`. |
| `TooLargeError` | `too-large` | The file is larger than `maxSize`. |
| `TimeoutError` | `timeout` | `timeout` or `fetch.connectTimeout` ran out. |
| `BlockedAddressError`, `BlockedHostError`, `InvalidUrlError` | `blocked-address`, … | The URL was refused before connecting. |
| `DnsError`, `NetworkError`, `TooManyRedirectsError` | `dns`, … | The download failed. |

An abort through `signal` rejects with the signal's reason, as `fetch` does.

### `fetch(params | string, options?)`

Reads a file back as a web `Response` (streamed body, with `Content-Type`, `Content-Length`, and caching headers already set). Pass the object name as a string, or a `ReadFileParams` object to target a specific bucket:

```typescript
// From a controller — stream the stored file straight back to the client
return Storage.fetch(record.imageName);

// Or target a bucket explicitly
return Storage.fetch({ name: record.imageName, bucket: "private" });
```

```typescript
interface ReadFileParams {
  name: string;
  bucket?: string;
  range?: ByteRange | null;
}
```

Because `fetch` returns a `Response`, a controller can return it directly. See [Controllers](./controllers.md).

#### Cancelling a read

Like `put`, `fetch` takes an optional second argument, `{ signal }`. Use it to give up on a slow backend, or to stop reading when the client disconnects:

```typescript
// Give up after 10 seconds, including while the body is being read
const res = await Storage.fetch(name, { signal: AbortSignal.timeout(10_000) });
const bytes = await res.arrayBuffer(); // rejects with a TimeoutError on timeout

// Stop when the incoming request goes away
return Storage.fetch(name, { signal: req.rawRequest.signal });
```

An abort before the object is found rejects `fetch` itself. An abort after `fetch` resolved errors the returned body instead, so a pending `arrayBuffer()`, `text()` or stream read rejects rather than hanging, and the driver cancels the underlying stream, which closes the file or releases the connection. The S3 and Azure drivers also hand the signal to their SDK, which cancels the request in flight.

### `read(params | string, options?)`

Reads a file as bytes plus metadata, rather than as a finished `Response`. Use it with [`this.stream(...)`](./routing.md#streaming-and-range-requests) to serve range requests:

```typescript
"/assets/:src*": this.stream(async (req) => FileStorage.read(req.params.src)),
```

Inside a `this.stream(...)` route the in-flight request's `Range` is picked up automatically and pushed down to the storage backend, so a seek reads one window instead of the whole object. Pass a range explicitly — or `null` to force a full read — when you need to override that:

```typescript
await FileStorage.read(name, { range: req.range() });
await FileStorage.read(name, { range: null });
```

```typescript
interface ReadResult {
  body: ReadableStream<Uint8Array> | Blob | null;
  start: number; // absolute inclusive offsets of `body` within the object
  end: number;
  total: number; // authoritative size of the complete object
  partial: boolean; // whether the driver actually applied the range
  type: string;
  etag?: string;
  lastModified?: Date;
  name?: string;
}
```

An unsatisfiable range throws `RangeNotSatisfiableError`, and a missing object throws `FileNotFoundError`. Both extend `RequestBreakerError`, so they turn into a `416` and a `404` on their own.

See [Writing a custom driver](#writing-a-custom-driver) for how a driver implements `read()`.

### `objects(prefix, options?)`

Every object whose name starts with `prefix`, at any depth, as `{ name, size, lastModified }`. It returns an async iterable and paginates under the hood, so a prefix with a million objects never sits in memory at once. Iterate with `for await`:

```typescript
const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

for await (const object of Storage.objects("logs/")) {
  if (object.lastModified < cutoff) {
    await Storage.delete(object.name);
  }
}
```

It behaves the same on every built-in driver:

- **Prefix, not folder.** Matching is plain string-prefix, as in S3: `pages/1` also matches `pages/10/…`. End the prefix with `/` to stay inside one folder. `""` lists everything.
- **Recursive.** Objects in nested "folders" are included.
- `S3Driver` follows `ListObjectsV2` continuation tokens (1000 keys a page). Zero-byte "folder marker" objects some tools create are listed like any other object.
- `FileSystemDriver` walks its storage folder recursively, yields regular files only (symlinks are not followed), sorts by name, and refuses a prefix that resolves outside the folder (`../x`).
- `AzureBlobDriver` uses `listBlobsFlat({ prefix })`.

`options` takes `bucket` (ignored by the filesystem driver) and `signal`, which stops the listing between objects.

### `deletePrefix(prefix, options?)`

Deletes every object under `prefix` (same matching as `objects()`) and resolves with how many it deleted:

```typescript
const removed = await Storage.deletePrefix(`pages/${page.publicId}/`);
```

It refuses a prefix that would match the whole store: `""`, `"/"`, `"."`, `"./"`, whitespace, and on the filesystem driver anything that resolves to the storage folder itself (`"pages/../"`). Build prefixes from ids you have checked, and end them with `/`: `pages/${id}` with `id = "1"` also deletes `pages/10/…`.

- `S3Driver` sends one `DeleteObjects` per listed page (up to 1000 keys), and rejects if S3 reports any key it could not delete. Objects already removed stay removed, and running it again finishes the job.
- `FileSystemDriver` unlinks the files and then removes the directories that left empty inside the prefix.
- `AzureBlobDriver` (and any custom driver, by default) deletes one object at a time with `delete()`.

### `list(folder)` (deprecated)

Use `objects()`. The shape of `list()`'s result depends on the driver: the filesystem driver returns the top-level names of its storage folder and ignores `folder`, the S3 driver returns the raw first `ListObjectsV2` page (at most 1000 keys), and the Azure driver returns a `string[]` of blob names. It is kept unchanged for existing callers.

### `delete(params | string)`

Removes a stored object, by name or by `{ name, bucket? }`. Deleting an object that does not exist resolves without throwing, so a cleanup path can safely run twice or after an upload that never landed. Any other failure (permissions, network) still rejects.

```typescript
await Storage.delete("avatars/old.png");
await Storage.delete({ name: "report.pdf", bucket: "exports" });
```

Every built-in driver implements it: `FileSystemDriver` unlinks the file (and refuses a name that resolves outside its storage folder), `S3Driver` sends `DeleteObject`, and `AzureBlobDriver` deletes the blob.

### `metadata(blob | file)`

Reads image metadata (width, height, format, etc.) from a `Blob`/`File` using Sharp. Returns a partial metadata object, or `{}` if the bytes aren't a decodable image — useful for validating an upload before storing it.

```typescript
const meta = await Storage.metadata(uploadedFile);
if ((meta.width ?? 0) > 4096) {
  // reject oversized image
}
```

## Configuration: `app/config/filesystem.ts`

The active driver lives in the `filesystem` config slice, written with the `defineFilesystemConfig` helper and default-exported:

```typescript
// app/config/filesystem.ts
import { defineFilesystemConfig, FileSystemDriver } from "gemi/services";

export default defineFilesystemConfig({
  driver: new FileSystemDriver(),
});
```

Register the slice under the `filesystem` key on your kernel:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";

import filesystem from "../config/filesystem";

export default class extends Kernel {
  config = {
    filesystem,
    // ...other slices
  };
}
```

`FilesystemConfig` has exactly one optional field:

| Field | Type | Default |
| --- | --- | --- |
| `driver` | `FileStorageDriver` | `new FileSystemDriver()` |

If you omit the slice entirely, the default driver is used.

## Drivers

gemi ships three drivers; the default is `FileSystemDriver`.

### `FileSystemDriver` (local disk)

Writes to a folder on the local filesystem — defaults to `${process.env.ROOT_DIR}/storage`. Ideal for development.

```typescript
// app/config/filesystem.ts
import { defineFilesystemConfig, FileSystemDriver } from "gemi/services";

export default defineFilesystemConfig({
  driver: new FileSystemDriver(),
});
```

You can point it at a custom directory by passing a path to the constructor: `new FileSystemDriver("/var/data/uploads")`.

### `S3Driver` (S3 / S3-compatible)

Talks to AWS S3 or any S3-compatible service (Cloudflare R2, MinIO, DigitalOcean Spaces, …). The constructor forwards its arguments straight to the AWS SDK's `S3Client`, so you configure it exactly as you would that client:

```typescript
// app/config/filesystem.ts
import { defineFilesystemConfig, S3Driver } from "gemi/services";

export default defineFilesystemConfig({
  driver: new S3Driver({
    region: process.env.AWS_REGION,
    // endpoint is optional — set it for S3-compatible services like R2/MinIO
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});
```

The bucket comes from `params.bucket` when provided, otherwise from `process.env.BUCKET_NAME`. See [Configuration](./configuration.md) for where to define these environment variables.

> **Note:** All drivers fall back to `process.env.BUCKET_NAME` as the default bucket. For `put`, an explicitly passed `contentType` is used as-is; without one, the S3 driver falls back to the type of the `Blob`/`File` body. A `Buffer` body has no type of its own, so pass `contentType` alongside it or the object is stored without one.

### `AzureBlobDriver` (Azure Blob Storage)

`@azure/storage-blob` is an **optional peer dependency** — install it only if you use this driver:

```bash
bun add @azure/storage-blob
```

```typescript
// app/config/filesystem.ts
import { defineFilesystemConfig, AzureBlobDriver } from "gemi/services";

export default defineFilesystemConfig({
  driver: new AzureBlobDriver({
    // defaults to process.env.AZURE_STORAGE_CONNECTION_STRING
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    container: process.env.BUCKET_NAME,
  }),
});
```

The SDK is loaded lazily on first use, so importing `gemi/services` costs nothing when the driver is unused. Using it without the package installed throws an error telling you to install it.

Instead of a connection string you can pass an account `url` (optionally carrying a SAS token) with a `credential`, or hand over a fully built client — useful for a custom credential chain, retry policy or proxy. With `serviceClient` the driver never imports the SDK at all:

```typescript
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

new AzureBlobDriver({
  url: "https://myaccount.blob.core.windows.net",
  credential: new DefaultAzureCredential(),
});

// or fully pre-built
new AzureBlobDriver({
  serviceClient: BlobServiceClient.fromConnectionString(conn),
  container: "media",
});
```

The container comes from `params.bucket`, then the `container` config, then `process.env.BUCKET_NAME`. `objects(prefix)` reads each blob's size and last-modified time from the listing; the deprecated `list(folder)` returns a `string[]` of blob names.

**On range requests:** Azure's `download(offset, count)` takes an absolute offset and has no suffix form, so the driver handles the two cases differently. `bytes=S-E` and `bytes=S-` — everything a media player actually sends — go straight to the download and read the authoritative total back off Azure's own `Content-Range`, costing no extra round trip. A suffix range (`bytes=-N`) needs one `getProperties()` first to resolve it into absolute offsets.

### Writing a custom driver

Subclass `FileStorageDriver` (exported from `gemi/services`) and implement `put`, `fetch`, `list` and `delete`:

```typescript
import {
  FileStorageDriver,
  type DeleteFileParams,
  type FetchFileOptions,
  type ListObjectsOptions,
  type PutFileOptions,
  type PutFileParams,
  type ReadFileParams,
  type StoredObject,
} from "gemi/services";

class MyDriver extends FileStorageDriver {
  async put(
    params: PutFileParams | Blob,
    { signal }: PutFileOptions = {},
  ): Promise<string> {
    /* ...store and return the object name, honouring `signal`... */
  }
  async fetch(
    params: ReadFileParams | string,
    { signal }: FetchFileOptions = {},
  ): Promise<Response> {
    /* ...return a Response streaming the object, honouring `signal`... */
  }
  async list(folder: string): Promise<any> {
    /* deprecated, but still abstract: return anything */
  }
  async delete(params: DeleteFileParams | string): Promise<void> {
    /* ...remove the object; resolve, don't throw, if it is already gone... */
  }
  async *objects(
    prefix: string,
    { bucket, signal }: ListObjectsOptions = {},
  ): AsyncIterable<StoredObject> {
    /* ...yield { name, size, lastModified } for every object under prefix... */
  }
}
```

`objects()` is not abstract either; its default throws `<Driver> does not implement objects()`. Once it and `delete()` are implemented, `deletePrefix()` works through the default (list, then delete one by one); override it if the backend can delete in batches, and call `assertDeletablePrefix(prefix)` first.

`delete()` is not abstract, so a driver written before it existed still compiles, but its default throws `<Driver> does not implement delete()` rather than pretending the object is gone. Override it.

`putStream({ name, bucket, body, contentType }, { signal })`, which `Storage.putFromUrl()` stores through, has a default too: it reads the stream into memory and calls `put()`, so a stream that errors never reaches the backend. Override it when the backend can take a stream, and make sure an error or abort halfway leaves no object behind (`FileSystemDriver` writes a temporary file and renames it).

`read()` and `size()` already have working defaults, so a driver that implements only the three methods above still compiles and gains range support — but the default `read()` buffers the whole object to serve a range, which saves no bandwidth from the backend.

Override `read()` whenever the backend can range natively. Report the *authoritative* total, which most backends hand back in their own `Content-Range` on a ranged read — that is what keeps a range down to a single round trip:

```typescript
import { parseContentRange, resolveRange, toRangeHeaderValue } from "gemi/services";

async read({ name, range }) {
  const res = await backend.get(name, range ? toRangeHeaderValue(range) : undefined);
  const cr = parseContentRange(res.headers["content-range"]);
  return {
    body: res.stream,
    start: cr?.start ?? 0,
    end: cr?.end ?? (res.size - 1),
    total: cr?.total ?? res.size,
    partial: Boolean(cr),
    type: res.contentType,
  };
}
```

Two things to get right:

- `partial` says whether *you* applied the range, and cannot be derived from the offsets: `bytes=0-` over a whole object is a `206` whose window spans the entire file. A driver that ignored the range must report `false`, or the response will carry a `Content-Range` that does not describe the body it sent.
- Backends without a native suffix range (`bytes=-N`) need one size lookup first — see `AzureBlobDriver` for a worked example. Use `resolveRange(range, total)` to turn it into absolute offsets, and throw `RangeNotSatisfiableError(total)` when it returns `null`.

Prefer returning a `Blob` over a `ReadableStream` when the backend gives you a sized handle: Bun drops an explicitly set `Content-Length` and falls back to chunked encoding for any stream body, but keeps it for a sized blob.

Then point `app/config/filesystem.ts` at it:

```typescript
import { defineFilesystemConfig } from "gemi/services";
import { MyDriver } from "../storage/MyDriver";

export default defineFilesystemConfig({
  driver: new MyDriver(),
});
```

### Replacing the manager entirely

Config covers the normal case. If you need to swap the `FilesystemManager` itself, rebind its token from your own service provider — a `ServiceProvider`'s `register()` binds into the container, and app providers listed in `providers` register **after** the framework's, so the last binding wins:

```typescript
// app/providers/AppServiceProvider.ts
import { ServiceProvider } from "gemi/support";
import { FilesystemManager } from "gemi/services";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(FilesystemManager, () => new TenantAwareFilesystem());
  }
}
```

```typescript
// app/kernel/Kernel.ts
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  providers = [AppServiceProvider];
}
```

## Image optimization

gemi optimizes images on demand — resizing and re-encoding to WebP — through the `ImageManager`, which uses a Sharp-backed driver by default. It needs no configuration at all; supply an `image` slice only to swap the driver:

```typescript
// app/config/image.ts
import { defineImageConfig } from "gemi/services";
import { MySharpVariant } from "../images/MySharpVariant";

export default defineImageConfig({
  driver: new MySharpVariant(),
});
```

```typescript
// app/kernel/Kernel.ts
import image from "../config/image";

export default class extends Kernel {
  config = {
    image,
    // ...other slices
  };
}
```

A custom driver subclasses `ImageOptimizationDriver` (from `gemi/services`) and implements `resize(buffer, params)`.

The `Sharp` driver's `resize` accepts `ResizeParameters`:

```typescript
type ResizeParameters = {
  width: number;
  height: number;
  quality?: number;            // defaults to 80
  fit?: keyof FitEnum;         // "contain" | "cover" | "fill" | "inside" | "outside"
};
```

Zero or missing `width`/`height` is treated as "unconstrained" for that dimension, and the output is always encoded as WebP.

### How images are served

The service exposes an internal route:

```
GET /api/__gemi__/services/image/resize?url=<src>&w=<width>&h=<height>&fit=<fit>&q=<quality>
```

It fetches the source image at `url` (an absolute URL, or a path resolved against the local dev server), runs it through the optimization driver, and streams back `image/webp`. You rarely build these URLs by hand — the `Image` component does it for you. `fit` defaults to `cover` and `q` to `80`.

## The client `Image` component

Import from `gemi/client`. It renders a responsive `<img>` whose `srcSet` points at the resize route, so browsers download an appropriately sized WebP for the viewport and DPR.

```tsx
import { Image } from "gemi/client";

<Image src={`/api/files/${record.imageName}`} width={640} alt="Product" />;
```

Props (on top of all standard `<img>` attributes):

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `src` | `string` | — | Source image URL/path (passed to the resize route as `url`). Required. |
| `width` | `number` | — | Intended render width in px. Drives the generated widths and the `2x` candidate. Required. |
| `quality` | `number` | `80` | WebP quality passed as `q`. |
| `container` | `number[]` | `[100,100,100,100]` | Percentage of each screen breakpoint the image occupies (its column width), used to compute candidate widths. |
| `screen` | `number[]` | `[390, 768, 1024]` | Breakpoints (px) the `srcSet`/sizes are generated against. |

It automatically generates a `srcSet` (including a `2x` high-DPR candidate at `width * 2`) so you don't set `srcSet` yourself.

> **Note:** `src` may be a local path (e.g. a controller route that streams a stored file) or an absolute URL. The resize route resolves relative paths against the dev server origin.

### `OpenGraphImage`

Also exported from `gemi/client`, `OpenGraphImage` renders a React tree into an Open Graph image (via Satori) for social sharing previews. You pass Satori options (`width`, `height`, `fonts`, …) plus the JSX to render as `children`:

```tsx
import { OpenGraphImage } from "gemi/client";

<OpenGraphImage width={1200} height={630} fonts={[/* ... */]}>
  <div style={{ display: "flex" }}>My page title</div>
</OpenGraphImage>;
```

This pairs with the `OpenGraph` metadata helpers — see [`Meta`/facades](./facades.md) for wiring page-level Open Graph tags.

## Related

- [Facades](./facades.md) — how `Storage` resolves the active `FilesystemManager` from the container.
- [Kernel & Service Providers](./project-structure.md) — the `config` and `providers` fields on the kernel.
- [Controllers](./controllers.md) — returning a `Storage.fetch` `Response` from a route.
- [Configuration](./configuration.md) — the `BUCKET_NAME`, `ROOT_DIR`, and S3 credential environment variables.
