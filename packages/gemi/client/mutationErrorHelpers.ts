import {
  isObject,
  mutationErrorFromBody,
  type MutationErrorHelpers,
  type MutationValidationError,
  type WithMutationErrorHelpers,
} from "./MutationError";

// `error.list()` and `error.field(name)` on what the mutation hooks hand over.
// Loaded with the hooks' other extras when one mounts (see
// `./mutationModules`), so no route's entry chunk carries it (#915).
//
// `list` and `field` repeat `mutationErrorList` and `mutationErrorField` from
// `./MutationError` on purpose. Those are public and synchronous, so they sit
// in whatever chunk calls them; importing them here would put them, and so
// this code, back in every entry chunk. `MutationError.helpers.test` runs the
// same cases through both.

const FALLBACK_MESSAGE = "Something went wrong. Try again.";

// `isValidationError`, which an import would keep in the entry chunk.
function isValidationError(error: unknown): error is MutationValidationError {
  return isObject(error) && error.kind === "validation_error";
}

// A `QueryError`'s refusal, read as the mutation hooks read a body. Read by
// shape, not `instanceof`, so a copy of the class from another bundle works.
function unwrapQueryError(error: unknown): unknown {
  if (error instanceof Error && error.name === "QueryError" && "body" in error) {
    const { body, status } = error as Error & { body: unknown; status: number };
    return body == null ? error : mutationErrorFromBody(body, status);
  }
  return error;
}

// `error.list(fallback)`: see `mutationErrorList`.
function list(
  error: unknown,
  fallback: string = FALLBACK_MESSAGE,
): string[] {
  const value = unwrapQueryError(error);
  if (isValidationError(value)) {
    const messages = Object.values(value.messages ?? {})
      .flat()
      .filter((message) => typeof message === "string" && message !== "");
    return messages.length > 0 ? messages : [fallback];
  }
  if (
    isObject(value) &&
    !(value instanceof Error) &&
    value.kind !== "server_error" &&
    typeof value.message === "string" &&
    value.message !== ""
  ) {
    return [value.message];
  }
  return [fallback];
}

// `error.field(name)`: see `mutationErrorField`.
function field(error: unknown, name: string): string[] {
  const value = unwrapQueryError(error);
  if (!isValidationError(value)) return [];
  const messages = value.messages?.[name];
  return Array.isArray(messages) ? [...messages] : [];
}

/**
 * Puts `list` and `field` on an error the hooks hand over, as non-enumerable
 * properties, so `toEqual`, a spread and `JSON.stringify` see the same object
 * as before. A key the error already has is left alone; a primitive or a
 * frozen value is returned as it is.
 *
 * @internal
 */
export function withMutationErrorHelpers<T>(error: T): WithMutationErrorHelpers<T> {
  if (!isObject(error) || !Object.isExtensible(error)) {
    return error as WithMutationErrorHelpers<T>;
  }
  const helpers: MutationErrorHelpers = {
    list: (fallback) => list(error, fallback),
    field: (name) => field(error, name),
  };
  for (const key of ["list", "field"] as const) {
    if (key in error) continue;
    Object.defineProperty(error, key, {
      value: helpers[key],
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  return error as WithMutationErrorHelpers<T>;
}
