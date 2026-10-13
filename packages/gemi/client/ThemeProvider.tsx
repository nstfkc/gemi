import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import { ServerDataContext } from "./ServerDataProvider";
import {
  applyTheme,
  DEFAULT_THEME_COOKIE,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ResolvedTheme,
  type Theme,
} from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

type ThemeContextValue = {
  /** The visitor's choice, `"system"` included. */
  theme: Theme;
  /**
   * What `theme` comes out as: `"light"` or `"dark"`. `null` while `"system"`
   * has not been asked of the browser yet — on the server, and in the first
   * render on the client, so hydration matches.
   */
  resolved: ResolvedTheme | null;
  /** Applies the theme to `<html>` and stores it in the theme cookie. */
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  resolved: "light",
  setTheme: () => {},
});

function initialResolved(theme: Theme): ResolvedTheme | null {
  return theme === "system" ? null : theme;
}

export const ThemeProvider = (props: {
  children: ReactNode;
  /**
   * The theme to start on, ahead of the stored one. The app leaves this unset —
   * a visitor's choice comes from the theme cookie, read by the server — but a
   * test has no browser session to have made that choice in, so
   * `gemi/testing`'s `<Page>` passes it through to render a component in a
   * theme without writing to storage.
   */
  theme?: Theme;
}) => {
  // The server's reading of the cookie, so the first client render matches
  // the server's instead of reading storage the server could not see.
  const data = useContext(ServerDataContext)?.theme;
  const cookie = data?.cookie ?? DEFAULT_THEME_COOKIE;
  const [theme, setThemeState] = useState<Theme>(
    () => props.theme ?? data?.value ?? data?.default ?? "light",
  );
  const [resolved, setResolved] = useState<ResolvedTheme | null>(() => initialResolved(theme));

  // A choice the server could not read (one only in `localStorage`, from
  // before the cookie) is picked up once mounted. Mount only: later changes
  // go through `setTheme`.
  useEffect(() => {
    if (props.theme || data?.value) return;
    const stored = readStoredTheme(cookie);
    if (stored && stored !== theme) {
      setThemeState(stored);
      setResolved(initialResolved(stored));
    }
  }, []);

  // `"system"` follows the browser, for as long as it is the choice.
  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_QUERY);
    setResolved(resolveTheme("system", media.matches));
    const onChange = ({ matches }: { matches: boolean }) => {
      const next = resolveTheme("system", matches);
      setResolved(next);
      applyTheme(document.documentElement, next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = (next: Theme) => {
    const prefersDark =
      typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
    const nextResolved = resolveTheme(next, prefersDark);
    setThemeState(next);
    setResolved(nextResolved);
    storeTheme(next, cookie);
    applyTheme(document.documentElement, nextResolved);
  };

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {props.children}
    </ThemeContext.Provider>
  );
};

/**
 * The visitor's theme: `theme` (their choice), `resolved` (`"light"` or
 * `"dark"`, `null` until `"system"` is known) and `setTheme`, which applies it
 * to `<html>` and stores it in the theme cookie the server reads.
 */
export function useTheme() {
  return useContext(ThemeContext);
}
