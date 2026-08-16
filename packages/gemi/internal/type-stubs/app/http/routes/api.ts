import { ApiRouter } from "../../../../../http/ApiRouter";

/**
 * What `@/app/*` resolves to when the *package* typechecks itself.
 *
 * `gemi.d.ts` is written for an application, so it imports the application's
 * routers through the `@/app/*` alias. Referencing it from `client/index.ts`
 * pulls it into this package's own compilation too, where that alias has
 * nothing to point at — and `CreateRPC` over an unresolved import is a
 * TS2589 "excessively deep" in `client/rpc.ts`, not a quiet `any`.
 *
 * So the package maps the alias at an empty router. The augmentation still
 * applies here, it just contributes nothing, which is the correct answer for a
 * compilation that has no application in it.
 */
export default class extends ApiRouter {
  routes = {};
}
