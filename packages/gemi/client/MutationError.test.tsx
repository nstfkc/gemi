/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InvalidCSRFTokenError } from "../http/CSRFMiddleware";
import { RequestBreakerError } from "../http/Error";
import {
  AuthenticationError,
  AuthorizationError,
  FileNotFoundError,
  InsufficientPermissionsError,
} from "../http/errors";
import { RateLimitExceededError } from "../http/RateLimitMiddleware";
import { ValidationError } from "../http/Router";
import { notFoundResponse } from "../services/router/notFound";
import { policyDeniedResponse } from "../services/router/policyDenied";
import { unhandledErrorResponse } from "../server/unhandledError";
import { Form, ValidationErrors } from "./Mutation";
import {
  isAuthenticationError,
  isCsrfError,
  isFormError,
  isNetworkError,
  isNotFoundError,
  isPermissionError,
  isRateLimitError,
  isServerError,
  isValidationError,
  mutationErrorKind,
  type MutationErrorKind,
} from "./MutationError";
import { useMutation } from "./useMutation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Each case is the response the server really sends, built by the class or
 * helper that sends it — not a copy of its body — so a change to a payload
 * shows up here rather than in an app's error handling.
 */
const breaker = (error: { payload: { api: Record<string, any> } }) =>
  new Response(JSON.stringify(error.payload.api.data), {
    status: error.payload.api.status,
  });

const cases: Array<[name: string, response: () => Response, kind: MutationErrorKind]> = [
  [
    "ValidationError",
    () => breaker(new ValidationError({ email: ["Required"] })),
    "validation",
  ],
  ["AuthenticationError", () => breaker(new AuthenticationError()), "authentication"],
  ["AuthorizationError", () => breaker(new AuthorizationError()), "permission"],
  [
    "InsufficientPermissionsError",
    () => breaker(new InsufficientPermissionsError()),
    "permission",
  ],
  ["policy denial", () => policyDeniedResponse(), "permission"],
  ["InvalidCSRFTokenError", () => breaker(new InvalidCSRFTokenError()), "csrf"],
  ["a missing record", () => notFoundResponse(), "not_found"],
  ["FileNotFoundError", () => breaker(new FileNotFoundError("a.txt")), "not_found"],
  ["RateLimitExceededError", () => breaker(new RateLimitExceededError()), "rate_limit"],
  [
    "an unhandled exception",
    () => unhandledErrorResponse(new Error("boom"), "/api/posts", () => {}),
    "server",
  ],
  // Issue #673: a refusal thrown with a message of its own was a bare string
  // the guards could not place.
  [
    "an InsufficientPermissionsError with a message of its own",
    () => breaker(new InsufficientPermissionsError("Staff only")),
    "permission",
  ],
  [
    "an AuthorizationError with a message of its own",
    () => breaker(new AuthorizationError("You cannot edit this post")),
    "permission",
  ],
  [
    "a 500 under gemi dev, which carries the exception's message",
    () =>
      new Response(
        JSON.stringify({ error: { kind: "server_error", message: "boom", status: 500 } }),
        { status: 500 },
      ),
    "server",
  ],
  [
    "an app's own RequestBreakerError",
    () => breaker(new RequestBreakerError("This slug is taken", { status: 409 })),
    "form",
  ],
];

async function onErrorFor(response: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  const onError = vi.fn();
  const { result } = renderHook(() =>
    useMutation("POST" as never, "/posts" as never, {} as never, { onError } as never),
  );
  await act(() => result.current.trigger());
  expect(onError).toHaveBeenCalledOnce();
  const [error] = onError.mock.calls[0];
  // `error` and `onError` hold the same value.
  expect(result.current.error).toBe(error);
  return error;
}

describe("the errors a mutation reports", () => {
  test.each(cases)("%s is %s", async (_name, response, kind) => {
    expect(mutationErrorKind(await onErrorFor(response))).toBe(kind);
  });

  test("a request that gets no answer is a network error", async () => {
    const error = await onErrorFor(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(isNetworkError(error)).toBe(true);
    expect(mutationErrorKind(error)).toBe("network");
  });

  test("an answer that is not JSON is a server error", async () => {
    const error = await onErrorFor(
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    expect(error).toBeInstanceOf(SyntaxError);
    expect(mutationErrorKind(error)).toBe("server");
  });

  test("the value is the body's error field: { kind, message, status }", async () => {
    expect(
      await onErrorFor(() => breaker(new AuthorizationError("You cannot edit this post"))),
    ).toEqual({ kind: "authorization", message: "You cannot edit this post", status: 401 });
    expect(await onErrorFor(() => notFoundResponse())).toEqual({
      kind: "not_found",
      message: "Not found",
      status: 404,
    });
    expect(
      await onErrorFor(() => breaker(new ValidationError({ email: ["Required"] }))),
    ).toEqual({ kind: "validation_error", messages: { email: ["Required"] }, status: 400 });
  });

  test("a refusal the guards place has its message to show", async () => {
    const error = await onErrorFor(() =>
      breaker(new InsufficientPermissionsError("Staff only")),
    );
    if (!isPermissionError(error)) throw new Error("not a permission error");
    expect(error.message).toBe("Staff only");
    expect(error.status).toBe(403);
  });
});

/**
 * What a server before 0.88 sent, which a newer client still reads during a
 * rolling deploy: bare strings, and `{ message }` with no kind.
 */
describe("a server before 0.88", () => {
  const legacy = (status: number, error: unknown) =>
    new Response(JSON.stringify({ error }), { status });

  test.each([
    [401, "Authentication error", "authentication", "authentication"],
    [401, "Not authorized", "authorization", "permission"],
    [401, "You cannot edit this post", "authorization", "permission"],
    [403, "Insufficient permissions", "permission", "permission"],
    [403, "Staff only", "permission", "permission"],
    [403, "Invalid CSRF token", "csrf", "csrf"],
    [500, "Internal Server Error", "server_error", "server"],
    [500, "column \"x\" does not exist", "server_error", "server"],
    [409, "This slug is taken", "form_error", "form"],
  ] as const)("a %i %j is wrapped as %s", async (status, message, kind, guard) => {
    const error = await onErrorFor(() => legacy(status, message));
    expect(error).toEqual({ kind, message, status });
    expect(mutationErrorKind(error)).toBe(guard);
  });

  test.each([
    [404, "Not found", "not_found"],
    [403, "Forbidden", "permission"],
    [429, "Rate limit exceeded", "rate_limit"],
  ] as const)("a %i { message: %j } gains its kind and status", async (status, message, kind) => {
    expect(await onErrorFor(() => legacy(status, { message }))).toEqual({
      kind,
      message,
      status,
    });
  });

  test("a validation error gains its status", async () => {
    expect(
      await onErrorFor(() => legacy(400, { kind: "validation_error", messages: { a: ["x"] } })),
    ).toEqual({ kind: "validation_error", messages: { a: ["x"] }, status: 400 });
  });

  test("a cancelled request is not one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useMutation("POST" as never, "/posts" as never, {} as never, { onError } as never),
    );
    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.trigger();
    });
    await act(async () => {
      result.current.cancel();
      await pending;
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});

describe("the guards", () => {
  test("each recognises only its own kind", () => {
    const samples = {
      validation: { kind: "validation_error", messages: {} },
      form: { kind: "form_error", message: "Try again" },
      authentication: { kind: "authentication", message: "Sign in", status: 401 },
      permission: { kind: "authorization", message: "Not yours", status: 401 },
      csrf: { kind: "csrf", message: "Invalid CSRF token", status: 403 },
      not_found: { kind: "not_found", message: "Gone", status: 404 },
      rate_limit: { kind: "rate_limit", message: "Slow down", status: 429 },
      server: { kind: "server_error", message: "Bad Gateway" },
      network: new TypeError("Failed to fetch"),
    } as const;
    const guards = {
      validation: isValidationError,
      form: isFormError,
      authentication: isAuthenticationError,
      permission: isPermissionError,
      csrf: isCsrfError,
      not_found: isNotFoundError,
      rate_limit: isRateLimitError,
      server: isServerError,
      network: isNetworkError,
    };
    for (const [kind, sample] of Object.entries(samples)) {
      for (const [guardKind, guard] of Object.entries(guards)) {
        expect(guard(sample), `${guardKind} guard on a ${kind} error`).toBe(
          guardKind === kind,
        );
      }
      expect(mutationErrorKind(sample)).toBe(kind);
    }
  });

  test("a bare string or { message } off an older server is still placed", () => {
    expect(isAuthenticationError("Authentication error")).toBe(true);
    expect(isPermissionError("Insufficient permissions")).toBe(true);
    expect(isPermissionError("Not authorized")).toBe(true);
    expect(isCsrfError("Invalid CSRF token")).toBe(true);
    expect(isServerError("Internal Server Error")).toBe(true);
    expect(isPermissionError({ message: "Forbidden" })).toBe(true);
    expect(isNotFoundError({ message: "Not found" })).toBe(true);
    expect(isRateLimitError({ message: "Rate limit exceeded" })).toBe(true);
  });

  test("an object without a kind falls back to its status", () => {
    expect(isPermissionError({ message: "Staff only", status: 403 })).toBe(true);
    expect(isNotFoundError({ message: "Gone", status: 404 })).toBe(true);
  });

  test("an Error is never read as a { message } body", () => {
    expect(isNotFoundError(new Error("Not found"))).toBe(false);
    expect(isPermissionError(new Error("Forbidden"))).toBe(false);
  });

  test("anything else is unknown, not a throw", () => {
    for (const value of [null, undefined, 0, "", "Something", {}, [], { kind: "other" }]) {
      expect(mutationErrorKind(value)).toBe("unknown");
    }
  });
});

describe("<Form>", () => {
  test("onError gets the same value, and field messages still render", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => breaker(new ValidationError({ email: ["Required"] }))),
    );
    const onError = vi.fn();
    const { container, findByText } = render(
      <Form method={"POST" as never} action={"/posts" as never} onError={onError}>
        <ValidationErrors name="email" />
        <button type="submit">Save</button>
      </Form>,
    );
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const [error, form] = onError.mock.calls[0];
    expect(isValidationError(error)).toBe(true);
    expect(form).toBe(container.querySelector("form"));
    expect(await findByText("Required")).toBeTruthy();
  });
});
