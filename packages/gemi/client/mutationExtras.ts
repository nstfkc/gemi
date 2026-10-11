// What the mutation hooks load on first use (#915), in one chunk: the
// `error.list()` / `error.field(name)` helpers and the cache writes behind
// `updates` and `useSetQueryData()`. See `./mutationModules`.
export { withMutationErrorHelpers } from "./mutationErrorHelpers";
export { applyQueryUpdates, writeQueryData } from "./queryUpdates";
