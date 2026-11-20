// What the mutation hooks load on first use (#915), in one chunk: the
// `error.list()` / `error.field(name)` helpers, the cache writes behind
// `updates` and `useSetQueryData()`, and invalidation by key (#1329). See
// `./mutationModules`.
export { withMutationErrorHelpers } from "./mutationErrorHelpers";
export { applyQueryUpdates, invalidateQueries, writeQueryData } from "./queryUpdates";
