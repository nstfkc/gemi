/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ClientRouterContext } from "./ClientRouterContext";
import { I18nContext } from "./I18nContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useNavigate } from "./useNavigate";

/**
 * Another host of the app — what `useDomain().url(...)` returns — is outside
 * the client router's reach: its history entries describe paths on the current
 * host, so the only way to reach `admin.gemi.dev` is a full page load.
 */

const pushed: Array<[string, unknown]> = [];
const replaced: Array<[string, unknown]> = [];
const assigned: string[] = [];
const located: string[] = [];

function renderNavigate() {
  let navigate!: ReturnType<typeof useNavigate>;
  function Probe() {
    navigate = useNavigate();
    return null;
  }

  const history = {
    push: (path: string, options?: unknown) => pushed.push([path, options]),
    replace: (path: string, options?: unknown) => replaced.push([path, options]),
  };

  const container = document.createElement("div");
  act(() => {
    createRoot(container).render(
      createElement(
        ClientRouterContext.Provider,
        { value: { history, setNavigationAbortController: () => {} } as any },
        createElement(
          I18nContext.Provider,
          { value: { defaultLocale: "en-US" } as any },
          createElement(
            RouteStateProvider,
            {
              state: {
                pathname: "/",
                search: "",
                hash: "",
                params: {},
                locale: "en-US",
              } as RouteState & PageData,
            },
            createElement(Probe),
          ),
        ),
      ),
    );
  });
  return navigate;
}

const realLocation = window.location;

beforeEach(() => {
  pushed.length = 0;
  replaced.length = 0;
  assigned.length = 0;
  located.length = 0;
  // jsdom refuses a real navigation and its `location` is read-only, so the
  // whole object is swapped for one that records the two calls.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: "http://acme.gemi.dev:5173/",
      assign: (url: string) => assigned.push(url),
      replace: (url: string) => located.push(url),
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  vi.restoreAllMocks();
});

describe("useNavigate to another host", () => {
  test("push leaves the page rather than pushing a history entry", async () => {
    const navigate = renderNavigate();

    await act(async () => {
      await navigate.push("http://admin.gemi.dev:5173/users/7");
    });

    expect(assigned).toEqual(["http://admin.gemi.dev:5173/users/7"]);
    expect(pushed).toEqual([]);
  });

  test("replace leaves the page too, replacing the entry", async () => {
    const navigate = renderNavigate();

    await act(async () => {
      await navigate.replace("https://app.acme.com/users/7");
    });

    expect(located).toEqual(["https://app.acme.com/users/7"]);
    expect(replaced).toEqual([]);
  });

  test("a path on this host is still a client-side navigation", async () => {
    const navigate = renderNavigate();

    await act(async () => {
      await navigate.push("/users/7");
    });

    expect(pushed).toEqual([["/users/7", undefined]]);
    expect(assigned).toEqual([]);
  });
});
