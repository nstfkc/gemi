export function applyTranslationParams<T extends string>(
  str: T,
  params: Record<string, string>,
): string {
  return str.replace(/{{([^}]+)}}/g, (_, key) => {
    const value = params[key];

    if (value === undefined) {
      throw new Error(`Missing parameter: ${key}`);
    }

    return value;
  });
}
