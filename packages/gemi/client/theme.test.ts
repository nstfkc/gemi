/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { readStoredTheme, storeTheme, themeScriptSource } from "./theme";

/**
 * The inline script, run as the browser runs it: against the document, before
 * anything else (#937).
 */
function runScript(config: { cookie: string; default: string | null }) {
  new Function(themeScriptSource(JSON.stringify(config)))();
}

function prefersDark(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener() {},
    removeEventListener() {},
  }) as any;
}

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]!.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

const html = () => document.documentElement;

beforeEach(() => {
  clearCookies();
  localStorage.clear();
  html().className = "";
  html().style.colorScheme = "";
  prefersDark(false);
});

afterEach(() => {
  clearCookies();
});

describe("the theme script", () => {
  test("with nothing stored and no default, the app's own class is left alone", () => {
    html().className = "dark app-shell";
    runScript({ cookie: "theme", default: null });
    expect(html().className).toBe("dark app-shell");
    expect(html().style.colorScheme).toBe("");
  });

  test("applies the cookie's theme and touches no other class", () => {
    html().className = "light app-shell";
    document.cookie = "theme=dark; path=/";
    runScript({ cookie: "theme", default: null });
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().classList.contains("light")).toBe(false);
    expect(html().classList.contains("app-shell")).toBe(true);
    expect(html().style.colorScheme).toBe("dark");
  });

  test("a stored light replaces the app's dark, because the visitor chose it", () => {
    html().className = "dark";
    document.cookie = "theme=light; path=/";
    runScript({ cookie: "theme", default: null });
    expect(html().className).toBe("light");
  });

  test("the configured default applies when nothing is stored, and system asks the browser", () => {
    prefersDark(true);
    runScript({ cookie: "theme", default: "system" });
    expect(html().className).toBe("dark");

    html().className = "";
    prefersDark(false);
    runScript({ cookie: "theme", default: "system" });
    expect(html().className).toBe("light");
  });

  test("a choice from before the cookie, in localStorage, is still honoured", () => {
    localStorage.setItem("theme", "dark");
    runScript({ cookie: "theme", default: "light" });
    expect(html().className).toBe("dark");
  });

  test("the cookie wins over localStorage, and a value it does not know is ignored", () => {
    localStorage.setItem("theme", "light");
    document.cookie = "theme=dark; path=/";
    runScript({ cookie: "theme", default: null });
    expect(html().className).toBe("dark");

    clearCookies();
    localStorage.clear();
    html().className = "";
    document.cookie = "theme=purple; path=/";
    runScript({ cookie: "theme", default: "light" });
    expect(html().className).toBe("light");
  });

  test("reads the cookie the config names", () => {
    document.cookie = "theme=light; path=/";
    document.cookie = "ui-theme=dark; path=/";
    runScript({ cookie: "ui-theme", default: null });
    expect(html().className).toBe("dark");
  });
});

describe("storeTheme() / readStoredTheme()", () => {
  test("round-trip through the cookie, and keep localStorage in step", () => {
    storeTheme("system", "ui-theme");
    expect(document.cookie).toContain("ui-theme=system");
    expect(localStorage.getItem("theme")).toBe("system");
    expect(readStoredTheme("ui-theme")).toBe("system");
  });

  test("nothing stored is null", () => {
    expect(readStoredTheme()).toBeNull();
  });
});
