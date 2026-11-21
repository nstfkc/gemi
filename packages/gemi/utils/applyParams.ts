/**
 * One path parameter as it goes into a URL. Route params arrive decoded
 * (#1306, #1322), so every value is `encodeURIComponent`-ed and a `/` or `%`
 * in it stays in its segment: `{ id: "a/b" }` fills `:id` as `a%2Fb`. A
 * wildcard (`:path*`) keeps its `/`s and encodes each segment, as `apiUrl`
 * does, so `{ path: "a/b c" }` fills `:path*` as `a/b%20c`.
 */
export function encodeParam(value: string | number, wildcard = false): string {
  const text = String(value);
  return wildcard ? text.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(text);
}

export function applyParams<T extends string>(
  url: T,
  params: Record<string, string | number | undefined>,
): string {
  return (
    url
      .replace(/:([^/]+[*?]?)/g, (_, key) => {
        const hasSuffix = key.endsWith("?") || key.endsWith("*");
        const paramName = hasSuffix ? key.slice(0, -1) : key;
        const value = params[paramName];

        if (value === undefined) {
          if (hasSuffix) {
            return ""; // Remove the optional segment if no value is provided
          }
          // @ts-ignore
          if (import.meta.env.DEV) {
            throw new Error(`Missing parameter: ${paramName}`);
          }
          console.error(`Missing parameter: ${paramName} in URL: ${url}`);
          return String(value);
        }

        return encodeParam(value, key.endsWith("*"));
      })
      // remove double slashes
      .replace(/\/\//g, "/")
      // remove trailing slash
      .replace(/\/$/, "")
  );
}
