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
  async put(
    blob: Blob,
    params: { name?: string; mimeType?: string; fileId?: string } = {},
  ): Promise<Attachment> {
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
      // `both` when the caller has already sent the same bytes to the provider,
      // which is what `ctx.attachments.put(blob, { showModel: true })` does
      // before it gets here.
      //
      // The parameter exists rather than a second `markShown` call because the
      // alternative is a row that is briefly, and then permanently if the second
      // write fails, a lie: `destination` is the field that says where the bytes
      // went, and a file sitting in the vendor's file list under a record that
      // says `storage` is exactly the discrepancy the field was added to close.
      // Nothing here uploads — the provider is the run's, not this module's —
      // so the id is passed in rather than produced.
      destination: params.fileId ? "both" : "storage",
      ...(params.fileId ? { fileId: params.fileId } : {}),
    };
    await this.store.put(this.scope, record);
    return record;
  }
}

/**
 * What a tool asks for when it parks bytes.
 *
 * `showModel` is the whole of issue #490 in one flag: without it a tool's
 * output is an id in a string, which the model can quote back and cannot look
 * at, so "edit this image" produces a file nobody but the app ever sees. With
 * it the same bytes also go to the provider and come back into the transcript
 * as an input-role message the next step is built on — generate, look, fix.
 *
 * It is a flag rather than the default because the default costs money on every
 * call. The reasoning is `capabilitiesForModel`'s, run the other way round: a
 * file the model did not need and was shown anyway is an upload plus a set of
 * image tokens on every subsequent request of the run, on an invoice, for a
 * tool whose author never asked to be looked at. A file the model needed and
 * was not shown is a tool that returned an id, which is what tools did before
 * this existed and is visible in the transcript the moment anyone reads it. The
 * expensive mistake is the silent one here, so the expensive thing is opt in.
 */
export type PutAttachmentParams = {
  /** The filename to keep, so a later `file()` hands the bytes back under it. */
  name?: string;
  /** Overrides `blob.type`, which a `Blob` built from raw bytes does not have. */
  mimeType?: string;
  /**
   * Also send these bytes to the model provider and put them in front of the
   * model as an input-role message, once this tool call settles.
   *
   * Refused, loudly, by a provider whose `capabilities.fileInput` is false: the
   * request builder drops a file part such a provider cannot read, and an
   * upload paid for, stored, and then dropped on the way to the wire is the
   * silent-forever failure — the tool reports success, the model answers about
   * an image it was never shown, and nothing anywhere says why.
   */
  showModel?: boolean;
};

/**
 * The attachment API a tool is given, as `ctx.attachments`.
 *
 * Everything a `ScopedAttachments` does, plus `showModel`, plus the memo that
 * makes a re-entered tool call idempotent. It is a separate interface from
 * `ScopedAttachments` because those two additions are not properties of the
 * scope, they are properties of *one tool call*: the run has to know which call
 * a `put` belongs to in order to replay it, and the object handed to a tool is
 * therefore built per call — the same shape `ctx.runAgent` has, for the same
 * reason.
 *
 * The read half (`get`, `read`, `file`) is delegated to the `ScopedAttachments`
 * unchanged, including its two scope checks. A tool reading a file it did not
 * create is reading an id the model wrote, and #489's whole argument applies to
 * it word for word.
 */
export interface ToolAttachments {
  /**
   * Parks bytes under this caller's scope and answers the record.
   *
   * ON A REPLAY THIS STORES NOTHING. An escalating tool is re-entered from the
   * top on the next turn, so the body that built this blob has run before and
   * built one already; the record from that first attempt is what comes back,
   * and the bytes handed in now are dropped. That is the same bargain
   * `ctx.runAgent` makes and it is not avoidable: the id from the first attempt
   * is already in the transcript the model read, so minting a second one would
   * leave the model holding an id for bytes nobody kept — and uploading the
   * second copy would pay the vendor twice and put the same image into the
   * context twice. Work *before* a `put` still runs again; if producing the
   * bytes is what costs, branch on `ctx.resumed`.
   */
  put(blob: Blob, params?: PutAttachmentParams): Promise<Attachment>;
  /** The record for `id`, or `AttachmentNotFoundError`. Scoped. */
  get(id: string): Promise<Attachment>;
  /** The bytes, streaming. Scoped. */
  read(id: string): Promise<ReadResult>;
  /** The bytes as a `File`, under their original name and type. Scoped. */
  file(id: string): Promise<File>;
}

/**
 * One `ctx.attachments.put` of one tool call, written down so the next turn can
 * replay it instead of doing it again.
 *
 * Lives on `ToolCallPart.attachments`, indexed by the order the puts happened
 * in — exactly where and how `ToolCallPart.nested` records sub-runs, and for
 * exactly the same reason: the message history is the only state that survives
 * a turn boundary, in a thread and in the browser both, so a memo that is not
 * on the message is a memo a stateless app does not have.
 *
 * `shown` is absent for a plain `put`. When present it carries the provider
 * file id AND the identity of the message injected for it, because both have to
 * come back byte for byte: a replay that minted a fresh message id would put a
 * second copy of the same image in the transcript, and a client that had
 * already applied the first would show it twice.
 */
export type ToolAttachmentRecord = {
  /** What `put` answered, replayed verbatim. */
  attachment: Attachment;
  /** Set when `showModel` was asked for. See above. */
  shown?: {
    /** The provider's file id — what the injected `FilePart` carries. */
    fileId: string;
    /** The injected message's id, so a replay reproduces it rather than a twin. */
    messageId: string;
    /** Its `createdAt`, for the same reason. */
    createdAt: string;
  };
};

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
