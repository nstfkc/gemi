import { afterEach, describe, expect, test } from "vitest";
import { unhandledErrorResponse } from "../server/unhandledError";
import { InvalidCSRFTokenError } from "./CSRFMiddleware";
import { RequestBreakerError } from "./Error";
import {
  AuthenticationError,
  AuthorizationError,
  FileNotFoundError,
  InsufficientPermissionsError,
  RangeNotSatisfiableError,
} from "./errors";
import { RateLimitExceededError } from "./RateLimitMiddleware";

/**
 * Issue #673: every refusal's `error` is `{ kind, message, status }`, so a
 * client can classify one thrown with a message of its own.
 */

const apiError = (error: RequestBreakerError) => error.payload.api.data.error;

afterEach(() => {
  RequestBreakerError.legacyStringPayload = false;
  InsufficientPermissionsError.apiStatus = 403;
});

describe("the framework's refusals", () => {
  test.each([
    [new AuthenticationError(), "authentication", "Authentication error", 401],
    [new AuthorizationError(), "authorization", "Not authorized", 401],
    [new AuthorizationError("You cannot edit this post"), "authorization", "You cannot edit this post", 401],
    [new InsufficientPermissionsError(), "permission", "Insufficient permissions", 403],
    [new InsufficientPermissionsError("Staff only"), "permission", "Staff only", 403],
    [new InvalidCSRFTokenError(), "csrf", "Invalid CSRF token", 403],
    [new FileNotFoundError("a.txt"), "not_found", "Not found", 404],
    [new RangeNotSatisfiableError(10), "range_not_satisfiable", "Range not satisfiable", 416],
    [new RateLimitExceededError(), "rate_limit", "Rate limit exceeded", 429],
  ] as const)("%o answers { kind: %j, message: %j, status: %i }", (error, kind, message, status) => {
    expect(apiError(error)).toEqual({ kind, message, status });
    expect(error.payload.api.status).toBe(status);
  });

  test("the status follows InsufficientPermissionsError.apiStatus", () => {
    InsufficientPermissionsError.apiStatus = 401;
    expect(apiError(new InsufficientPermissionsError())).toEqual({
      kind: "permission",
      message: "Insufficient permissions",
      status: 401,
    });
  });

  test("an unhandled exception is a server_error", async () => {
    const res = unhandledErrorResponse(new Error("boom"), "/api/x", () => {});
    expect(await res.json()).toEqual({
      error: { kind: "server_error", message: "Internal Server Error", status: 500 },
    });
  });
});

describe("an app's own RequestBreakerError", () => {
  test("answers a form_error under 400 by default", () => {
    const error = new RequestBreakerError("Nope");
    expect(error.payload.api.status).toBe(400);
    expect(apiError(error)).toEqual({ kind: "form_error", message: "Nope", status: 400 });
    expect(error.payload.view).toEqual({ status: 400 });
  });

  test.each([
    [401, "authentication"],
    [403, "permission"],
    [404, "not_found"],
    [409, "form_error"],
    [422, "form_error"],
    [429, "rate_limit"],
    [503, "server_error"],
  ] as const)("takes its kind from status %i: %s", (status, kind) => {
    expect(apiError(new RequestBreakerError("x", { status }))).toEqual({
      kind,
      message: "x",
      status,
    });
  });

  test("names its kind and headers when told", () => {
    const error = new RequestBreakerError("Staff only", {
      status: 401,
      kind: "authorization",
      headers: { "X-Reason": "staff" },
    });
    expect(error.payload.api).toEqual({
      status: 401,
      data: { error: { kind: "authorization", message: "Staff only", status: 401 } },
      headers: { "X-Reason": "staff" },
    });
  });

  test("a subclass that sets its payload keeps it", () => {
    class Teapot extends RequestBreakerError {
      constructor() {
        super("teapot");
        this.payload.api = { status: 418, data: { error: "teapot" } };
      }
    }
    expect(new Teapot().payload.api).toEqual({ status: 418, data: { error: "teapot" } });
  });
});

describe("RequestBreakerError.legacyStringPayload", () => {
  test("turns the refusals that were strings back into strings", async () => {
    RequestBreakerError.legacyStringPayload = true;
    expect(apiError(new AuthenticationError())).toBe("Authentication error");
    expect(apiError(new AuthorizationError("Mine"))).toBe("Mine");
    expect(apiError(new InsufficientPermissionsError())).toBe("Insufficient permissions");
    expect(apiError(new InvalidCSRFTokenError())).toBe("Invalid CSRF token");
    const res = unhandledErrorResponse(new Error("boom"), "/api/x", () => {});
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
  });

  test("leaves the refusals that were objects as objects", () => {
    RequestBreakerError.legacyStringPayload = true;
    expect(apiError(new FileNotFoundError("a.txt"))).toEqual({
      kind: "not_found",
      message: "Not found",
      status: 404,
    });
    expect(apiError(new RateLimitExceededError())).toEqual({
      kind: "rate_limit",
      message: "Rate limit exceeded",
      status: 429,
    });
  });
});
