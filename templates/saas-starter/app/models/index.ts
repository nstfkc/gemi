// The application's own model classes, in one place.
//
// `app/kernel/Kernel.ts` lists this module in `models`, and `Kernel.boot()`
// registers everything it exports under the name each class's schema carries —
// so a subclass added here owns its name without anybody writing a `register`
// line for it, and a policy on it applies inside nested `include`s as well as at
// the root.
//
// That is the whole reason this file exists rather than each model registering
// itself. Forgetting to register a policied subclass does not fail: the
// generated base keeps the name, every nested read of the model comes back
// unscoped, and nothing raises. Adding a model to this barrel is a step you can
// notice missing; a `register` call scattered across thirteen files is not.
export { User } from "./User";
export { FeatureFlag } from "./FeatureFlag";
