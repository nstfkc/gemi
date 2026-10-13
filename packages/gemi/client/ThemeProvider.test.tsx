/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { ThemeProvider, useTheme } from "./ThemeProvider";
import type { ThemeData } from "./theme";

type Listener = (event: { matches: boolean }) => void;

/** A `matchMedia` whose answer the test flips, counting live listeners. */
function fakeMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches: initial,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn().mockReturnValue(media) as any;
  return {
    listeners,
    flip(matches: boolean) {
      media.matches = matches;
      for (const fn of listeners) fn({ matches });
    },
  };
}

function View() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{String(resolved)}</span>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setTheme("system")}>
        system
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        light
      </button>
    </div>
  );
}

function withServerData(theme: ThemeData | null, children: React.ReactNode) {
  return (
    <ServerDataContext.Provider value={{ theme } as ServerDataContextValue}>
      <ThemeProvider>{children}</ThemeProvider>
    </ServerDataContext.Provider>
  );
}

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]!.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

beforeEach(() => {
  clearCookies();
  localStorage.clear();
  document.documentElement.className = "";
  fakeMedia(false);
});

afterEach(() => {
  cleanup();
  clearCookies();
});

describe("ThemeProvider", () => {
  test("starts on the theme the server read from the cookie, on both sides", () => {
    const data: ThemeData = { cookie: "theme", default: null, value: "dark" };
    expect(renderToString(withServerData(data, <View />))).toContain(">dark<");
    render(withServerData(data, <View />));
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
  });

  test("falls back to the configured default, and system resolves only in the browser", () => {
    const data: ThemeData = { cookie: "theme", default: "system", value: null };
    // The server cannot know the visitor's media query.
    expect(renderToString(withServerData(data, <View />))).toContain(">null<");
    fakeMedia(true);
    render(withServerData(data, <View />));
    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
  });

  test("setTheme writes the cookie the server reads, and the class", () => {
    document.documentElement.className = "app-shell";
    render(withServerData({ cookie: "ui-theme", default: null, value: null }, <View />));
    fireEvent.click(screen.getByText("dark"));
    expect(document.cookie).toContain("ui-theme=dark");
    expect(document.documentElement.className).toBe("app-shell dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
  });

  test("system follows the browser, and stops once the choice changes", () => {
    const media = fakeMedia(false);
    render(withServerData({ cookie: "theme", default: null, value: null }, <View />));
    fireEvent.click(screen.getByText("system"));
    expect(media.listeners.size).toBe(1);

    act(() => media.flip(true));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByTestId("resolved").textContent).toBe("dark");

    fireEvent.click(screen.getByText("light"));
    expect(media.listeners.size).toBe(0);
    act(() => media.flip(true));
    expect(document.documentElement.className).toBe("light");
  });

  test("a choice only in localStorage, from before the cookie, is picked up after mount", () => {
    localStorage.setItem("theme", "dark");
    render(withServerData({ cookie: "theme", default: null, value: null }, <View />));
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });
});
