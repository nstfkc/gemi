export function isConstructor(value: any) {
  return typeof value === "function" && value.prototype !== undefined;
}
