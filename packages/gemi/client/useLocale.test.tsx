/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ClientRouterContext } from "./ClientRouterContext";
import { I18nContext } from "./I18nContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useLocale } from "./useLocale";

/**
 * The switch has to survive a cookie write that never answers — that is the
 * whole failure: `cookieStore.set()` staying unsettled on iOS Safari left the
 * navigation behind a `.then()` that never ran, so changing the language did
 * nothing at all and raised nothing to report it.
 */
function renderSetLocale(state: Partial<RouteState & PageData> = {}) {
  const replaced: Array<[string, any]> = [];
  const cookieAtNavigation: string[] = [];
  const history = {
    replace: (path: string, options?: any) => {
      cookieAtNavigation.push(document.cookie);
      replaced.push([path, options]);
    },
    push: () => {},
  };

  let setLocale!: (locale: string) => Promise<void>;
  function Probe() {
    const [, set] = useLocale();
    setLocale = set;
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(
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
                pathname: "/pricing",
                search: "",
                hash: "",
                params: {},
                locale: "tr-TR",
                i18n: { currentLocale: "tr-TR" },
                ...state,
              } as RouteState & PageData,
            },
            createElement(Probe),
          ),
        ),
      ),
    );
  });

  return {
    setLocale: (locale: string) => setLocale(locale),
    replaced,
    cookieAtNavigation,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "i18n-locale=; Max-Age=0; Path=/";
});

describe("useLocale().setLocale", () => {
  test("navigates even though the cookie request never settles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    const { setLocale, replaced } = renderSetLocale();
    await act(async () => {
      await setLocale("en-US");
    });

    expect(replaced).toHaveLength(1);
    expect(replaced[0][0]).toBe("/pricing");
  });

  test("navigates even though the cookie request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { setLocale, replaced } = renderSetLocale();
    await act(async () => {
      await setLocale("en-US");
    });

    expect(replaced).toHaveLength(1);
  });

  test("writes the locale cookie before navigating", async () => {
    // Switching *to* the default locale produces a URL with no locale segment,
    // so the route-data request is resolved by the cookie alone — write it late
    // and the server redirects the switch straight back to the old locale.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    const { setLocale, cookieAtNavigation } = renderSetLocale();
    await act(async () => {
      await setLocale("en-US");
    });

    expect(cookieAtNavigation[0]).toContain("i18n-locale=en-US");
  });
});
