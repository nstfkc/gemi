export function applyParams<T extends string>(
  url: T,
  params: Record<string, string | number | undefined>,
): string {
  return url
    .replace(/:([^/]+)/g, (_, key) => {
      const isOptional = key.endsWith("?");
      const paramName = isOptional ? key.slice(0, -1) : key;
      const value = params[paramName];

      if (value === undefined) {
        if (isOptional) {
          return ""; // Remove the optional segment if no value is provided
        }
        throw new Error(`Missing parameter: ${paramName}`);
      }

      return String(value);
    })
    .replace(/\/\//g, "/"); // Remove any double slashes caused by optional parameters
}
