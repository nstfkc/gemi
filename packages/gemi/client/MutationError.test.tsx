/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InvalidCSRFTokenError } from "../http/CSRFMiddleware";
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
  [
    "a refusal with a message of its own",
    () => breaker(new InsufficientPermissionsError("Staff only")),
    "unknown",
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

  /** The value is the response's `error` field as it was: typing it changed nothing at run time. */
  test("the value is the body's error field, unchanged", async () => {
    expect(await onErrorFor(() => breaker(new InsufficientPermissionsError()))).toBe(
      "Insufficient permissions",
    );
    expect(await onErrorFor(() => notFoundResponse())).toEqual({ message: "Not found" });
    expect(
      await onErrorFor(() => breaker(new ValidationError({ email: ["Required"] }))),
    ).toEqual({ kind: "validation_error", messages: { email: ["Required"] } });
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
      authentication: "Authentication error",
      permission: "Insufficient permissions",
      csrf: "Invalid CSRF token",
      not_found: { message: "Not found" },
      rate_limit: { message: "Rate limit exceeded" },
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
