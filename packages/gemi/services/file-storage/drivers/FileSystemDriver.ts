import type {
  DeleteFileParams,
  DeletePrefixOptions,
  FetchFileOptions,
  ListObjectsOptions,
  StoredObject,
  PutFileOptions,
  PutFileParams,
  PutStreamParams,
  ReadFileParams,
  ReadResult,
} from "./types";
import { FileStorageDriver, assertDeletablePrefix } from "./FileStorageDriver";
import { abortableBody } from "./abortableBody";
import { mkdir, open, readdir, rename, rmdir, stat, unlink } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveRange } from "../../../http/range";
import { FileNotFoundError, RangeNotSatisfiableError } from "../../../http/errors";
import { projectRoot } from "../../../support/discover";

export class FileSystemDriver extends FileStorageDriver {
  private readonly configured?: string;

  constructor(folderPath?: string) {
    super();
    this.configured = folderPath;
  }

  /**
   * Computed per read, not baked into a constructor default.
   *
   * This is the second time this exact bug has been written in this repository,
   * and `LogManager.logsDirPath` carries the first one's post-mortem: a driver
   * is constructed when `app/config/filesystem.ts` is evaluated, and that
   * happens *before* the http layer sets `ROOT_DIR`. So the old default,
   * `` `${process.env.ROOT_DIR}/storage` ``, interpolated `undefined` and froze
   * it — measured, `new FileSystemDriver().folderPath` was `"undefined/storage"`
   * with `ROOT_DIR` unset, and stayed `"undefined/storage"` after the server set
   * it a moment later.
   *
   * It fails quietly, which is what makes it worth a comment rather than a
   * one-line fix: reads and writes both used the same wrong folder, so nothing
   * threw and nothing 404'd. Files simply accumulated in a stray `undefined/`
   * directory beside the project, and the only way to notice was to look.
   *
   * `projectRoot()` is the same rule `httpProd` computes `ROOT_DIR` from, so an
   * explicit folder still wins and an app that configured nothing now gets the
   * directory it always meant.
   */
  private get folderPath(): string {
    return this.configured ?? `${projectRoot()}/storage`;
  }

  async put(params: PutFileParams | Blob, { signal }: PutFileOptions = {}) {
    signal?.throwIfAborted();

    let body: Blob | File | Buffer;
    let name: string;

    if (params instanceof Blob) {
      body = params;
      name = `${Bun.randomUUIDv7()}.${params.type.split("/")[1].split(";")[0]}`;
    } else {
      body = params.body;
      name = params.name;
    }

    const buffer =
      body instanceof Buffer
        ? body
        : body instanceof Blob || body instanceof File
          ? Buffer.from(await body.arrayBuffer())
          : "";

    const path = `${this.folderPath}/${name}`;

    // `Bun.write` takes no signal, and a local write is not worth interrupting
    // halfway, so the last chance to abort is once the body has been read.
    signal?.throwIfAborted();
    await Bun.write(path, buffer as any);

    return name;
  }

  /**
   * Writes the stream to a temporary file next to the target and renames it
   * into place once the stream has ended, so an error or an abort halfway
   * leaves no file, and a reader never sees a half-written one. Memory stays
   * at one chunk however large the file.
   */
  async putStream(
    { name, body }: PutStreamParams,
    { signal }: PutFileOptions = {},
  ): Promise<string> {
    const reader = body.getReader();
    let partial: string | null = null;
    try {
      signal?.throwIfAborted();
      if (!name) {
        throw new Error("Object name has to be specified");
      }
      const root = resolve(this.folderPath);
      const path = resolve(root, name);
      const rel = relative(root, path);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Refusing to write "${name}": it is outside the storage folder`);
      }

      await mkdir(dirname(path), { recursive: true });
      partial = `${path}.${Bun.randomUUIDv7()}.partial`;
      const file = await open(partial, "wx");
      try {
        for (;;) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          // `write` may take fewer bytes than it was given.
          for (let offset = 0; offset < value.byteLength; ) {
            const { bytesWritten } = await file.write(value, offset);
            offset += bytesWritten;
          }
        }
      } finally {
        await file.close();
      }
      signal?.throwIfAborted();
      await rename(partial, path);
      return name;
    } catch (error) {
      // Also on a refusal before the first read: the source (a download) is
      // released now rather than when its own timeout runs out.
      await reader.cancel(error).catch(() => {});
      if (partial) await unlink(partial).catch(() => {});
      throw error;
    }
  }

  async fetch(
    params: ReadFileParams | string,
    { signal }: FetchFileOptions = {},
  ) {
    signal?.throwIfAborted();

    let bucket = process.env.BUCKET_NAME;
    let name: string | undefined;

    if (typeof params === "string") {
      name = params;
    } else {
      bucket = params.bucket ?? bucket;
      name = params.name;
    }

    if (!name) {
      throw new Error("Object name has to be specified");
    }

    const path = `${this.folderPath}/${name}`;
    const file = Bun.file(path);
    // The disk read has no signal of its own. The body is wrapped instead, so
    // an abort stops the stream and closes the file mid-read.
    const result = abortableBody(Bun.file(path).stream(), signal);
    const date = new Date(file.lastModified).toUTCString();

    return new Response(result, {
      headers: {
        "Content-Type": file.type,
        "Content-Length": String(file.size),
        "Cache-Control": "private, max-age=12000, must-revalidate",
        // TODO: fix this.
        "Last-Modified": date,
      },
    });
  }

  async read(input: ReadFileParams | string): Promise<ReadResult> {
    const params = typeof input === "string" ? { name: input } : input;
    const { name, range = null } = params;

    if (!name) {
      throw new Error("Object name has to be specified");
    }

    const file = Bun.file(`${this.folderPath}/${name}`);

    // `Bun.file()` is lazy. Without this the response commits with a 200 and
    // the ENOENT only surfaces once the stream is pulled, as an unhandled
    // rejection with the status already on the wire.
    if (!(await file.exists())) {
      throw new FileNotFoundError(name);
    }

    const total = file.size;
    const resolved = range ? resolveRange(range, total) : null;

    if (range && !resolved) {
      throw new RangeNotSatisfiableError(total);
    }

    const start = resolved?.start ?? 0;
    const end = resolved ? resolved.end : total - 1;

    return {
      // A BunFile slice stays lazy and keeps a known size, so Bun can send it
      // with a real Content-Length instead of falling back to chunked.
      body: resolved ? file.slice(start, end + 1) : file,
      start,
      end,
      total,
      partial: Boolean(resolved),
      type: file.type || "application/octet-stream",
      lastModified: new Date(file.lastModified),
      name,
    };
  }

  async size(params: ReadFileParams | string) {
    const name = typeof params === "string" ? params : params.name;
    const file = Bun.file(`${this.folderPath}/${name}`);
    if (!(await file.exists())) {
      throw new FileNotFoundError(name);
    }
    return file.size;
  }

  async delete(params: DeleteFileParams | string) {
    const name = typeof params === "string" ? params : params.name;

    if (!name) {
      throw new Error("Object name has to be specified");
    }

    // A bucket key cannot climb out of its bucket, but a path can: refuse a
    // name that resolves outside the storage folder rather than unlink it.
    const root = resolve(this.folderPath);
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Refusing to delete "${name}": it is outside the storage folder`);
    }

    try {
      await unlink(path);
    } catch (err: any) {
      // Already gone is the outcome the caller asked for.
      if (err?.code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  /**
   * Resolves `prefix` against the storage folder and returns the directory to
   * walk plus the normalized prefix every match must start with. A prefix
   * that climbs out of the folder (`../x`, `a/../../b`) is refused, as in
   * `delete()`.
   */
  private resolvePrefix(prefix: string) {
    const root = resolve(this.folderPath);
    const slash = prefix.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : prefix.slice(0, slash);
    const namePart = slash === -1 ? prefix : prefix.slice(slash + 1);
    const dir = resolve(root, dirPart);
    const rel = relative(root, dir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Refusing to list "${prefix}": it is outside the storage folder`);
    }
    const dirRel = rel.split(sep).join("/");
    return { root, dir, match: dirRel ? `${dirRel}/${namePart}` : namePart };
  }

  /**
   * Walks the storage folder recursively and yields regular files whose path
   * (relative to the folder, `/`-separated) starts with `prefix`, sorted by
   * name like an S3 listing. Symlinks are not followed, so a link cannot lead
   * the walk out of the folder. A missing directory lists nothing.
   */
  async *objects(
    prefix: string,
    { signal }: ListObjectsOptions = {},
  ): AsyncIterable<StoredObject> {
    signal?.throwIfAborted();
    const { root, dir, match } = this.resolvePrefix(prefix);

    const files: string[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return;
        throw err;
      }
      for (const entry of entries) {
        const full = `${current}${sep}${entry.name}`;
        const name = relative(root, full).split(sep).join("/");
        if (entry.isDirectory()) {
          // Descend only where a match is still possible: into `pages/1` for
          // the prefix `pages/10`, not into `pages/2`.
          if (`${name}/`.startsWith(match) || match.startsWith(`${name}/`)) {
            await walk(full);
          }
        } else if (entry.isFile() && name.startsWith(match)) {
          files.push(name);
        }
      }
    };
    await walk(dir);
    files.sort();

    for (const name of files) {
      signal?.throwIfAborted();
      let info;
      try {
        info = await stat(`${root}/${name}`);
      } catch (err: any) {
        // Removed between the walk and now: not there to list.
        if (err?.code === "ENOENT") continue;
        throw err;
      }
      yield { name, size: info.size, lastModified: info.mtime };
    }
  }

  /**
   * Unlinks every file under `prefix`, then removes the directories that
   * leaves empty (never the storage folder itself).
   */
  async deletePrefix(
    prefix: string,
    options: DeletePrefixOptions = {},
  ): Promise<number> {
    assertDeletablePrefix(prefix);
    const { root, match } = this.resolvePrefix(prefix);
    // `a/..` passes the generic check but resolves to the folder itself.
    assertDeletablePrefix(match);

    const deleted = await super.deletePrefix(prefix, options);

    if (deleted > 0) {
      await this.pruneEmptyDirs(root, match);
    }
    return deleted;
  }

  private async pruneEmptyDirs(root: string, match: string) {
    // Every directory inside the prefix, deepest first. The prefix's parents
    // (`pages/` for `pages/42/`) are left alone, as is the storage folder.
    const dirs: string[] = [];
    const collect = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = `${current}${sep}${entry.name}`;
        const name = relative(root, full).split(sep).join("/");
        if (`${name}/`.startsWith(match) || match.startsWith(`${name}/`)) {
          await collect(full);
          if (`${name}/`.startsWith(match)) dirs.push(full);
        }
      }
    };
    await collect(root);

    for (const dir of dirs) {
      try {
        await rmdir(dir);
      } catch {
        // Not empty (something unrelated lives there) or already gone.
      }
    }
  }

  /** @deprecated Lists only the top level of the storage folder. Use `objects(prefix)`. */
  async list() {
    const files = await readdir(this.folderPath);

    return files;
  }
}
