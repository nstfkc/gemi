/**
 * Shallow-merges an app config slice over the framework defaults, ignoring keys
 * whose value is `undefined`.
 *
 * A plain `{ ...defaults, ...config }` lets an explicit `undefined` win — a
 * `defineMailConfig({ headers: undefined })`, or any optional property the app
 * spread in from another object, would erase the default and hand the service a
 * missing dependency. Omitting a key and setting it to `undefined` mean the
 * same thing for a config slice, so both fall back to the default here.
 */
export function withDefaults<T extends object>(
  defaults: Required<T>,
  config: Partial<T> | undefined,
): Required<T>;
export function withDefaults<D extends object, C extends object>(
  defaults: D,
  config: C | undefined,
): D & C;
export function withDefaults(
  defaults: Record<string, any>,
  config: Record<string, any> | undefined,
) {
  const merged: Record<string, any> = { ...defaults };
  if (!config) {
    return merged;
  }
  for (const key of Object.keys(config)) {
    if (config[key] !== undefined) {
      merged[key] = config[key];
    }
  }
  return merged;
}
