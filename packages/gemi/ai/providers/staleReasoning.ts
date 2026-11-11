import { ProviderHttpError } from "./errors";
import { errorDetail } from "./fileRejection";
import type { ResponsesRequest } from "./request";

/**
 * A replayed reasoning item the API no longer has, and the one retry it gets.
 *
 * Reasoning goes back to the Responses API by id (`request.ts`,
 * `reasoningItem`), and the API looks the id up in what it stored. When the
 * lookup fails the whole request is refused, `400 Item with id 'rs_…' not
 * found.`, and because the id lives in the thread, so is every later turn.
 * `toResponsesInput` already leaves out the reasoning of a message whose
 * response never completed, which is the case seen in practice; this is the
 * net under everything that rule does not know about (an item the vendor
 * expired, a thread moved to another resource or deployment).
 *
 * The request is sent again once, with every reasoning item taken out rather
 * than only the one named: Azure names a single id per refusal, and a thread
 * with two stale items would otherwise spend its retry on the first and fail
 * on the second. Reasoning is continuity and a cache hit, never content the
 * answer depends on, and `request.ts` already sends a history without it
 * whenever a part has no id, so the retried request is one the API accepts.
 *
 * Only for a refusal that names a reasoning item this request actually sent:
 * any other 400 fails the call as before.
 */
export function withoutStaleReasoning(body: unknown, error: unknown): ResponsesRequest | null {
  if (!(error instanceof ProviderHttpError)) return null;
  if (error.status !== 400 && error.status !== 404) return null;
  const input = (body as Partial<ResponsesRequest> | null)?.input;
  if (!Array.isArray(input)) return null;
  const message = errorDetail(error.body)?.message ?? "";
  const named = /Item with id '([^']+)' not found/i.exec(message)?.[1];
  if (!named) return null;
  const isReasoning = (item: Record<string, unknown>) => item?.type === "reasoning";
  if (!input.some((item) => isReasoning(item) && item.id === named)) return null;
  return {
    ...(body as ResponsesRequest),
    input: input.filter((item) => !isReasoning(item)),
  };
}
