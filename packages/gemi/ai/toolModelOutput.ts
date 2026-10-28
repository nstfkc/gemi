/**
 * A tool's `toModel` projection of one successful output (#1061), or
 * `undefined` when the tool has none, or it threw (reported to `onError`), or
 * it answered `undefined`. Normalised to JSON, the form it is stored and
 * replayed in, so the model reads the same text on every request.
 */
export function modelOutputOf(
  tool: { toModel?: (output: any) => unknown } | undefined,
  output: unknown,
  onError: (error: unknown) => void,
): unknown {
  if (!tool?.toModel) return undefined;
  try {
    const projected = tool.toModel(output);
    if (projected === undefined || typeof projected === "string") return projected;
    if (typeof (projected as { then?: unknown }).then === "function") {
      // An async `toModel` would reach the model as `{}`: refused, so the
      // model reads the whole output and the log says why.
      (projected as Promise<unknown>).then(undefined, () => {});
      throw new TypeError("toModel returned a promise; it must return its value synchronously.");
    }
    return JSON.parse(JSON.stringify(projected));
  } catch (error) {
    onError(error);
    return undefined;
  }
}
