# File Storage

gemi ships a driver-based file storage service with a single facade, `Storage`, that reads and writes files without your controllers ever knowing whether the bytes live on the local disk or in an S3 bucket. It also includes an on-the-fly image optimization service and a client `Image` component that requests resized, WebP-encoded variants automatically.

Configure it in `app/config/filesystem.ts` — see [Kernel & Service Providers](./project-structure.md) — and call it through the [`Storage` facade](./facades.md).

## The `Storage` facade

Import the facade from `gemi/facades`:

```typescript
import { Storage } from "gemi/facades";
```

`Storage` is a static proxy over the `FilesystemManager` that the framework's `FilesystemServiceProvider` binds into the container from your `filesystem` config. Every method delegates to the configured driver, so the surface is intentionally small.

### `put(params | Blob)`

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

### `fetch(params | string)`

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

### `list(folder)`

Lists the objects under a folder/prefix. The shape of the result depends on the driver (the filesystem driver returns a `string[]` of file names; the S3 driver returns the raw `ListObjectsV2` result).

```typescript
const files = await Storage.list("avatars/");
```

### `metadata(blob | file)`

Reads image metadata (width, height, format, etc.) from a `Blob`/`File` using Sharp. Returns a partial metadata object, or `{}` if the bytes aren't a decodable image — useful for validating an upload before storing it.

```typescript
const meta = await Storage.metadata(uploadedFile);
if ((meta.width ?? 0) > 4096) {
  // reject oversized image
}
```

> **Note:** `Storage.delete()` is currently a no-op placeholder — deletion is not yet implemented at the facade level.

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

The container comes from `params.bucket`, then the `container` config, then `process.env.BUCKET_NAME`. `list(folder)` returns a `string[]` of blob names under the prefix.

**On range requests:** Azure's `download(offset, count)` takes an absolute offset and has no suffix form, so the driver handles the two cases differently. `bytes=S-E` and `bytes=S-` — everything a media player actually sends — go straight to the download and read the authoritative total back off Azure's own `Content-Range`, costing no extra round trip. A suffix range (`bytes=-N`) needs one `getProperties()` first to resolve it into absolute offsets.

### Writing a custom driver

Subclass `FileStorageDriver` (exported from `gemi/services`) and implement `put`, `fetch` and `list`:

```typescript
import {
  FileStorageDriver,
  type PutFileParams,
  type ReadFileParams,
} from "gemi/services";

class MyDriver extends FileStorageDriver {
  async put(params: PutFileParams | Blob): Promise<string> {
    /* ...store and return the object name... */
  }
  async fetch(params: ReadFileParams | string): Promise<Response> {
    /* ...return a Response streaming the object... */
  }
  async list(folder: string): Promise<any> {
    /* ... */
  }
}
```

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
