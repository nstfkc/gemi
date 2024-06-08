import { AsyncLocalStorage } from "async_hooks";

interface RequestContext {
  // TODO: This should be prisma user model
  // Create an overridable type for user
  user: {
    id: string;
    email: string;
    name: string;
  };
}

export const requestContext = new AsyncLocalStorage<Map<string, any>>();
