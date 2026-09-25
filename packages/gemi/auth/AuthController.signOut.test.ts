import { describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { recordReplacedToken } from "./sessionToken";

const deleteSession = vi.fn(async (_args: { token?: string }) => {});

/**
 * Resolving the user is what exchanges a token from before the session-token
 * change: `getSession` mints a replacement, writes it as the cookie, and
 * records it against the request. This stands in for that.
 */
let exchangeOnUserLookup: string | null = null;
let currentRequest: HttpRequest<any, any> | null = null;

const auth = {
  config: { onSignOut: async () => {} },
  userProvider: { deleteSession },
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
      if (exchangeOnUserLookup && currentRequest) {
        recordReplacedToken(currentRequest.rawRequest, exchangeOnUserLookup);
      }
      return { id: 1, email: "a@example.com" };
    },
  },
}));

const { AuthController } = await import("./AuthController");

async function signOutWith(cookie: string) {
  const req = new HttpRequest(
    new Request("https://app.example/api/auth/sign-out", {
      headers: { Cookie: cookie },
    }),
    {},
    "api",
  );
  currentRequest = req;
  return RequestContext.run(req, async () => {
    await new AuthController().signOut(req);
    return [...RequestContext.getStore().cookies];
  });
}

describe("signing out", () => {
  test("revokes the session the request arrived with", async () => {
    exchangeOnUserLookup = null;
    deleteSession.mockClear();

    await signOutWith("access_token=v2.abc");

    expect(deleteSession).toHaveBeenCalledWith({ token: "v2.abc" });
  });

  /**
   * Reading the cookie before resolving the user deleted the row the request
   * came in with and left the one it was handed during this very request
   * alive — for its full lifetime, with its value already sent in this
   * response's `Set-Cookie`. Signing out has to revoke the session the
   * request ends up carrying.
   */
  test("revokes the replacement when signing out exchanged the token", async () => {
    exchangeOnUserLookup = "v2.minted-during-this-request";
    deleteSession.mockClear();

    await signOutWith("access_token=0f1e2d3c4b5a69788796a5b4c3d2e1f0");

    expect(deleteSession).toHaveBeenCalledWith({
      token: "v2.minted-during-this-request",
    });
    expect(deleteSession).not.toHaveBeenCalledWith({
      token: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    });
  });
});
