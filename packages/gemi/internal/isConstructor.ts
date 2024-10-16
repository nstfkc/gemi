export function isConstructor(value: any) {
  return typeof value === "function" && typeof value.constructor === "function";
}
