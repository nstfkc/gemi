/**
 * The theme a visitor picked, shared by the server (which reads it from a
 * cookie and renders the inline script) and the browser (`ThemeProvider`).
 *
 * gemi owns the `light`/`dark` classes on `<html>` only while it has a theme
 * to apply: the visitor's stored choice or `ViewRouteConfig.theme.default`.
 * With neither, it leaves `<html>` alone, so an app that sets its own class
 * before paint keeps it (#937).
 */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** The cookie gemi stores the choice in unless `theme.cookie` names another. */
export const DEFAULT_THEME_COOKIE = "theme";

/** What the server hands the browser in `__GEMI_DATA__.theme`. */
export type ThemeData = {
  /** The cookie the choice lives in. */
  cookie: string;
  /** `theme.default`, or `null` when the app set none. */
  default: Theme | null;
  /** The visitor's choice, read from the cookie on the server. */
  value: Theme | null;
};

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** `"system"` asks the browser; the other two are already resolved. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/**
 * Puts `resolved` on `<html>`: the class, and `color-scheme` for the browser's
 * own widgets. Removes only the other theme class, never anything else.
 */
export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.remove(resolved === "dark" ? "light" : "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

/** One year: the choice should outlive the session, as `localStorage` did. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Stores the choice where both the server and the inline script read it: the
 * cookie. `localStorage` is still written, so a page from an older build that
 * only reads storage agrees with this one.
 */
export function storeTheme(theme: Theme, cookie: string = DEFAULT_THEME_COOKIE): void {
  try {
    document.cookie = `${cookie}=${theme}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  } catch {}
  try {
    localStorage.setItem("theme", theme);
  } catch {}
}

/** The stored choice in the browser: the cookie, else the legacy `localStorage` key. */
export function readStoredTheme(cookie: string = DEFAULT_THEME_COOKIE): Theme | null {
  try {
    for (const part of document.cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== cookie) continue;
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      if (isTheme(value)) return value;
    }
  } catch {}
  try {
    const value = localStorage.getItem("theme");
    if (isTheme(value)) return value;
  } catch {}
  return null;
}

/**
 * The inline script the server renders before the body, so the class is right
 * before first paint. It does what `readStoredTheme` + `applyTheme` do, kept
 * in one self-contained statement because it runs before any module loads.
 * `config` is JSON-encoded by the caller (`htmlSafeJson`), never interpolated
 * raw.
 */
export function themeScriptSource(configJson: string): string {
  return `!function(o){try{var e=null,d=document.documentElement,c=d.classList,k=document.cookie.split(';'),i,j,v;
for(i=0;i<k.length;i++){j=k[i].indexOf('=');if(j>0&&k[i].slice(0,j).trim()===o.cookie){v=decodeURIComponent(k[i].slice(j+1).trim());break}}
if(v!=='light'&&v!=='dark'&&v!=='system'){try{v=localStorage.getItem('theme')}catch(x){}}
if(v==='light'||v==='dark'||v==='system')e=v;else e=o.default;
if(!e)return;
if(e==='system')e=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
c.remove(e==='dark'?'light':'dark');c.add(e);d.style.colorScheme=e}catch(x){}}(${configJson})`;
}
