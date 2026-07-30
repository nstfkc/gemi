/**
 * Turn a shared-cache directive into a per-visitor one, leaving the rest of the
 * header (`max-age`, `must-revalidate`, ...) alone. `s-maxage` only applies to
 * shared caches, so it goes too.
 *
 * Rendered HTML embeds a route manifest scoped to who is asking, so a response
 * built for a signed-in visitor must never be reused for an anonymous one.
 */
export function downgradePublicCacheControl(headers: Headers) {
  const cacheControl = headers.get("Cache-Control");
  if (!cacheControl) {
    return;
  }

  const directives = cacheControl
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => !/^s-maxage=/i.test(directive));

  if (directives.some((directive) => /^private$/i.test(directive))) {
    headers.set("Cache-Control", directives.join(", "));
    return;
  }

  const publicIndex = directives.findIndex((directive) => /^public$/i.test(directive));
  if (publicIndex === -1) {
    directives.unshift("private");
  } else {
    directives[publicIndex] = "private";
  }

  headers.set("Cache-Control", directives.join(", "));
}
