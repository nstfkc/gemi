import { afterEach, describe, expect, test, vi } from "vitest";

import { configuredAppOrigin } from "../utils/appOrigin";
import { Url } from "./Url";

/**
 * `Url.origin()`, the app's public origin: which variable it reads, how it
 * normalises, and when it refuses. Also the unchecked resolver gemi's own
 * call sites (`Url.absolute`, OAuth redirect URIs, ...) share.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

function env(values: { HOST_NAME?: string; APP_URL?: string }) {
  vi.stubEnv("HOST_NAME", values.HOST_NAME ?? "");
  vi.stubEnv("APP_URL", values.APP_URL ?? "");
}

describe("Url.origin", () => {
  test("reads HOST_NAME", () => {
    env({ HOST_NAME: "https://example.com" });
    expect(Url.origin()).toBe("https://example.com");
  });

  test("falls back to APP_URL when HOST_NAME is unset", () => {
    env({ APP_URL: "https://app.example.com" });
    expect(Url.origin()).toBe("https://app.example.com");
  });

  // HOST_NAME is what gemi has always read, so an app that sets it keeps
  // exactly the value it had.
  test("HOST_NAME wins over APP_URL", () => {
    env({ HOST_NAME: "https://example.com", APP_URL: "https://other.example.com" });
    expect(Url.origin()).toBe("https://example.com");
  });

  test("trims whitespace and trailing slashes, keeps a path", () => {
    env({ HOST_NAME: "  https://example.com//  " });
    expect(Url.origin()).toBe("https://example.com");
    env({ HOST_NAME: "https://example.com/app/" });
    expect(Url.origin()).toBe("https://example.com/app");
  });

  test("is read on every call, so a stub applies at once", () => {
    env({ HOST_NAME: "https://one.test" });
    expect(Url.origin()).toBe("https://one.test");
    vi.stubEnv("HOST_NAME", "http://localhost:5173");
    expect(Url.origin()).toBe("http://localhost:5173");
  });

  test("throws when nothing is configured", () => {
    env({});
    expect(() => Url.origin()).toThrow("set HOST_NAME (or APP_URL)");
  });

  test("uses the fallback only when nothing is configured", () => {
    env({});
    expect(Url.origin("http://localhost:5173/")).toBe("http://localhost:5173");
    env({ HOST_NAME: "https://example.com" });
    expect(Url.origin("http://localhost:5173")).toBe("https://example.com");
  });

  test("refuses a value that is not an absolute http(s) URL, naming its source", () => {
    env({ HOST_NAME: "example.com" });
    expect(() => Url.origin()).toThrow(/from HOST_NAME \("example\.com"\)/);
    env({ APP_URL: "ftp://example.com" });
    expect(() => Url.origin()).toThrow(/from APP_URL/);
    env({});
    expect(() => Url.origin("localhost:5173")).toThrow(/from fallback/);
  });
});

describe("configuredAppOrigin", () => {
  test("is undefined when nothing is configured, without throwing", () => {
    env({});
    expect(configuredAppOrigin()).toBeUndefined();
  });

  test("normalises like Url.origin but does not validate", () => {
    env({ HOST_NAME: "example.com/" });
    expect(configuredAppOrigin()).toBe("example.com");
  });
});

describe("Url.absolute", () => {
  test("prefixes the app origin, without a doubled slash", () => {
    env({ HOST_NAME: "https://example.com/" });
    expect(Url.absolute("/pricing" as never)).toBe("https://example.com/pricing");
  });

  test("uses APP_URL when HOST_NAME is unset", () => {
    env({ APP_URL: "https://app.example.com" });
    expect(Url.absolute("/pricing" as never)).toBe("https://app.example.com/pricing");
  });
});
