export function toCamelCase(input: string) {
  return input.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
}
