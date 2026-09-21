import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  InsufficientPermissionsError,
} from "../http/errors";
import { RequestContext } from "../http/requestContext";
import { Auth } from "./Auth";
import { Broadcast } from "./Broadcast";

/**
 * A fake standing in for `HttpRequest`, which needs a real `Request` and a route
 * match to construct. `Auth.user()` reads only a cookie and a header.
 */
function fakeRequest() {
  return {
    cookies: { get: () => undefined },
    headers: { get: () => "test-agent" },
  } as any;
}

const user = { id: 1, email: "a@example.com", globalRole: 1 } as any;

/** Runs `fn` inside a request whose session resolves to `sessionUser`. */
function inRequest<T>(sessionUser: any, fn: () => Promise<T>): Promise<T> {
  vi.spyOn(Auth, "getFacadeRoot").mockReturnValue({
    getSession: async () => (sessionUser ? { user: sessionUser } : null),
  } as any);
  return RequestContext.run(fakeRequest(), fn);
}

beforeEach(() => {
  // No broadcasting context: this is an HTTP request.
  vi.spyOn(Broadcast, "getFacadeRoot").mockReturnValue({
    context: { getStore: () => undefined },
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Auth.guard", () => {
  test("with no user, answers 401 and never runs the predicate", async () => {
    const fn = vi.fn(() => true);

    const error = await inRequest(null, () => Auth.guard(fn)).catch((e) => e);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.payload.api.status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });

  test("with a user the predicate refuses, answers 403", async () => {
    const error = await inRequest(user, () => Auth.guard(() => false)).catch((e) => e);

    expect(error).toBeInstanceOf(InsufficientPermissionsError);
    expect(error.payload.api.status).toBe(403);
    expect(error.payload.api.data).toEqual({
      error: "Insufficient permissions",
    });
    expect(error.payload.view.status).toBe(403);
  });

  test("with a user the async predicate refuses, answers 403", async () => {
    const error = await inRequest(user, () => Auth.guard(async () => false)).catch((e) => e);

    expect(error).toBeInstanceOf(InsufficientPermissionsError);
    expect(error.payload.api.status).toBe(403);
  });

  test("with a user the predicate allows, passes the user and resolves", async () => {
    const fn = vi.fn(() => true);

    await expect(inRequest(user, () => Auth.guard(fn))).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith(user);
  });

  test("an error thrown by the predicate propagates as itself, not as a 403", async () => {
    const outage = new Error("connection refused");

    const error = await inRequest(user, () =>
      Auth.guard(() => {
        throw outage;
      }),
    ).catch((e) => e);

    expect(error).toBe(outage);
  });

  test("guardSafe still answers false when the predicate throws", async () => {
    await expect(
      inRequest(user, () =>
        Auth.guardSafe(() => {
          throw new Error("connection refused");
        }),
      ),
    ).resolves.toBe(false);
  });
});

describe("auth error names", () => {
  test("each error is named after its own class", () => {
    expect(new AuthenticationError().name).toBe("AuthenticationError");
    expect(new AuthorizationError().name).toBe("AuthorizationError");
    expect(new InsufficientPermissionsError().name).toBe("InsufficientPermissionsError");
  });

  test('the message is the refusal, not "Authentication error"', () => {
    expect(new InsufficientPermissionsError().message).toBe("Insufficient permissions");
    expect(new AuthorizationError("You cannot edit this post").message).toBe(
      "You cannot edit this post",
    );
  });

  test("AuthorizationError keeps answering 401", () => {
    expect(new AuthorizationError().payload.api.status).toBe(401);
  });
});
