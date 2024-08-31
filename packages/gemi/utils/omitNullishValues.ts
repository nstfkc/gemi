export function omitNullishValues<T>(input: T) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      return value !== null && value !== undefined;
    }),
  ) as T;
}
