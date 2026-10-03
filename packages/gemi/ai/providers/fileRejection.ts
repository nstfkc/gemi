import type { AgentMessage } from "../types";
import { ProviderHttpError } from "./errors";
import type { ResponsesInputItem, ResponsesRequest } from "./request";

/**
 * A stored file the provider will not read, and what to do about it (#684).
 *
 * THE FAILURE. A `FilePart` lives in the thread's history and goes back up on
 * every request. If the provider refuses its `file_id` — an id from the wrong
 * upload purpose, a file that was deleted or expired, a resource that no longer
 * owns it — the turn that added it fails with a 400, and so does every turn
 * after it, because the history that holds the part is the history every turn
 * sends. The user's only way out was a new thread.
 *
 * THE FIX. When a 400 names a file block of the request, that block is swapped
 * for a line of text saying the attachment could not be read, and the request
 * is sent again. The model is told, so it can tell the user rather than answer
 * as though it had read the file. `Agent` is told too (a `file-rejected`
 * provider event), and marks the stored part `providerRejected` so later turns
 * send the note instead of the id and do not pay for a failed request first.
 *
 * WHAT A REFUSAL LOOKS LIKE, MEASURED against a live Azure resource (gpt-6-sol,
 * `/openai/v1`, `api-version=preview`, 2026-10-01). Each body is recorded in
 * `__fixtures__` and the tests read those files:
 *
 *   A `user_data` id (`azure-error-file-id-prefix.json`): `param` points at the
 *     block, `input[2].content[1].file_id`, and the message says `Expected an
 *     ID that begins with 'assistant'`. With TWO such ids in one request only
 *     the first is named, which is why more than one retry is allowed below.
 *   An id that does not exist, or a file that was deleted
 *     (`azure-error-files-not-found.json`, `azure-error-file-deleted.json`):
 *     `param: null`, and the message lists every missing id at once —
 *     `Files [assistant-…, assistant-…] were not found due to ownership
 *     verification failure.` So the ids are read out of the message, by
 *     matching the ids the request actually sent rather than by parsing the
 *     sentence, which also covers OpenAI's wording without having measured it.
 *   The right id in the wrong block (`azure-error-file-type.json`): `param:
 *     "input"` and `… but got .png.`, naming neither the block nor the id. The
 *     block is found by the extension and the block type the message names,
 *     and only when that settles on exactly one file: guessing between two
 *     would hide a file that was fine.
 *
 * Anything else is left alone and fails the turn as it did before. In
 * particular a refusal that names no file in this request is not retried: a
 * retry is only worth sending when something about the request has changed.
 */

/** What the request builder knew about each file id it sent, for the note. */
export type SentFile = { name?: string; mimeType?: string };

/**
 * How many times one call may be re-sent for a rejected file. Each retry has to
 * take out a file the previous ones did not, so this bounds requests, not
 * files: Azure names one bad block per 400 (`param` holds a single path), and
 * a thread that picked up several `user_data` ids before #682 would otherwise
 * clear one per turn and fail every turn until it ran out.
 */
export const MAX_FILE_REJECTION_RETRIES = 3;

/** The file ids in a history, with the name each was attached under. */
export function sentFiles(messages: AgentMessage[]): Map<string, SentFile> {
  const files = new Map<string, SentFile>();
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "file" || !part.fileId || files.has(part.fileId)) continue;
      files.set(part.fileId, { name: part.name, mimeType: part.mimeType });
    }
  }
  return files;
}

/**
 * The file ids a provider error blames, among the ones `body` sent.
 *
 * Empty when the error is not a 400/404 from the API, or names nothing in this
 * request — which is the signal not to retry.
 */
export function rejectedFileIds(
  body: ResponsesRequest,
  error: unknown,
  files: Map<string, SentFile> = new Map(),
): string[] {
  if (!(error instanceof ProviderHttpError)) return [];
  if (error.status !== 400 && error.status !== 404) return [];
  const detail = errorDetail(error.body);
  if (!detail) return [];

  const blocks = fileBlocks(body.input);
  if (blocks.length === 0) return [];

  // 1. The block, by its path. The most precise answer there is.
  const path = /^input\[(\d+)\]\.content\[(\d+)\]\.file_id$/.exec(detail.param ?? "");
  if (path) {
    const item = body.input[Number(path[1])];
    const block = contentOf(item)[Number(path[2])];
    const id = block && typeof block.file_id === "string" ? block.file_id : undefined;
    if (id) return [id];
  }

  // 2. The ids, by name. Matched against what was sent, so a message that
  // mentions an id this request never held cannot blame one that it did.
  const message = detail.message ?? "";
  const named = unique(blocks.map((block) => block.fileId).filter((id) => mentions(message, id)));
  if (named.length > 0) return named;

  // 3. The wrong block for the file's type. No id and no path, so it has to be
  // worked out, and it is only worth doing when the answer is unambiguous.
  const wrongType =
    /Expected (image type|context stuffing file type) to be a supported format:.*but got \.([a-z0-9]+)\.?\s*$/is.exec(
      message,
    );
  if (wrongType) {
    const blockType = wrongType[1]!.toLowerCase() === "image type" ? "input_image" : "input_file";
    const extension = wrongType[2]!.toLowerCase();
    const candidates = unique(
      blocks.filter((block) => block.type === blockType).map((block) => block.fileId),
    );
    const byName = candidates.filter((id) =>
      (files.get(id)?.name ?? "").trim().toLowerCase().endsWith(`.${extension}`),
    );
    if (byName.length === 1) return byName;
    if (byName.length === 0 && candidates.length === 1) return candidates;
  }

  return [];
}

/**
 * `body` with every block holding one of `fileIds` replaced by a note.
 *
 * A copy: the caller's body is what was sent, and the next attempt is a
 * different request.
 */
export function withoutFiles(
  body: ResponsesRequest,
  fileIds: Set<string>,
  files: Map<string, SentFile> = new Map(),
): ResponsesRequest {
  return {
    ...body,
    input: body.input.map((item) => {
      const content = contentOf(item);
      if (!content.some((block) => isRejected(block, fileIds))) return item;
      return {
        ...item,
        content: content.map((block) =>
          isRejected(block, fileIds)
            ? { type: "input_text", text: unreadableNote(files.get(String(block.file_id))?.name) }
            : block,
        ),
      };
    }),
  };
}

/**
 * What the model reads where the file would have been.
 *
 * It says the file was not read, so the model does not describe a document it
 * never saw, and it says the provider refused it, so "please re-upload it" is
 * the obvious next step rather than something the model has to guess at. The
 * name is JSON-quoted for the reason `attachmentLine` gives: it is the user's,
 * and can hold anything.
 */
export function unreadableNote(name: string | undefined): string {
  const label = name ? `attachment ${JSON.stringify(name)}` : "an attachment";
  return `[${label} could not be read by the provider and is not shown to you. Tell the user if it matters to the answer; uploading it again may help.]`;
}

function isRejected(block: Record<string, unknown>, fileIds: Set<string>): boolean {
  return typeof block.file_id === "string" && fileIds.has(block.file_id);
}

function contentOf(item: ResponsesInputItem | undefined): Record<string, unknown>[] {
  const content = item?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function fileBlocks(input: ResponsesInputItem[]): { type: string; fileId: string }[] {
  const out: { type: string; fileId: string }[] = [];
  for (const item of input) {
    for (const block of contentOf(item)) {
      if (typeof block.file_id === "string" && block.file_id) {
        out.push({ type: String(block.type), fileId: block.file_id });
      }
    }
  }
  return out;
}

function errorDetail(body: unknown): { message?: string; param?: string } | null {
  if (!body || typeof body !== "object") return null;
  const wrapper = body as { error?: unknown };
  const inner = (wrapper.error && typeof wrapper.error === "object" ? wrapper.error : body) as {
    message?: unknown;
    param?: unknown;
  };
  return {
    message: typeof inner.message === "string" ? inner.message : undefined,
    param: typeof inner.param === "string" ? inner.param : undefined,
  };
}

/** `id` as a whole token in `message`, so `file-ab` is not blamed for `file-abc`. */
function mentions(message: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(message);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
