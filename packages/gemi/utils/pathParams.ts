/**
 * Decode route captures after matching, so an encoded slash stays in its
 * parameter: `/notes/:id` matched against `/notes/a%2Fb` captures `a%2Fb`,
 * which decodes once to `a/b`. Null when a capture is a malformed escape.
 * API routes (#997) and view routes (#1322) share this rule. `applyParams`
 * is its inverse.
 */
export function decodePathParams(
  groups: Record<string, string | undefined>,
): Record<string, string> | null {
  const params: [string, string][] = [];
  try {
    for (const [name, value] of Object.entries(groups)) {
      if (value !== undefined) params.push([name, decodeURIComponent(value)]);
    }
  } catch {
    return null;
  }
  return Object.fromEntries(params);
}
