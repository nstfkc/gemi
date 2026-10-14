/**
 * Splits a leading locale segment off a pathname.
 *
 * Only a whole first segment counts: `/de-DE`, `/de-DE/` and `/de-DE/about`
 * carry `de-DE`, while `/de-DE-shop` or `/delivery` (with a `de` locale) do
 * not. What is left is never empty: a locale's root URL, with or without its
 * trailing slash, is the path `/`.
 */
export function splitLocalePrefix(
  pathname: string,
  locales: readonly string[],
): { locale: string | null; pathname: string } {
  const [, first, ...rest] = pathname.split("/");
  if (first === undefined || !locales.includes(first)) {
    return { locale: null, pathname: pathname || "/" };
  }
  return { locale: first, pathname: `/${rest.join("/")}` };
}
