import { describe, expect, test } from "vitest";

import { BroadcastManager } from "../services/pubsub/BroadcastManager";
import { getCookies, parseCookieHeader } from "./getCookies";
import { HttpRequest } from "./HttpRequest";

function requestWithCookie(cookie?: string) {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return new Request("http://localhost/", { headers });
}

describe("parseCookieHeader", () => {
  test("keeps every `=` after the first in the value", () => {
    expect(parseCookieHeader("a=b==").get("a")).toBe("b==");
    expect(parseCookieHeader("k=v=w").get("k")).toBe("v=w");
  });

  test("skips a pair with no `=` instead of throwing", () => {
    const cookies = parseCookieHeader("flag; session_id=x");
    expect(cookies.get("session_id")).toBe("x");
    expect(cookies.has("flag")).toBe(false);
  });

  test("skips a pair with an empty name", () => {
    const cookies = parseCookieHeader("=orphan; a=1");
    expect([...cookies]).toEqual([["a", "1"]]);
  });

  test("an empty or missing header gives an empty map", () => {
    expect(parseCookieHeader("").size).toBe(0);
    expect(parseCookieHeader(null).size).toBe(0);
    expect(parseCookieHeader(undefined).size).toBe(0);
  });

  test("trims whitespace around names and values, and keeps an empty value", () => {
    const cookies = parseCookieHeader(" a = 1 ;b=; c=3");
    expect([...cookies]).toEqual([
      ["a", "1"],
      ["b", ""],
      ["c", "3"],
    ]);
  });

  test("a repeated name keeps its last value", () => {
    expect(parseCookieHeader("a=1; a=2").get("a")).toBe("2");
  });

  test("does not percent-decode, because createCookie does not encode", () => {
    expect(parseCookieHeader("a=x%20y").get("a")).toBe("x%20y");
  });
});

describe("every Cookie reader uses the same parser", () => {
  const header = "flag; token=abc==; session_id=x";

  test("HttpRequest", () => {
    const req = new HttpRequest(requestWithCookie(header), {}, "api", "/");
    expect(req.cookies.get("token")).toBe("abc==");
    expect(req.cookies.get("session_id")).toBe("x");
  });

  test("HttpRequest with an empty Cookie header", () => {
    const req = new HttpRequest(requestWithCookie(""), {}, "api", "/");
    expect(req.cookies.size).toBe(0);
  });

  test("getCookies", () => {
    const cookies = getCookies(requestWithCookie(header));
    expect(cookies.get("token")).toBe("abc==");
    expect(cookies.get("session_id")).toBe("x");
  });

  test("BroadcastManager.run", () => {
    const manager = new BroadcastManager({} as any);
    let seen: Map<string, string> | undefined;
    manager.run(new Headers({ Cookie: header }), () => {
      seen = manager.context.getStore()?.cookies;
    });
    expect(seen?.get("token")).toBe("abc==");
    expect(seen?.get("session_id")).toBe("x");
  });
});
