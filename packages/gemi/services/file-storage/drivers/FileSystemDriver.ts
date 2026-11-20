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
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "fs/promises";
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

  /**
   * The storage folder with every symbolic link in its own path resolved, so
   * a folder that is itself a link (a directory shared between releases) is
   * used as the directory it points to. A folder that does not exist yet is
   * created for a write and left alone otherwise: nothing below it exists, so
   * there is nothing to check.
   */
  private async realRoot(operation: "read" | "write" | "delete"): Promise<string> {
    const root = resolve(this.folderPath);
    try {
      return await realpath(root);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      if (operation !== "write") return root;
    }
    await mkdir(root, { recursive: true });
    return realpath(root);
  }

  /**
   * Whether an entry from `root` down to `root/rel` is a symbolic link. Only
   * the components that exist are checked; the first missing one ends the
   * walk, since nothing below it can be a link.
   */
  private async passesThroughLink(root: string, rel: string): Promise<boolean> {
    if (!rel) return false;
    let current = root;
    for (const part of rel.split(sep)) {
      current = `${current}${sep}${part}`;
      try {
        if ((await lstat(current)).isSymbolicLink()) return true;
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false;
        throw err;
      }
    }
    return false;
  }

  /**
   * Resolves an object name to its path inside the storage folder and refuses
   * it when it climbs out of the folder, contains a NUL byte, or is or passes
   * through a symbolic link below the folder. A refused read is reported like
   * a missing object; a refused write or delete rejects and touches nothing.
   */
  private async resolveObjectPath(name: string, operation: "read" | "write" | "delete"): Promise<string> {
    if (!name) {
      throw new Error("Object name has to be specified");
    }
    const lexicalRoot = resolve(this.folderPath);
    const rel = relative(lexicalRoot, resolve(lexicalRoot, name));
    const hasNul = name.includes("\0");
    if (hasNul || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      if (operation === "read") throw new FileNotFoundError(name);
      if (hasNul) throw new Error(`Refusing to ${operation} an object name containing a NUL byte`);
      throw new Error(`Refusing to ${operation} "${name}": it is outside the storage folder`);
    }
    const root = await this.realRoot(operation);
    if (await this.passesThroughLink(root, rel)) {
      if (operation === "read") throw new FileNotFoundError(name);
      throw new Error(`Refusing to ${operation} "${name}": it is or passes through a symbolic link`);
    }
    return `${root}${sep}${rel}`;
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

    const path = await this.resolveObjectPath(name, "write");
    const buffer =
      body instanceof Buffer
        ? body
        : body instanceof Blob || body instanceof File
          ? Buffer.from(await body.arrayBuffer())
          : "";

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
   *
   * The name is checked for symbolic links before the temporary file is
   * created and again before the rename, so a link that appeared at the name
   * or in a parent while the stream ran is refused rather than replaced.
   */
  async putStream(
    { name, body }: PutStreamParams,
    { signal }: PutFileOptions = {},
  ): Promise<string> {
    const reader = body.getReader();
    let partial: string | null = null;
    try {
      signal?.throwIfAborted();
      const path = await this.resolveObjectPath(name, "write");

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
      if ((await this.resolveObjectPath(name, "write")) !== path) {
        throw new Error(`Refusing to write "${name}": the storage folder moved during the write`);
      }
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

    const name = typeof params === "string" ? params : params.name;
    const file = Bun.file(await this.resolveObjectPath(name, "read"));
    // Checked here for the same reason as in `read()`: a lazy `Bun.file()`
    // would otherwise answer 200 and fail only once the body is pulled.
    if (!(await file.exists())) {
      throw new FileNotFoundError(name);
    }
    // The disk read has no signal of its own. The body is wrapped instead, so
    // an abort stops the stream and closes the file mid-read.
    const result = abortableBody(file.stream(), signal);
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

    const file = Bun.file(await this.resolveObjectPath(name, "read"));

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
    const file = Bun.file(await this.resolveObjectPath(name, "read"));
    if (!(await file.exists())) {
      throw new FileNotFoundError(name);
    }
    return file.size;
  }

  async delete(params: DeleteFileParams | string) {
    const name = typeof params === "string" ? params : params.name;

    // A link at the name or in a parent is refused, so neither the link nor
    // its target is removed.
    const path = await this.resolveObjectPath(name, "delete");

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
   * `delete()`. `linked` is true when the directory to walk is, or passes
   * through, a symbolic link below the storage folder.
   */
  private async resolvePrefix(prefix: string) {
    const lexicalRoot = resolve(this.folderPath);
    const slash = prefix.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : prefix.slice(0, slash);
    const namePart = slash === -1 ? prefix : prefix.slice(slash + 1);
    const rel = relative(lexicalRoot, resolve(lexicalRoot, dirPart));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Refusing to list "${prefix}": it is outside the storage folder`);
    }
    const root = await this.realRoot("read");
    const dir = rel ? `${root}${sep}${rel}` : root;
    const linked = await this.passesThroughLink(root, rel);
    const dirRel = rel.split(sep).join("/");
    return { root, dir, linked, match: dirRel ? `${dirRel}/${namePart}` : namePart };
  }

  /**
   * Walks the storage folder recursively and yields regular files whose path
   * (relative to the folder, `/`-separated) starts with `prefix`, sorted by
   * name like an S3 listing. Symbolic links are skipped, never followed, so a
   * link cannot lead the walk out of the folder and the listing names only
   * objects that `read()` serves. A missing directory lists nothing, and so
   * does a prefix whose directory is or passes through a link.
   */
  async *objects(
    prefix: string,
    { signal }: ListObjectsOptions = {},
  ): AsyncIterable<StoredObject> {
    signal?.throwIfAborted();
    const { root, dir, linked, match } = await this.resolvePrefix(prefix);
    if (linked) return;

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
        info = await lstat(`${root}/${name}`);
      } catch (err: any) {
        // Removed between the walk and now: not there to list.
        if (err?.code === "ENOENT") continue;
        throw err;
      }
      // Replaced by a link (or anything else) since the walk.
      if (!info.isFile()) continue;
      yield { name, size: info.size, lastModified: info.mtime };
    }
  }

  /**
   * Unlinks every file under `prefix`, then removes the directories that
   * leaves empty (never the storage folder itself). Symbolic links found
   * during the walk are left in place and their targets untouched, so a
   * directory holding one is not removed. A prefix whose directory is or
   * passes through a link is refused, as `delete()` refuses such a name.
   */
  async deletePrefix(
    prefix: string,
    options: DeletePrefixOptions = {},
  ): Promise<number> {
    assertDeletablePrefix(prefix);
    const { root, linked, match } = await this.resolvePrefix(prefix);
    // `a/..` passes the generic check but resolves to the folder itself.
    assertDeletablePrefix(match);
    if (linked) {
      throw new Error(`Refusing to delete by prefix "${prefix}": it passes through a symbolic link`);
    }

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
