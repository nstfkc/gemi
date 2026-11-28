/**
 * The dev log line for an error a view's boundary caught (#1407).
 *
 * `console.error(error)` alone was all the root logged, and what reached the
 * console was sometimes `{}`: a thrown value that is not an `Error` (a plain
 * object, an `Event`) or an `Error` passed through anything that serialises
 * with `JSON.stringify`, which drops `name`, `message` and `stack`. This puts
 * them in a string, which survives every console and log capture.
 */
export function describeCaughtError(error: unknown, componentStack?: string | null): string {
  const lines = [`[gemi] A view threw, and its error boundary is showing: ${describe(error)}`];
  if (error instanceof Error && error.stack) lines.push(error.stack);
  if (error instanceof Error && error.cause !== undefined) {
    lines.push(`Caused by: ${describe(error.cause)}`);
  }
  if (componentStack) lines.push(`Component stack:${componentStack}`);
  return lines.join("\n");
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null || value === undefined) return `${String(value)} (nothing was thrown with it)`;
  if (typeof value !== "object") return `${typeof value} ${String(value)}`;
  const kind = value.constructor?.name ?? "Object";
  // Own names, not `Object.keys`: an `Event`'s and a DOMException's fields are
  // getters or non-enumerable, which is how they print as `{}`.
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const name of [...Object.getOwnPropertyNames(value), ...knownFields(value)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    fields.push(`${name}: ${preview((value as Record<string, unknown>)[name])}`);
  }
  return fields.length > 0 ? `${kind} { ${fields.join(", ")} }` : `${kind} {} (no own fields)`;
}

/** What an `Event` and friends carry on their prototype. */
function knownFields(value: object): string[] {
  return ["type", "message", "code", "status", "reason"].filter(
    (name) => name in value && (value as Record<string, unknown>)[name] !== undefined,
  );
}

function preview(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "function") return "[function]";
  if (value !== null && typeof value === "object") return `[${value.constructor?.name ?? "Object"}]`;
  return String(value);
}
