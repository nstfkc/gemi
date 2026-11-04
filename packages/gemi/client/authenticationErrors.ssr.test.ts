/** @vitest-environment node */
import { afterEach, expect, test, vi } from "vitest";
import {
  configureAuthenticationErrors,
  reportAuthenticationRefusal,
  resetAuthenticationErrorsForTests,
} from "./authenticationErrors";

afterEach(() => {
  resetAuthenticationErrorsForTests();
  vi.unstubAllGlobals();
});

// The query cache runs during a server render too; there is no page to send
// anywhere, and no request may go out.
test("reporting outside a browser does nothing", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  configureAuthenticationErrors("redirect");

  expect(() =>
    reportAuthenticationRefusal({
      source: "query",
      path: "/todos",
      status: 401,
      body: { error: { kind: "authentication", message: "Authentication error", status: 401 } },
      headers: null,
      error: null,
    }),
  ).not.toThrow();
  expect(setTimeoutSpy).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});
