import type {
  PutFileParams,
  ReadFileParams,
  ReadResult,
} from "../../services/file-storage/drivers/types";

/**
 * The bytes of an upload, kept by gemi, and the scope that says whose they are.
 *
 * WHY THIS EXISTS. `AgentController.upload` used to hand the file straight to
 * the model provider and keep nothing, which is the trade `AgentProvider.upload`
 * documents — provider file ids in the history, no storage story. That is a fine
 * trade for vision and it fails the moment a *tool* needs the file: the user
 * uploads an image and asks the agent to create a product, `POST /products`
 * wants multipart bytes, and the server is holding a provider file id and
 * nothing else. The model cannot make up the difference — it *saw* the image, it
 * cannot reproduce it — and the only recovery left is downloading from the
 * vendor, which is a round trip for bytes we held minutes ago, is not declared
 * anywhere (`AgentProvider` has `upload` and no counterpart), and is subject to
 * a retention policy that is not ours.
 *
 * WHY THE SCOPE IS NOT OPTIONAL. Once a tool takes an attachment id as an
 * argument, that id arrives *from the model*, and a model's arguments are as
 * untrusted as a request body: whatever the model wrote is a function of what it
 * read, and it reads the user's text, tool output, and any document it was
 * shown. A store that resolves ids globally therefore lets a prompt-injected
 * model name another tenant's upload and have the server fetch it — the model as
 * confused deputy, spending the server's own credentials.
 *
 * So there is no `find(id)` on this interface, only `find(scope, id)`, and the
 * thing a tool is handed is a `ScopedAttachments` whose methods take no scope at
 * all because it already closed over one. The unscoped read is not discouraged,
 * it is unspellable: the tool has no object to call it on. The scope itself is
 * derived from the server's own knowledge of the request — see
 * `AgentController.attachmentScope` — and never from anything the model can
 * write.
 */

/**
 * The subject an attachment belongs to, as one opaque string.
 *
 * ONE STRING, COMPARED WITH `===`, RATHER THAN A STRUCTURE OF user/thread/org
 * fields. gemi does not have an opinion about tenancy — there is no `Org` in
 * this framework — so a structured scope would have had to be a bag of optional
 * fields, and a bag of optional fields has a worst member: `{}`, which under any
 * partial-match rule matches everything. Every such rule admits `{}` — or
 * `{ userId: undefined }`, which is the same thing arrived at by a typo — so one
 * forgetful line in an app turns the scope check into a no-op that still
 * typechecks. An opaque key has no such member: an app that wants org isolation
 * writes `org:${org.id}` and gets it, and an app that decides a request has no
 * subject returns `null` from `attachmentScope()` and gets no attachment ids at
 * all, rather than a bucket everyone shares.
 *
 * It is an object rather than a bare `string` for one reason, and it is a real
 * one: `find(scope, id)` taking two bare strings is a signature whose arguments
 * can be transposed, and the transposition typechecks, runs, and is a scope
 * check comparing an id against an id. The wrapper makes that a compile error.
 *
 * The key is never shown to the model and never sent to the client. It is a
 * server-side comparison value; it is not a path component and is not parsed.
 */
export type AttachmentScope = { readonly key: string };

/**
 * Where an upload's bytes were sent. See `AgentController.attachmentDestination`.
 *
 * `"provider"` DESCRIBES A RECORD `upload` NEVER WRITES. A file that goes to the
 * provider alone leaves gemi holding nothing to resolve — `read` and `file`
 * would throw for it — so the route answers `fileId` and mints no attachment id
 * at all, and there is no id for anyone to look up its name with. The value is
 * on this type because a store *can* hold such a row (a custom `AttachmentStore`
 * filing provider uploads for its own bookkeeping is a reasonable thing to
 * write, and `ScopedAttachments` handles it correctly), not because the shipped
 * route produces one.
 */
export type AttachmentDestination = "both" | "provider" | "storage";

/**
 * One recorded upload.
 *
 * `fileId` and `objectName` are both optional and at least one is always
 * present, because which of them exists is exactly the destination decision:
 * `provider` has a `fileId` and no bytes of ours, `storage` has bytes and no
 * `fileId`, `both` has both.
 */
export type Attachment = {
  /**
   * gemi's id for the upload — the one a tool takes as an argument, and the only
   * id in this module that may be shown to a model.
   *
   * Prefixed `gemi_att_` so that the mistake everyone makes once — a gemi
   * attachment id put into `FilePart.fileId`, which is a *provider* id — is
   * caught by a sentence to read rather than by whatever the vendor says about
   * a file it has never heard of, mid-conversation. `toResponsesInput` checks
   * for the prefix; the vendor's own answer to a bogus `file_id` has not been
   * measured, and the guard does not depend on it.
   */
  id: string;
  /**
   * The scope this was filed under, carried on the record so `ScopedAttachments`
   * can check it a second time. See `ScopedAttachments.get` for why the second
   * check is not redundant.
   */
  scopeKey: string;
  /** The provider file id, when the file was sent to the provider. */
  fileId?: string;
  /** The storage object name, when the bytes were kept. Feed it to `read`. */
  objectName?: string;
  /** The client's filename, kept so a tool can forward the file under it. */
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  destination: AttachmentDestination;
};

/**
 * Where attachment *records* live. The bytes are in `AttachmentStorage`; this
 * holds the row that says which bytes, whose, and under what id.
 *
 * The default is `MemoryAttachmentStore`, which dies with the process, exactly
 * like `MemoryAgentStore`. An app that wants an attachment to outlive a deploy
 * implements this over a table — `id` primary key, `scope_key` column — and
 * assigns it to `AgentController.attachments`.
 *
 * IF YOU IMPLEMENT THIS, THE ONE THING YOU MUST NOT DO is answer `find` from the
 * id alone. `SELECT * FROM attachments WHERE id = ?` is the leak this module
 * exists to prevent, and it passes every test an app writes about its own
 * uploads, because those uploads are always in scope. It is wrong only for an id
 * that came from somewhere else, which is to say only when it matters. The
 * clause is `WHERE id = ? AND scope_key = ?`.
 */
export interface AttachmentStore {
  /** Records an attachment under `scope`. The caller has already minted the id. */
  put(scope: AttachmentScope, attachment: Attachment): Promise<void>;
  /**
   * The attachment with this id *within this scope*, or `null`.
   *
   * `null` for an id that does not exist and `null` for an id that exists under
   * another scope, and the caller cannot tell which — deliberately. See
   * `AttachmentNotFoundError`.
   */
  find(scope: AttachmentScope, id: string): Promise<Attachment | null>;
}

/**
 * The bytes half: whatever the app's file storage is.
 *
 * Structurally satisfied by the `Storage` facade, which is what
 * `AgentController` defaults to. Declared as an interface of two methods rather
 * than as `typeof Storage` so a test — or an app with a second bucket for user
 * uploads — can pass something else without standing up a container.
 */
export interface AttachmentStorage {
  put(params: PutFileParams | Blob): Promise<string>;
  read(params: ReadFileParams | string): Promise<ReadResult>;
}

/**
 * What both a missing id and someone else's id answer.
 *
 * THE MESSAGE MUST NOT SAY WHICH. "Exists but is not yours" and "does not exist"
 * are two answers to a question the caller is not entitled to ask, and a store
 * that distinguishes them is an oracle: a prompt-injected model that can tell
 * the two apart can walk an id space and report back which ids are live, which
 * is a tenant census delivered through the very tool the injection was aimed at.
 * One error, one wording, one code, for both.
 *
 * A plain `Error` rather than a `RequestBreakerError`: this is thrown inside a
 * tool, where the agent loop turns a throw into a tool result the model reads
 * and can recover from, not inside a route where it would decide a status code.
 */
export class AttachmentNotFoundError extends Error {
  readonly code = "attachment_not_found";
  constructor(public readonly id: string) {
    super(`No attachment ${id}.`);
    this.name = "AttachmentNotFoundError";
  }
}

/** Raised for a scope no caller could have meant. See `assertScope`. */
export class InvalidAttachmentScopeError extends Error {
  readonly code = "invalid_attachment_scope";
  constructor(message: string) {
    super(message);
    this.name = "InvalidAttachmentScopeError";
  }
}

/**
 * Rejects the empty scope.
 *
 * `{ key: "" }` is what an app produces by writing `` `org:${org?.id ?? ""}` ``
 * for a request that has no org, and it is the one value that must never reach a
 * store: it compares equal to itself, so every subject-less upload in the
 * process lands in one shared bucket that every subject-less caller can read out
 * of. That is the global store this module exists not to be, arrived at by a
 * template literal. Failing here is loud, happens on the first request, and
 * names the method to fix.
 */
function assertScope(scope: AttachmentScope): AttachmentScope {
  if (!scope || typeof scope.key !== "string" || scope.key.length === 0) {
    throw new InvalidAttachmentScopeError(
      "An attachment scope needs a non-empty key. Return `null` from `attachmentScope()` for a request that has no subject — an empty key is a bucket every caller shares.",
    );
  }
  return scope;
}

/** The prefix on every gemi attachment id. See `Attachment.id`. */
export const ATTACHMENT_ID_PREFIX = "gemi_att_";

export function newAttachmentId(): string {
  return `${ATTACHMENT_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * The handle a tool is given, and the only attachment API a tool should ever
 * see.
 *
 * IT TAKES NO SCOPE, ON ANY METHOD. That is the whole design, and it is not a
 * convenience: an API where the scope is a parameter is an API where the scope
 * is a parameter someone passes the wrong thing to — and the wrong thing here is
 * whatever the model wrote, because inside a tool body the model's arguments are
 * the variables closest to hand. Handing the tool an object that has already
 * closed over the server's answer leaves nothing to pass. `resolve(id, scope)`
 * was the rejected shape: it is the same code with the mistake still available.
 */
export class ScopedAttachments {
  constructor(
    private readonly store: AttachmentStore,
    private readonly storage: AttachmentStorage,
    private readonly scope: AttachmentScope,
  ) {
    assertScope(scope);
  }

  /**
   * The record for `id`, or `AttachmentNotFoundError`.
   *
   * THE SCOPE IS CHECKED TWICE HERE, and the second check is the one that
   * matters. `store.find` is an app's code — a table lookup somebody wrote, with
   * a `WHERE` clause somebody has to have remembered — and the failure mode of
   * forgetting the scope clause is a query that works perfectly for every upload
   * the app's own tests make. Comparing `record.scopeKey` again is three lines
   * that hold even when that clause is missing, so a careless store finds nothing
   * across scopes instead of leaking.
   *
   * It is not defence against a *malicious* store — an app's store is the app's
   * own code and could return anything. It is defence against the ordinary
   * version of this bug, which is the one that ships.
   */
  async get(id: string): Promise<Attachment> {
    const record = await this.store.find(this.scope, id);
    if (!record || record.scopeKey !== this.scope.key) {
      throw new AttachmentNotFoundError(id);
    }
    return record;
  }

  /**
   * The bytes, streaming, with the metadata `createStreamResponse` wants.
   *
   * Throws `AttachmentNotFoundError` for an attachment that exists but whose
   * bytes were never kept — a `provider`-destination upload. The same error as
   * an unknown id, for the reason on that class: "it is at the vendor and not
   * here" is information about someone else's upload as readily as about your
   * own.
   */
  async read(id: string): Promise<ReadResult> {
    return await this.readRecord(id, await this.get(id));
  }

  /**
   * The bytes for a record already resolved, so `file()` does one lookup rather
   * than two. `store.find` is a `SELECT` in any real store, and the second one
   * was not a second check of anything — same scope, same id, same row.
   *
   * It still takes the id the *caller* asked for, rather than reading
   * `record.id`, so the error stays a function of the caller's own input: an app
   * store that answers with the wrong row must not get to choose which id
   * appears in a message the model may read.
   */
  private async readRecord(id: string, record: Attachment): Promise<ReadResult> {
    if (!record.objectName) {
      throw new AttachmentNotFoundError(id);
    }
    return await this.storage.read({ name: record.objectName });
  }

  /**
   * The bytes as a `File`, under the name and type they were uploaded with —
   * which is the shape the motivating case actually needs, because
   * `form.append("image", file)` is what a tool forwarding an upload to a
   * multipart endpoint writes.
   *
   * Buffers, and says so. `read()` is there for anything large enough that
   * buffering it is the wrong call.
   */
  async file(id: string): Promise<File> {
    const record = await this.get(id);
    const result = await this.readRecord(id, record);
    const body = result.body;
    const blob =
      body instanceof Blob ? body : body ? await new Response(body).blob() : new Blob([]);
    return new File([blob], record.name, { type: record.mimeType });
  }

  /**
   * Stores bytes a tool produced, under this caller's scope, and answers the
   * record.
   *
   * Here rather than on the store because the id, the object name and the scope
   * all have to be decided together, and because an attachment a tool created
   * has to land in the scope the tool is reading from — otherwise a tool writes
   * a file the next tool of the same run cannot see.
   *
   * Nothing is sent to the provider: bytes a tool made are bytes for the app,
   * and a tool that wants the model to look at its output says so by returning
   * something the model can read. Issue #490 builds `ctx.attachments.put(blob)`
   * on exactly this.
   */
  async put(blob: Blob, params: { name?: string; mimeType?: string } = {}): Promise<Attachment> {
    const id = newAttachmentId();
    const mimeType = params.mimeType ?? blob.type ?? "";
    const name = params.name ?? (blob instanceof File ? blob.name : id);
    const objectName = await this.storage.put({
      name: attachmentObjectName(id, name),
      body: blob,
      contentType: mimeType || undefined,
    });
    const record: Attachment = {
      id,
      scopeKey: this.scope.key,
      objectName,
      name,
      mimeType: mimeType || "application/octet-stream",
      size: blob.size,
      createdAt: new Date().toISOString(),
      destination: "storage",
    };
    await this.store.put(this.scope, record);
    return record;
  }
}

/**
 * The object name an attachment's bytes are stored under.
 *
 * The scope is deliberately NOT in the path. A scope key is app-authored text —
 * `org:${slug}`, with whatever a slug turns out to be — and putting arbitrary
 * app text into an object name is how a `..` or a `/` ends up somewhere nobody
 * meant on the one driver that resolves names literally (`FileSystemDriver`
 * concatenates them onto a folder path). The record is what carries the scope;
 * the object name only has to be unique, and a uuid already is.
 *
 * The extension is carried over from the client's filename when it looks like
 * one, because `FileSystemDriver` reads a stored object's content type back off
 * its path and would otherwise answer `application/octet-stream` for everything.
 * `Attachment.mimeType` is the authority either way — this is for anything that
 * reads the bucket without the record.
 */
export function attachmentObjectName(id: string, name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return `attachments/${id}${match ? `.${match[1]!.toLowerCase()}` : ""}`;
}

/**
 * The default: attachment records last as long as the process.
 *
 * Modelled as one flat map keyed by id, holding the scope beside the record and
 * comparing it in `find` — rather than as a map of maps, which would make the
 * scoping structural and unforgettable. That looks like the safer shape and is
 * the wrong reference implementation: an app's store is a table with an `id`
 * primary key and a `scope_key` column, and its `find` is a `WHERE` clause that
 * can be written wrong. The store gemi ships should have the same failure
 * available to it as the store an app writes, so that a test written against
 * this one is a test of the check every real store also has to make.
 */
export class MemoryAttachmentStore implements AttachmentStore {
  private readonly rows = new Map<string, Attachment>();

  async put(scope: AttachmentScope, attachment: Attachment): Promise<void> {
    assertScope(scope);
    this.rows.set(attachment.id, { ...attachment, scopeKey: scope.key });
  }

  async find(scope: AttachmentScope, id: string): Promise<Attachment | null> {
    assertScope(scope);
    const row = this.rows.get(id);
    // The scope clause. An id belonging to another scope answers `null`, which
    // is the answer an id that does not exist gets — see
    // `AttachmentNotFoundError` for why the two must be indistinguishable.
    if (!row || row.scopeKey !== scope.key) {
      return null;
    }
    return row;
  }

  /** Test and dev affordance: how many rows are held, across every scope. */
  get size(): number {
    return this.rows.size;
  }
}

/**
 * The process-wide default, so an app that configures nothing still gets
 * attachment ids that work for the length of a conversation.
 *
 * Module-level for the reason `defaultAgentStore` is: the controller is
 * constructed per request, so a store assigned as `new MemoryAttachmentStore()`
 * in a field initializer is an empty store on every request, and every
 * attachment id is a miss one turn after it was minted.
 */
export const defaultAttachmentStore = new MemoryAttachmentStore();
