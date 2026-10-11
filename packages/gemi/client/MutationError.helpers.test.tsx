/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { RequestBreakerError } from "../http/Error";
import { InsufficientPermissionsError } from "../http/errors";
import { httpError, HttpResponse } from "../http/HttpResponse";
import { RateLimitExceededError } from "../http/RateLimitMiddleware";
import { ValidationError } from "../http/Router";
import { unhandledErrorResponse } from "../server/unhandledError";
import { Form } from "./Mutation";
import { isValidationError, mutationErrorField, mutationErrorList } from "./MutationError";
import { withMutationErrorHelpers } from "./mutationErrorHelpers";
import { QueryError } from "./QueryError";
import { useMutation, useUpload } from "./useMutation";

/**
 * Issue #890: `error.list()` and `error.field(name)` on what the mutation
 * hooks hand over, and `mutationErrorList` / `mutationErrorField` for any
 * value. The responses are built by the classes that send them.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const breaker = (error: { payload: { api: Record<string, any> } }) =>
  new Response(JSON.stringify(error.payload.api.data), {
    status: error.payload.api.status,
  });

async function onErrorFor(response: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  const onError = vi.fn();
  const { result } = renderHook(() =>
    useMutation("POST" as never, "/posts" as never, {} as never, { onError } as never),
  );
  await act(() => result.current.trigger());
  const [error] = onError.mock.calls[0];
  expect(result.current.error).toBe(error);
  return error;
}

const FALLBACK = "Something went wrong. Try again.";

describe("error.list()", () => {
  test("a validation error's messages, field by field in the server's order", async () => {
    const error = await onErrorFor(() =>
      breaker(
        new ValidationError({
          title: ["Required", "Too short"],
          body: ["Required"],
        }),
      ),
    );
    expect(error.list()).toEqual(["Required", "Too short", "Required"]);
    expect(error.list("Could not save.")).toEqual(["Required", "Too short", "Required"]);
  });

  test("a form error, a refusal and a route's typed error give their message", async () => {
    const form = await onErrorFor(() =>
      breaker(new RequestBreakerError("This slug is taken", { status: 409 })),
    );
    expect(form.list()).toEqual(["This slug is taken"]);

    const refusal = await onErrorFor(() =>
      breaker(new InsufficientPermissionsError("Staff only")),
    );
    expect(refusal.list()).toEqual(["Staff only"]);

    const limited = await onErrorFor(() => breaker(new RateLimitExceededError()));
    expect(limited.list()).toEqual([limited.message]);

    const typed = await onErrorFor(() =>
      httpError(410, { kind: "gone", message: "Link has expired" }).toResponse(
        new Headers(),
        [],
      ),
    );
    expect(typed.list()).toEqual(["Link has expired"]);
  });

  test("a server error, an answer that is not JSON and no answer give the fallback", async () => {
    const server = await onErrorFor(() =>
      unhandledErrorResponse(new Error("boom"), "/api/posts", () => {}),
    );
    expect(server.list()).toEqual([FALLBACK]);
    expect(server.list("Could not save.")).toEqual(["Could not save."]);

    const html = await onErrorFor(() => new Response("<html>502</html>", { status: 502 }));
    expect(html).toBeInstanceOf(SyntaxError);
    expect(html.list()).toEqual([FALLBACK]);

    const offline = await onErrorFor(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(offline.list("Offline.")).toEqual(["Offline."]);
  });

  test("a validation error with no messages gives the fallback", () => {
    expect(
      mutationErrorList({ kind: "validation_error", messages: {} }, "Check the form."),
    ).toEqual(["Check the form."]);
  });

  test("a body of the route's own shape without a message gives the fallback", async () => {
    const error = await onErrorFor(() =>
      httpError(422, { kind: "x", code: 7 }).toResponse(new Headers(), []),
    );
    expect(error.list()).toEqual([FALLBACK]);
  });
});

describe("error.field(name)", () => {
  test("a validation error's messages for one field, [] for the others", async () => {
    const error = await onErrorFor(() =>
      breaker(new ValidationError({ email: ["Required", "Invalid email"] })),
    );
    expect(error.field("email")).toEqual(["Required", "Invalid email"]);
    expect(error.field("name")).toEqual([]);
  });

  test("[] for anything but a validation error", async () => {
    const error = await onErrorFor(() =>
      breaker(new RequestBreakerError("This slug is taken", { status: 409 })),
    );
    expect(error.field("slug")).toEqual([]);
    expect(mutationErrorField(new TypeError("Failed to fetch"), "slug")).toEqual([]);
    expect(mutationErrorField(null, "slug")).toEqual([]);
  });
});

describe("the helpers leave the value as it was", () => {
  test("they are not enumerable: toEqual, spread and JSON see the same object", async () => {
    const error = await onErrorFor(() =>
      breaker(new ValidationError({ email: ["Required"] })),
    );
    expect(Object.keys(error)).toEqual(["kind", "messages", "status"]);
    expect({ ...error }).toEqual({
      kind: "validation_error",
      messages: { email: ["Required"] },
      status: 400,
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({ ...error });
    expect(isValidationError(error)).toBe(true);
  });

  test("a body's own list or field is kept", async () => {
    const error = await onErrorFor(() =>
      HttpResponse.error(409, { message: "Taken", field: "slug" }).toResponse(
        new Headers(),
        [],
      ),
    );
    expect(error.field).toBe("slug");
    expect(error.list()).toEqual(["Taken"]);
  });

  test("a primitive or a frozen value is returned as it is", () => {
    expect(withMutationErrorHelpers("boom")).toBe("boom");
    const frozen = Object.freeze({ kind: "form_error", message: "No" });
    expect(withMutationErrorHelpers(frozen)).toBe(frozen);
    expect("list" in frozen).toBe(false);
  });
});

describe("the standalone helpers", () => {
  test("read a useQuery QueryError's body", () => {
    const validation = new QueryError("/posts", "k", 400, {
      error: { kind: "validation_error", messages: { q: ["Too long"] } },
    });
    expect(mutationErrorList(validation)).toEqual(["Too long"]);
    expect(mutationErrorField(validation, "q")).toEqual(["Too long"]);

    const refused = new QueryError("/posts", "k", 403, {
      error: { kind: "permission", message: "Staff only", status: 403 },
    });
    expect(mutationErrorList(refused)).toEqual(["Staff only"]);

    const notJson = new QueryError("/posts", "k", 502, null);
    expect(mutationErrorList(notJson, "Could not load.")).toEqual(["Could not load."]);
  });

  test("anything else gives the fallback", () => {
    for (const value of [undefined, null, "boom", 42, new Error("boom")]) {
      expect(mutationErrorList(value)).toEqual([FALLBACK]);
    }
  });
});

describe("the hooks' helpers and the standalone ones agree", () => {
  // `list` and `field` on the hooks' errors come from `./mutationErrorHelpers`,
  // loaded on first use, and repeat `mutationErrorList` / `mutationErrorField`
  // rather than import them (#915). Every case through both.
  const values = () => [
    { kind: "validation_error", messages: { title: ["Required", ""], body: ["Too short"] } },
    { kind: "validation_error", messages: {} },
    { kind: "validation_error" },
    { kind: "form_error", message: "This slug is taken", status: 409 },
    { kind: "permission", message: "Staff only", status: 403 },
    { kind: "server_error", message: "boom", status: 500 },
    { kind: "gone", code: 7, status: 410 },
    { kind: "x", message: "", status: 422 },
    new QueryError("/posts", "k", 400, {
      error: { kind: "validation_error", messages: { q: ["Too long"] } },
    }),
    new QueryError("/posts", "k", 403, { error: { kind: "permission", message: "No" } }),
    new QueryError("/posts", "k", 502, null),
    new TypeError("Failed to fetch"),
    new SyntaxError("Unexpected token <"),
  ];

  test("list, with and without a fallback", () => {
    for (const value of values()) {
      const helped = withMutationErrorHelpers(value) as { list(fallback?: string): string[] };
      expect(helped.list()).toEqual(mutationErrorList(value));
      expect(helped.list("Could not save.")).toEqual(mutationErrorList(value, "Could not save."));
    }
  });

  test("field", () => {
    for (const value of values()) {
      const helped = withMutationErrorHelpers(value) as { field(name: string): string[] };
      for (const name of ["title", "body", "q", "missing"]) {
        expect(helped.field(name)).toEqual(mutationErrorField(value, name));
      }
    }
  });
});

describe("every hook hands them over", () => {
  test("onError and error hold the same value, with the helpers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => breaker(new ValidationError({ email: ["Required"] }))),
    );
    const onError = vi.fn();
    const call = vi.fn();
    const { result } = renderHook(() =>
      useMutation("POST" as never, "/posts" as never, {} as never, { onError } as never),
    );
    await act(() => result.current.trigger(undefined as never, { onError: call }));
    expect(onError.mock.calls[0][0].list()).toEqual(["Required"]);
    expect(call.mock.calls[0][0]).toBe(onError.mock.calls[0][0]);
  });

  test("<Form onError>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => breaker(new ValidationError({ email: ["Required"] }))),
    );
    const onError = vi.fn();
    const { container } = render(
      <Form method={"POST" as never} action={"/posts" as never} onError={onError}>
        <button type="submit">Save</button>
      </Form>,
    );
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0].field("email")).toEqual(["Required"]);
  });

  test("useUpload, for a refusal, one that is not JSON and no answer", async () => {
    const xhrs: Array<{ respond: (status: number, body: string) => void; fail: () => void }> =
      [];
    class FakeXHR extends EventTarget {
      upload = new EventTarget();
      status = 0;
      statusText = "";
      responseText = "";
      constructor() {
        super();
        xhrs.push(this);
      }
      open() {}
      send() {}
      abort() {}
      respond(status: number, body: string) {
        this.status = status;
        this.statusText = "Bad Gateway";
        this.responseText = body;
        this.dispatchEvent(new Event("load"));
      }
      fail() {
        this.dispatchEvent(new Event("error"));
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useUpload("/avatar" as never, {} as never, { onError } as never),
    );
    const file = new File(["x"], "x.txt");

    for (const settle of [
      (xhr: (typeof xhrs)[number]) =>
        xhr.respond(
          422,
          JSON.stringify({ error: { kind: "validation_error", messages: { file: ["Too big"] } } }),
        ),
      (xhr: (typeof xhrs)[number]) => xhr.respond(502, "<html>502</html>"),
      (xhr: (typeof xhrs)[number]) => xhr.fail(),
    ]) {
      let settled!: Promise<unknown>;
      act(() => {
        settled = result.current.trigger(file);
      });
      await act(async () => {
        settle(xhrs.at(-1)!);
        await settled;
      });
    }
    const [validation, notJson, offline] = onError.mock.calls.map(([error]) => error);
    expect(validation.field("file")).toEqual(["Too big"]);
    expect(validation.list()).toEqual(["Too big"]);
    expect(notJson.list()).toEqual([FALLBACK]);
    expect(offline.list()).toEqual([FALLBACK]);
  });
});
