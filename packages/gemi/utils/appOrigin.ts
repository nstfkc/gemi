/**
 * The app's public origin as configured: `HOST_NAME`, else `APP_URL`, trimmed
 * and without a trailing `/`. `undefined` when neither is set.
 *
 * `HOST_NAME` comes first because it is the variable gemi has always read, so
 * an app that sets it gets the same value it always did. Read on every call,
 * never cached, so a test that stubs the environment sees its value at once.
 *
 * No validation here: gemi's own call sites keep their behaviour when the value
 * is unset or odd. `Url.origin()` is the checked accessor.
 */
export function configuredAppOrigin(): string | undefined {
  for (const name of ["HOST_NAME", "APP_URL"] as const) {
    const value = process.env[name]?.trim();
    if (value) {
      return value.replace(/\/+$/, "");
    }
  }
  return undefined;
}

/**
 * `configuredAppOrigin()`, required to be an absolute http(s) URL. Falls back
 * to `fallback` when nothing is configured; throws when there is no fallback
 * either, or when the configured value is not such a URL.
 */
export function appOrigin(fallback?: string): string {
  const configured = configuredAppOrigin();
  const source = configured === undefined ? "fallback" : process.env.HOST_NAME?.trim() ? "HOST_NAME" : "APP_URL";
  const value = configured ?? fallback?.trim().replace(/\/+$/, "");
  if (!value) {
    throw new Error(
      "The app's public origin is not configured: set HOST_NAME (or APP_URL), e.g. HOST_NAME=https://example.com.",
    );
  }
  const protocol = URL.canParse(value) ? new URL(value).protocol : null;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      `The app's public origin from ${source} (${JSON.stringify(value)}) is not an absolute http(s) URL, e.g. https://example.com.`,
    );
  }
  return value;
}
