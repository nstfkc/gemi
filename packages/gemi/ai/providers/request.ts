import type {
  ProviderCapabilities,
  ProviderStreamParams,
  ProviderToolNamespace,
  ProviderToolSpec,
} from "../AgentProvider";
import { ATTACHMENT_ID_PREFIX } from "../store/Attachments";
import type { AgentMessage, FilePart, ToolResultPart } from "../types";

/**
 * Building the request body is a pure function, on purpose.
 *
 * Everything hard about this provider is in here — item ordering, tool-call
 * pairing, what a denied call looks like on the wire — and none of it needs a
 * socket to be wrong. So it is separated from the class that posts it, and the
 * tests assert the object rather than mocking `fetch` and reading a string.
 */

// The wire shapes, typed loosely on purpose: these mirror OpenAI's schema, and
// a precise mirror is a second thing to keep in sync for no checking we would
// actually get — the API is the authority and it answers in HTTP.
export type ResponsesInputItem = Record<string, unknown>;
export type ResponsesTool = Record<string, unknown>;

export type ResponsesRequest = {
  model: string;
  input: ResponsesInputItem[];
  stream: true;
  instructions?: string;
  tools?: ResponsesTool[];
  parallel_tool_calls?: boolean;
  text?: { format: Record<string, unknown> };
  reasoning?: { effort: string; summary: "auto" };
  temperature?: number;
  max_output_tokens?: number;
};

export function buildResponsesRequest(
  params: ProviderStreamParams,
  ctx: { model: string; capabilities: ProviderCapabilities },
): ResponsesRequest {
  const { capabilities } = ctx;

  const body: ResponsesRequest = {
    model: ctx.model,
    input: toResponsesInput(params.messages, capabilities),
    stream: true,
  };

  if (params.systemPrompt) body.instructions = params.systemPrompt;

  const tools = toResponsesTools(params.tools, capabilities);
  if (tools.length > 0) {
    body.tools = tools;
    if (!capabilities.parallelToolCalls) body.parallel_tool_calls = false;
  }

  // Deliberately NOT gated on `capabilities.structuredOutput`. An agent that
  // declares `output` has a typed result its app is going to read, and dropping
  // the parameter does not degrade that gracefully — it produces prose, which
  // arrives as `text-delta`, so the app sees no output part, no error and
  // nothing to branch on. That is the silent-forever failure `capabilities.ts`
  // argues against: send it and let the API answer 400, which is loud, happens
  // once, and names the parameter it disliked. `reasoning` is dropped below
  // because it is an optimization; an output schema is the answer's shape.
  if (params.output) {
    body.text = {
      format: {
        type: "json_schema",
        name: params.output.name,
        schema: params.output.schema,
        strict: params.output.strict,
      },
    };
  }

  // Dropped rather than refused: a model that cannot reason should still answer
  // an agent that asked it to, because `reasoning` is the agent's preference
  // and the provider is where preferences meet reality.
  if (params.reasoning && capabilities.reasoning) {
    // `summary: "auto"` is not decoration — without it the stream carries no
    // reasoning text at all, and `ReasoningPart` would have nothing to hold.
    body.reasoning = { effort: params.reasoning, summary: "auto" };
  }

  if (typeof params.temperature === "number") body.temperature = params.temperature;
  if (typeof params.maxOutputTokens === "number") body.max_output_tokens = params.maxOutputTokens;

  return body;
}

// --- messages ------------------------------------------------------------

/**
 * `AgentMessage[]` to Responses input items.
 *
 * Order is preserved *within* a message, not just between messages: a message
 * that holds reasoning, then a tool call, then its result has to arrive in that
 * order, because the API validates the pairing positionally. So text and file
 * parts are buffered into one message item and that buffer is flushed the
 * moment a non-message item appears, rather than emitting all the text first
 * and all the calls after.
 */
export function toResponsesInput(
  messages: AgentMessage[],
  capabilities: ProviderCapabilities,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];

  for (const message of messages) {
    const role = message.role;
    let buffer: Record<string, unknown>[] = [];

    const flush = () => {
      if (buffer.length === 0) return;
      items.push({ type: "message", role, content: buffer });
      buffer = [];
    };

    for (const part of message.content ?? []) {
      switch (part.type) {
        case "text": {
          if (!part.text) break;
          buffer.push(textContent(role, part.text));
          break;
        }
        case "output": {
          // A structured answer is still the assistant's text as far as the
          // history is concerned; re-serializing it is what lets a follow-up
          // turn refer to what was decided.
          if (part.partial) break;
          buffer.push(textContent(role, JSON.stringify(part.value)));
          break;
        }
        case "file": {
          // Neither `input_file` nor `input_image` is legal on an output role.
          // An assistant message holding a file is a bug upstream, and sending
          // it anyway turns that bug into a 400 halfway through a conversation.
          // The attachment line goes with it: `output_text` saying "here is a
          // file" on the assistant's side would be the model told it produced
          // something it did not.
          if (role === "assistant") break;
          const attachmentId = attachmentIdOf(part);
          // A model that cannot read files still gets the line. The file is
          // gemi's either way, and a tool can take it by id even though the
          // model cannot look at it — dropping the line too would leave the
          // model unaware the user attached anything, which is the storage-only
          // failure this line exists to fix.
          if (!capabilities.fileInput) {
            if (attachmentId) buffer.push(textContent(role, attachmentLine(part, false)));
            break;
          }
          // NOT A PROVIDER FILE ID. There are two ids now — `POST /chat/files`
          // answers `fileId` (the provider's) and `attachmentId` (ours) — and
          // putting the wrong one here is the mistake the shapes invite. Left
          // alone it is an error from the vendor about a file it has never heard
          // of, arriving mid-conversation and naming nothing a reader can act
          // on. (Which error is NOT MEASURED: no request was made with a bogus
          // `file_id` to find out whether it is a 400 or a 404, or whether the
          // part is dropped and the rest of the turn proceeds. The guard does
          // not depend on the answer — it is worth having on the shapes alone —
          // so this comment names the failure rather than a status code nobody
          // checked.)
          if (part.fileId?.startsWith(ATTACHMENT_ID_PREFIX)) {
            throw new Error(
              `FilePart.fileId holds a gemi attachment id (${part.fileId}). That field is the *provider's* file id, from \`fileId\` on the upload response; the \`attachmentId\` goes in \`FilePart.attachmentId\`, is shown to the model as text, and is resolved by a tool through \`ctx.attachments\`.`,
            );
          }
          // A storage-only upload has no provider id, and that is a legal part
          // now: the model is told the file exists and is not shown it. What
          // is still refused is a part with NEITHER id — nothing to show and
          // nothing to name. The emptiness check is `!part.fileId` rather than
          // a prefix test because `undefined?.startsWith` is `undefined`, and
          // `file_id: undefined` reaches the vendor as surely as a wrong string.
          if (!part.fileId && !attachmentId) {
            throw new Error(
              "FilePart.fileId is empty and there is no `attachmentId` either. `fileId` is the *provider's* file id and `attachmentId` is gemi's (`gemi_att_…`), both from the upload response; an upload always answers at least one, so a part with neither was built from something other than that answer.",
            );
          }
          if (attachmentId) buffer.push(textContent(role, attachmentLine(part, !!part.fileId)));
          if (part.fileId) buffer.push(fileContent(part));
          break;
        }
        case "reasoning": {
          flush();
          const item = reasoningItem(part);
          if (item) items.push(item);
          break;
        }
        case "tool-call": {
          // A partial call is UI state — the arguments were still streaming
          // when this was written down, so what it holds is not what the model
          // asked for. Sending it would create the dangling call the API
          // rejects. If it did acquire a result (a stop landing mid-arguments
          // does exactly that), `reconcileToolPairs` drops that half too.
          if (part.partial) break;
          flush();
          items.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: String(part.name),
            arguments: JSON.stringify(part.input ?? {}),
          });
          break;
        }
        case "tool-result": {
          flush();
          items.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: toolResultOutput(part),
          });
          break;
        }
      }
    }

    flush();
  }

  return reconcileToolPairs(items);
}

/** What is sent for a call whose result never made it into the history. */
const NO_RESULT_RECORDED = "No result was recorded for this tool call. Assume it did not complete.";

/**
 * Every `function_call` has exactly one `function_call_output`, and no output
 * stands alone.
 *
 * The loop above skips a `tool-call` marked `partial` — its arguments were
 * still streaming, so it is UI state rather than something the model did — but
 * a partial call can still acquire a result: `stop()` gives every call in
 * flight a `denied`/`stopped` result, and a call whose arguments were mid-flight
 * is exactly the one carrying `partial`. Emitting that result on its own is a
 * 400 ("no tool call found for function call output"), and because the history
 * is persisted it is a 400 on every subsequent turn — the thread is bricked,
 * which is the failure `denied` exists to prevent.
 *
 * So the invariant is enforced here rather than assumed part-by-part: an
 * unpartnered output is dropped, a repeated one is dropped, and a call left
 * dangling by a crash between the call and its result gets a synthetic output
 * saying so. Fabricating that line is the lesser evil — it is true, the model
 * can read it, and the alternative is a conversation that can never be
 * continued.
 *
 * A repeated *call* is dropped for the same reason in the other direction. The
 * API happens to accept two `function_call`s under one id, so this is not a
 * 400 — it is the model reading the same call twice, on every turn, for the
 * rest of the conversation. The way it arises is a store that appended the
 * amended copy of a message instead of replacing it; the store contract now
 * says upsert, and this is the guard for a store that did not read it.
 */
function reconcileToolPairs(items: ResponsesInputItem[]): ResponsesInputItem[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  const kept: ResponsesInputItem[] = [];

  for (const item of items) {
    if (item.type === "function_call") {
      const callId = String(item.call_id);
      if (called.has(callId)) continue;
      called.add(callId);
    } else if (item.type === "function_call_output") {
      const callId = String(item.call_id);
      // Positional: the output has to come *after* its call, which is what the
      // API checks, so a call seen later in the history does not rescue it.
      if (!called.has(callId) || answered.has(callId)) continue;
      answered.add(callId);
    }
    kept.push(item);
  }

  if (answered.size === called.size) return kept;

  const out: ResponsesInputItem[] = [];
  for (const item of kept) {
    out.push(item);
    if (item.type !== "function_call") continue;
    const callId = String(item.call_id);
    if (answered.has(callId)) continue;
    answered.add(callId);
    out.push({ type: "function_call_output", call_id: callId, output: NO_RESULT_RECORDED });
  }
  return out;
}

function textContent(role: AgentMessage["role"], text: string): Record<string, unknown> {
  return { type: role === "assistant" ? "output_text" : "input_text", text };
}

/**
 * `FilePart.attachmentId`, if it is one.
 *
 * In stateless mode the history arrives from the browser and only the turn
 * itself is checked at the door (`toClientTurn`), so a part posted back as
 * history can hold anything here. A value that is not a gemi id is treated as
 * absent rather than refused: it names nothing a tool could resolve, and
 * refusing it would fail every later turn of a conversation over a field the
 * model could not have used.
 */
function attachmentIdOf(part: FilePart): string | undefined {
  const id = part.attachmentId;
  return typeof id === "string" && id.startsWith(ATTACHMENT_ID_PREFIX) ? id : undefined;
}

/**
 * The line that tells the model an attachment's id, sent just before the file
 * block it labels (or alone, when there is no file block to send).
 *
 * WHY A LINE AT ALL. A model that has seen a user's image has no id to put in
 * a tool's arguments unless it is told one. Whatever it writes there instead
 * is answered by `ctx.attachments.file()` with `AttachmentNotFoundError` —
 * correctly, for an id that was never obtainable. For a storage-only upload
 * this line is all the model gets: without it, it does not know a file exists.
 *
 * WHY THIS FORMAT. `[attachment id="…" name="…" mimeType="…"]`, each value
 * JSON-quoted. The filename is the user's and can hold spaces, quotes, `]` or
 * a newline; JSON quoting means none of them can end a field, end the bracket,
 * or start a second line that reads as another attachment, so the id a model
 * copies out is exactly the id. The unquoted form (`[attachment gemi_att_… my
 * photo.png image/png]`) looks tidier and is ambiguous as soon as a name has a
 * space. A key with no value is left out rather than written as `name=""`.
 *
 * WHY IT SAYS WHEN THE FILE IS NOT SHOWN. A storage-only upload, or any file
 * sent to a model without `fileInput`, has no block beside the line. Left
 * unsaid, a line that names `photo.png` invites the model to describe a
 * picture it never saw.
 */
function attachmentLine(part: FilePart, shown: boolean): string {
  const fields = [`id=${JSON.stringify(part.attachmentId)}`];
  if (part.name) fields.push(`name=${JSON.stringify(part.name)}`);
  if (part.mimeType) fields.push(`mimeType=${JSON.stringify(part.mimeType)}`);
  const line = `attachment ${fields.join(" ")}`;
  return shown
    ? `[${line}]`
    : `[${line} — its contents are not shown to you; a tool can read the file by this id]`;
}

/**
 * An attachment onto the content block that can carry it.
 *
 * `input_file` is the document path and `input_image` is the vision one, and
 * they are not interchangeable in either direction — the API refuses the wrong
 * pairing with a 400 rather than degrading. So this branch is not a nicety
 * about how well an image is read; it decides whether the turn happens at all.
 * What was measured, on which models, with the verbatim rejections, is recorded
 * above `IMAGE_EXTENSIONS`.
 *
 * `file_id` is the same field on both blocks, so nothing about the upload
 * changes: `uploadFile` posts once with `purpose: "user_data"` and the id it
 * returns is legal in either. `detail` is deliberately not sent on the image
 * block — it is optional, the API defaults it, and a `FilePart` carries no
 * signal that would justify choosing anything but that default.
 *
 * SVG is the case the `image/` prefix gets wrong. `image/svg+xml` is an image
 * MIME type, and .svg is on the API's *document* list and off its image list —
 * so a prefix test alone sends it to the one block that is guaranteed to refuse
 * it. It is routed by what the API calls it, not by what the MIME type calls
 * it.
 *
 * WHEN `mimeType` IS ABSENT OR EMPTY the file name decides, and if that settles
 * nothing the part is sent as `input_file`. Both halves matter.
 *
 * The name branch is NOT a rescue for un-typed legacy rows, and deleting it as
 * one would break a live upload. The browser path has always written the field:
 * `useChat.uploadFile` has stored `data.mimeType ?? file.type` since the module
 * landed (`git log -S mimeType -- ai/useChat.tsx` bottoms out at d940676e), so
 * there is no history of `undefined` MIME types to point at, and a backfill
 * would not make this branch dead. What it is actually for is the two cases
 * that still leave nothing to read. `File.type` is the EMPTY STRING, not
 * absent, for a file the browser cannot type — so `?? file.type` stores `""`
 * and this branch fires on a perfectly current upload — and a `FilePart`
 * assembled by a server-side caller may set neither field, because the type
 * marks both optional.
 *
 * The name is also the right thing to fall back to rather than merely the last
 * thing left: the server classifies by the STORED FILE NAME'S EXTENSION, not by
 * the bytes and not by the upload's `Content-Type` (measured; the transcript is
 * below). And what it rescues is not a cosmetic degradation — an image part
 * that lands on `input_file` 400s, and because that part lives in stored
 * history and goes back up on every request, it 400s every remaining turn of
 * the thread. `useChat.uploadFile` fills `name` from the local `File` and the
 * file is uploaded under that same name, so such a part almost always still
 * says `.png`.
 *
 * Falling back to `input_file` past that is the conservative half — a part with
 * neither a MIME type nor a usable name is much more likely to be the document
 * it has always been sent as than an image, and this way a nameless document
 * keeps working instead of being newly broken to rescue a nameless image.
 *
 * PRECEDENCE, since two orderings are otherwise indistinguishable: the MIME
 * type classifies and the name is consulted only when there is none. A stated
 * type is a stated fact and a name is a convention, so a `.pdf` named
 * `image/png` goes to the image block. `request.test.ts` pins this with a case
 * where the two disagree, because a name-first `fileContent` passes every case
 * where they agree.
 */
function fileContent(part: FilePart): Record<string, unknown> {
  const mimeType = part.mimeType?.trim().toLowerCase() ?? "";
  // `""` rather than `undefined` is the shape to expect from a browser that
  // could not type the file: `useChat.uploadFile` writes `data.mimeType ??
  // file.type`, and `File.type` is the empty string, not absent. Both land on
  // the name.
  const isImage = mimeType
    ? mimeType.startsWith("image/") && mimeType !== "image/svg+xml"
    : hasImageExtension(part.name);
  return { type: isImage ? "input_image" : "input_file", file_id: part.fileId };
}

function hasImageExtension(name: string | undefined): boolean {
  const match = /\.([a-z0-9]+)$/.exec(name?.trim().toLowerCase() ?? "");
  return match?.[1] !== undefined && IMAGE_EXTENSIONS.has(match[1]);
}

/**
 * Which block takes what, and whether the wrong one merely reads badly.
 *
 * MEASURED, not read off the API reference. Three attachments were uploaded to
 * `https://api.openai.com/v1/files` with `purpose: "user_data"` — a 64x64 PNG
 * of four solid quadrants (red, green, blue, yellow), a one-page PDF whose only
 * word is BANANA, and a 64x64 SVG — and each was then sent to
 * `https://api.openai.com/v1/responses` in both content blocks:
 *
 *   PNG as `{type:"input_image", file_id}`  — 200. Asked which quadrant was
 *     red, gpt-5.4 answered `"top-left"` and gpt-4o `"The red quadrant is the
 *     top-left."` Both correct. SO AN UPLOADED IMAGE IS REAL VISION INPUT, and
 *     `file_id` is all `input_image` needs; sending `detail:"auto"` alongside
 *     it changed nothing, so it is left off.
 *   PNG as `{type:"input_file", file_id}`   — 400, verbatim: `Invalid input:
 *     Expected context stuffing file type to be a supported format: .art, .bat,
 *     … .pdf, … .svg, … .yml but got .png.` (~90 extensions, elided.) This is
 *     the finding that mattered: what gemi shipped was not "an image the model
 *     reads poorly", it was a request that never ran.
 *   PDF as `{type:"input_file", file_id}`   — 200, `"BANANA"` on gpt-5.4 and
 *     gpt-4o both.
 *   PDF as `{type:"input_image", file_id}`  — 400, verbatim: `Invalid input:
 *     Expected image type to be a supported format: .jpeg, .jpg, .png, .gif,
 *     .webp but got .pdf.` So the refusal is symmetric: neither block tolerates
 *     the other's content.
 *   SVG as `{type:"input_image", file_id}`  — 400, `… but got .svg.`
 *   SVG as `{type:"input_file", file_id}`   — 400, but a different one:
 *     `You uploaded an invalid file. Please try again with a different file`,
 *     with no format list. .svg is on the document list and off the image one,
 *     so routing accepted it and the pipeline behind it did not. An SVG fails
 *     both ways today; it is sent as `input_file` because that is where the API
 *     says it belongs, which is the only branch that can start working without
 *     another change here.
 *
 * AND THE DISCRIMINATOR IS THE FILE NAME, NOT THE BYTES AND NOT THE UPLOAD'S
 * `Content-Type`. The same PNG bytes uploaded under the name `quadrants.txt`
 * with `type: "text/plain"` were refused as `input_image` with `… but got
 * .txt.`, and as `input_file` with `The file you uploaded is badly formatted or
 * corrupted. Please fix the file and try again.` (code `invalid_file`) — routed
 * by the extension, then failed on the bytes. That is why the name is what a
 * part with no `mimeType` falls back to: it is what the server will judge by.
 *
 * The extensions below are transcribed from the image rejection above.
 *
 * A closed list is right *here* and wrong one line up. This set is only
 * consulted when there is no MIME type to read, which is a guess either way, so
 * it guesses the conservative direction: a format the API adds later goes on
 * being sent as `input_file`, exactly as it is today. The MIME branch stays
 * open (`image/` prefix) for the opposite reason — a declared `image/avif`
 * belongs in the image block the moment the API takes one, and being wrong
 * there is a 400 that names the format, which is loud and fixes itself.
 */
const IMAGE_EXTENSIONS = new Set(["jpeg", "jpg", "png", "gif", "webp"]);

/**
 * Reasoning goes back exactly as it came.
 *
 * Reshaping it — flattening the summary into text, renaming the item, dropping
 * the id — costs two things that are hard to see and expensive to have lost:
 * the prompt cache, which keys on the literal item, and on a reasoning model
 * the thread of the model's own argument across turns.
 *
 * An item with no id is dropped instead. The id is the API's handle on stored
 * reasoning, and an item without one is not a reasoning item the API can
 * resolve — sending a summary under a fabricated id would be worse than
 * sending nothing, because it would look like continuity that is not there.
 */
function reasoningItem(part: { id?: string; text?: string }): ResponsesInputItem | null {
  if (!part.id) return null;
  const item: ResponsesInputItem = { type: "reasoning", id: part.id };
  item.summary = part.text ? [{ type: "summary_text", text: part.text }] : [];
  return item;
}

/**
 * Every tool call gets an output, including the ones that never ran.
 *
 * The API rejects a history containing a `function_call` with no matching
 * `function_call_output`, so a denial cannot be expressed by omission — and a
 * conversation where the user said no has to stay continuable, which is the
 * whole reason `denied` exists in the first place.
 *
 * What is sent is prose rather than a status enum, because the reader is a
 * language model: it has to be able to tell "the user refused this" from "this
 * blew up", and those two lead to genuinely different next moves — apologize
 * and ask, versus try another way.
 *
 * STILL A STRING, AFTER #490, AND THAT IS THE DESIGN. A tool that produces a
 * file the model has to look at does not put it here: the run appends an
 * input-role message carrying a `FilePart` after the call settles, which is the
 * `input_file` shape a user's own upload already takes and which the branch
 * above already builds every day.
 *
 * The alternative was a `function_call_output` whose `output` is a content
 * array with an image block in it, and it was not chosen because NOBODY HAS
 * MEASURED WHETHER THE API ACCEPTS ONE. No request was made with an image block
 * in a `function_call_output`, so whether it is taken, ignored, or a 400 is
 * unknown, and the one thing that is certain is that finding out costs a
 * conversation each time it is wrong — a rejected history is rejected on every
 * subsequent turn, not just the one that built it. Going through a route that
 * is exercised on every vision request costs nothing to be sure of. If someone
 * does measure it and it works, the tool result becomes the tidier home for a
 * file and this comment is the place to say so.
 */
export function toolResultOutput(part: ToolResultPart): string {
  if (part.status === "ok") {
    return typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? null);
  }

  if (part.status === "denied") {
    const reason = part.reason ? ` Reason given: ${part.reason}` : "";
    if (part.cause === "stopped") {
      return `The run was stopped before this tool call could complete, so it did not run.${reason}`;
    }
    return `The user declined this tool call, so it did not run.${reason}`;
  }

  return `The tool call failed and produced no result. Error (${part.error?.code ?? "unknown"}): ${
    part.error?.message ?? "no message"
  }`;
}

// --- tools ---------------------------------------------------------------

function isNamespace(
  entry: ProviderToolSpec | ProviderToolNamespace,
): entry is ProviderToolNamespace {
  return Array.isArray((entry as ProviderToolNamespace).tools);
}

/**
 * Tools and namespaces onto the Responses `tools` array.
 *
 * Without tool search the grouping has nothing to do — a namespace exists to be
 * searched — so it is flattened away and every schema is sent inline with
 * `deferred` ignored. That is the promise `capabilities.toolSearch` makes:
 * deferral is a token optimization, and an optimization that changed which
 * tools the model can reach would not be one.
 */
export function toResponsesTools(
  tools: (ProviderToolSpec | ProviderToolNamespace)[] | undefined,
  capabilities: ProviderCapabilities,
): ResponsesTool[] {
  if (!tools || tools.length === 0) return [];

  if (!capabilities.toolSearch) {
    const flat: ResponsesTool[] = [];
    for (const entry of tools) {
      if (isNamespace(entry)) {
        for (const tool of entry.tools) flat.push(functionTool(tool, false));
      } else {
        flat.push(functionTool(entry, false));
      }
    }
    return flat;
  }

  const out: ResponsesTool[] = [];
  let anyDeferred = false;

  for (const entry of tools) {
    if (isNamespace(entry)) {
      const inner = entry.tools.map((tool) => {
        if (tool.deferred) anyDeferred = true;
        return functionTool(tool, true);
      });
      out.push({
        type: "namespace",
        name: entry.name,
        description: entry.description,
        tools: inner,
      });
    } else {
      if (entry.deferred) anyDeferred = true;
      out.push(functionTool(entry, true));
    }
  }

  // Without this the deferred schemas are unreachable: the model is shown a
  // name and a description and given no way to ask for the rest, which is worse
  // than not deferring at all. Added only when something is actually deferred,
  // so an agent that defers nothing does not pay for a tool it cannot use.
  if (anyDeferred) out.push({ type: "tool_search" });

  return out;
}

function functionTool(tool: ProviderToolSpec, allowDeferred: boolean): ResponsesTool {
  const spec: ResponsesTool = {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
  };
  if (allowDeferred && tool.deferred) spec.defer_loading = true;
  return spec;
}
