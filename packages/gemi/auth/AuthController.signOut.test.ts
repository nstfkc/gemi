import { beforeEach, describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";

/**
 * Signing out revokes the token the request carried, on either transport.
 *
 * `AuthenticationMiddleware` accepts an `access_token` cookie or an
 * `access_token` header; `Auth.user()` reads the cookie alone. `signOut` used
 * to read the cookie alone too, so a native client sending the header revoked
 * nothing — and answered `401` before it got that far, because resolving the
 * user went through `Auth.user()`.
 */

const UA = "MyApp iOS/1.0";
const ROW = { token: "v2.abc", userAgent: UA, user: { id: 1, email: "a@example.com" } };

const row = () => ({ ...ROW, user: { ...ROW.user } });

const findSession = vi.fn(async ({ token }: { token: string }) =>
  token === ROW.token ? row() : null,
);
const deleteSession = vi.fn(async (_args: { token?: string }) => {});
const onSignOut = vi.fn(async (_user: unknown) => {});
const extendSession = vi.fn(async () => ({ plan: "pro" }));

/**
 * Stands in for the one thing `getSession` does that a sign-out must not
 * trigger: a session past half its window is slid forward and `access_token`
 * is written again. A request's cookies are a `Set` of serialized strings, so
 * that would ride out alongside the one clearing it rather than replacing it.
 */
const getSession = vi.fn(async (token: string) => {
  RequestContext.getStore().setCookie("access_token", token, {
    expires: new Date(Date.now() + 3_600_000),
  });
  return row();
});

const auth = {
  config: { onSignOut, extendSession },
  userProvider: { findSession, deleteSession },
  getSession,
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({
    expires,
    httpOnly: true,
    secure: false,
    domain: undefined,
  }),
  cookieDomain: () => undefined,
};

vi.mock("../foundation/app", () => ({ app: () => auth }));
vi.mock("../facades", () => ({
  Auth: {
    user: async () => {
      throw new Error(
        "signOut must not resolve the user through Auth.user(): it reads the cookie alone, so a header client's sign-out threw instead of revoking.",
      );
    },
  },
}));

const { AuthController } = await import("./AuthController");

async function signOut(headers: Record<string, string>) {
  const req = new HttpRequest(
    new Request("https://app.example/api/auth/sign-out", {
      method: "POST",
      headers: { "User-Agent": UA, ...headers },
    }),
    {},
    "api",
  );
  return RequestContext.run(req, async () => {
    const result = await new AuthController().signOut(req);
    return { result, cookies: [...RequestContext.getStore().cookies] };
  });
}

/** Every `access_token` value this response writes, in order. */
const written = (cookies: string[]) =>
  cookies
    .filter((cookie) => cookie.startsWith("access_token="))
    .map((cookie) => cookie.split(";")[0].slice("access_token=".length));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signing out", () => {
  test("revokes the session a native client sent in the access_token header", async () => {
    const { result } = await signOut({ access_token: "v2.abc" });

    expect(deleteSession).toHaveBeenCalledWith({ token: "v2.abc" });
    expect(result).toEqual({});
  });

  test("revokes the session a browser sent as the cookie", async () => {
    await signOut({ Cookie: "access_token=v2.abc" });

    expect(deleteSession).toHaveBeenCalledWith({ token: "v2.abc" });
  });

  test("prefers the cookie when a request carries both, as the middleware does", async () => {
    await signOut({ Cookie: "access_token=v2.abc", access_token: "v2.other" });

    expect(deleteSession).toHaveBeenCalledWith({ token: "v2.abc" });
  });

  test("hands the hook the user the token belongs to, extended as it always was", async () => {
    await signOut({ access_token: "v2.abc" });

    expect(onSignOut).toHaveBeenCalledWith({
      id: 1,
      email: "a@example.com",
      extension: { plan: "pro" },
    });
  });

  /**
   * The old `401`. Enforcing expiry — this release's other half — makes "the
   * session ran out a moment ago" ordinary, and refusing left the stale cookie
   * in the browser with no way to clear it.
   */
  test("answers and clears the cookie when there is no session to revoke", async () => {
    const { result, cookies } = await signOut({});

    expect(result).toEqual({});
    expect(written(cookies)).toEqual([""]);
    expect(findSession).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  test("an unknown token is revoked all the same, and the hook stays quiet", async () => {
    const { result, cookies } = await signOut({ access_token: "v2.gone" });

    expect(deleteSession).toHaveBeenCalledWith({ token: "v2.gone" });
    expect(written(cookies)).toEqual([""]);
    expect(result).toEqual({});
    expect(onSignOut).not.toHaveBeenCalled();
  });

  test("does not go through getSession, whose slide would write the cookie back", async () => {
    const { cookies } = await signOut({ Cookie: "access_token=v2.abc" });

    expect(getSession).not.toHaveBeenCalled();
    expect(written(cookies)).toEqual([""]);
  });
});
