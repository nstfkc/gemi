import { ModelNotRegisteredError } from "./errors";

/**
 * Name-keyed, resolved at call time, never at module load.
 *
 * The generated schema refers to a relation's target by model *name*, not by
 * importing the class. Without that indirection `User.ts` imports `Post.ts`
 * imports `User.ts` and, under ESM, one of them is `undefined` while the other
 * is still evaluating. It is the classic ORM bootstrap failure and it shows up
 * the moment two models reference each other — which, in any real schema, is
 * immediately.
 *
 * It also keeps the generated files free of an import graph: they hold data and
 * strings only.
 */
const models = new Map<string, unknown>();

export function register(name: string, model: unknown): void {
  models.set(name, model);
}

export function has(name: string): boolean {
  return models.has(name);
}

export function get<T = unknown>(name: string): T {
  const model = models.get(name);
  if (model === undefined) {
    throw new ModelNotRegisteredError(name, [...models.keys()]);
  }
  return model as T;
}

export function registeredNames(): string[] {
  return [...models.keys()];
}

export function clearRegistry(): void {
  models.clear();
}
