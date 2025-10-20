export function applyParams<T extends string>(
  url: T,
  params: Record<string, string | number | undefined>,
): string {
  return url
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
      }

      return String(value);
    })
    .replace(/\/\//g, "/"); // Remove any double slashes caused by optional parameters
}
