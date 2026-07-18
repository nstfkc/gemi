# File Storage

gemi ships a driver-based file storage service with a single facade, `FileStorage`, that reads and writes files without your controllers ever knowing whether the bytes live on the local disk or in an S3 bucket. It also includes an on-the-fly image optimization service and a client `Image` component that requests resized, WebP-encoded variants automatically.

Configure it through the `FileStorageServiceProvider` in your app's kernel — see [Kernel & Service Providers](./project-structure.md) — and call it through the [`FileStorage` facade](./facades.md).

## The `FileStorage` facade

Import the facade from `gemi/facades`:

```typescript
import { FileStorage } from "gemi/facades";
```

Every method delegates to the configured driver, so the surface is intentionally small.

### `put(params | Blob)`

Stores a file and returns the stored object's **name** (a string) that you persist and later use to fetch the file back.

```typescript
// Store an uploaded file with an explicit name
const name = await FileStorage.put({
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
const name = await FileStorage.put(uploadedBlob);
```

> **Note:** `put` returns the object name, not a URL. Store that name against your record; you serve the file later by handing the name to `FileStorage.fetch` (typically from a controller route).

### `fetch(params | string)`

Reads a file back as a web `Response` (streamed body, with `Content-Type`, `Content-Length`, and caching headers already set). Pass the object name as a string, or a `ReadFileParams` object to target a specific bucket:

```typescript
// From a controller — stream the stored file straight back to the client
return FileStorage.fetch(record.imageName);

// Or target a bucket explicitly
return FileStorage.fetch({ name: record.imageName, bucket: "private" });
```

```typescript
interface ReadFileParams {
  name: string;
  bucket?: string;
}
```

Because `fetch` returns a `Response`, a controller can return it directly. See [Controllers](./controllers.md).

### `list(folder)`

Lists the objects under a folder/prefix. The shape of the result depends on the driver (the filesystem driver returns a `string[]` of file names; the S3 driver returns the raw `ListObjectsV2` result).

```typescript
const files = await FileStorage.list("avatars/");
```

### `metadata(blob | file)`

Reads image metadata (width, height, format, etc.) from a `Blob`/`File` using Sharp. Returns a partial metadata object, or `{}` if the bytes aren't a decodable image — useful for validating an upload before storing it.

```typescript
const meta = await FileStorage.metadata(uploadedFile);
if ((meta.width ?? 0) > 4096) {
  // reject oversized image
}
```

> **Note:** `FileStorage.delete()` is currently a no-op placeholder — deletion is not yet implemented at the facade level.

## Drivers

The active driver is set on your app's `FileStorageServiceProvider`. gemi ships two drivers; the default is `FileSystemDriver`.

### `FileSystemDriver` (local disk)

Writes to a folder on the local filesystem — defaults to `${process.env.ROOT_DIR}/storage`. Ideal for development.

```typescript
// app/kernel/providers/FileStorageServiceProvider.ts
import {
  FileStorageServiceProvider,
  FileSystemDriver,
} from "gemi/services";

export default class extends FileStorageServiceProvider {
  driver = new FileSystemDriver();
}
```

You can point it at a custom directory by passing a path to the constructor: `new FileSystemDriver("/var/data/uploads")`.

### `S3Driver` (S3 / S3-compatible)

Talks to AWS S3 or any S3-compatible service (Cloudflare R2, MinIO, DigitalOcean Spaces, …). The constructor forwards its arguments straight to the AWS SDK's `S3Client`, so you configure it exactly as you would that client:

```typescript
// app/kernel/providers/FileStorageServiceProvider.ts
import { FileStorageServiceProvider, S3Driver } from "gemi/services";

export default class extends FileStorageServiceProvider {
  driver = new S3Driver({
    region: process.env.AWS_REGION,
    // endpoint is optional — set it for S3-compatible services like R2/MinIO
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}
```

The bucket comes from `params.bucket` when provided, otherwise from `process.env.BUCKET_NAME`. See [Configuration](./configuration.md) for where to define these environment variables.

> **Note:** Both drivers fall back to `process.env.BUCKET_NAME` as the default bucket. For `put`, the S3 driver derives `contentType` from the blob/file when the body is a `Blob`/`File`.

### Writing a custom driver

Any storage backend works by subclassing `FileStorageDriver` (exported from `gemi/services`) and implementing `put`, `fetch`, and `list`:

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

## Image optimization

gemi optimizes images on demand — resizing and re-encoding to WebP — through the `ImageOptimizationServiceProvider`, which uses a Sharp-backed driver by default.

```typescript
// app/kernel/providers/ImageOptimizationServiceProvider.ts
import { ImageOptimizationServiceProvider } from "gemi/services";

// The default provider already uses the Sharp driver — subclass only to override.
export default class extends ImageOptimizationServiceProvider {}
```

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

- [Facades](./facades.md) — how `FileStorage` resolves the active service.
- [Kernel & Service Providers](./project-structure.md) — registering `FileStorageServiceProvider` and `ImageOptimizationServiceProvider`.
- [Controllers](./controllers.md) — returning a `FileStorage.fetch` `Response` from a route.
- [Configuration](./configuration.md) — the `BUCKET_NAME`, `ROOT_DIR`, and S3 credential environment variables.
