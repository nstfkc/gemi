import { describe, expect, test } from "vitest";
import {
  ensureSessionId,
  RequestContext,
  SESSION_ID_COOKIE,
  sessionId,
} from "./requestContext";

/**
 * A fake standing in for `HttpRequest`, which needs a real `Request` and a route
 * match to construct. Only `cookies` is read here.
 */
function fakeRequest(cookies: Record<string, string> = {}) {
  return {
    cookies: {
      get: (name: string) => cookies[name],
      has: (name: string) => name in cookies,
    },
  } as any;
}

/** Parses the `Set-Cookie` strings the store accumulated. */
function setCookieValue(store: any, name: string): string | undefined {
  for (const cookie of store.cookies) {
    const [pair] = cookie.split("; ");
    const [key, value] = pair.split("=");
    if (key === name) return value;
  }
  return undefined;
}

describe("sessionId", () => {
  test("returns null outside a request", () => {
    expect(sessionId()).toBe(null);
    expect(ensureSessionId()).toBe(null);
  });

  test("reads the cookie the browser sent, and mints nothing", () => {
    RequestContext.run(fakeRequest({ [SESSION_ID_COOKIE]: "sent-id" }), () => {
      expect(sessionId()).toBe("sent-id");
      expect(setCookieValue(RequestContext.getStore(), SESSION_ID_COOKIE)).toBeUndefined();
    });
  });

  test("returns null for an anonymous request without minting", () => {
    RequestContext.run(fakeRequest(), () => {
      expect(sessionId()).toBe(null);
      expect(RequestContext.getStore().cookies.size).toBe(0);
    });
  });

  test("ensureSessionId mints once and sets the cookie", () => {
    RequestContext.run(fakeRequest(), () => {
      const first = ensureSessionId();

      expect(first).toBeTruthy();
      expect(setCookieValue(RequestContext.getStore(), SESSION_ID_COOKIE)).toBe(first);
    });
  });

  test("ensureSessionId is idempotent within a request", () => {
    RequestContext.run(fakeRequest(), () => {
      const first = ensureSessionId();
      const second = ensureSessionId();
      const read = sessionId();

      expect(second).toBe(first);
      expect(read).toBe(first);
      // One mint, one Set-Cookie — a second would overwrite the first with a
      // different id and re-bucket the visitor mid-request.
      expect(RequestContext.getStore().cookies.size).toBe(1);
    });
  });

  test("a minted id is readable back in the same request", () => {
    // The regression this guards: `setCookie` only appends a serialized
    // `Set-Cookie` string, and `req.cookies` still holds what the browser sent,
    // so without the store field there is no way to read back what was minted.
    RequestContext.run(fakeRequest(), () => {
      const minted = ensureSessionId();
      expect(sessionId()).toBe(minted);
    });
  });

  test("ensureSessionId prefers the sent cookie over minting", () => {
    RequestContext.run(fakeRequest({ [SESSION_ID_COOKIE]: "sent-id" }), () => {
      expect(ensureSessionId()).toBe("sent-id");
      expect(RequestContext.getStore().cookies.size).toBe(0);
    });
  });

  test("ids are distinct across requests", () => {
    let a: string | null = null;
    let b: string | null = null;
    RequestContext.run(fakeRequest(), () => {
      a = ensureSessionId();
    });
    RequestContext.run(fakeRequest(), () => {
      b = ensureSessionId();
    });

    expect(a).not.toBe(b);
  });
});
