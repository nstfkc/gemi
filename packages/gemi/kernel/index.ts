export { Kernel } from "./Kernel";
export { frameworkProviders } from "./providers";

export { PrismaAuthenticationAdapter } from "../auth/adapters/prisma";
// The ORM-backed adapter ships *alongside* the Prisma one, not instead of it:
// both satisfy `IAuthenticationAdapter`, so an application picks one and nothing
// else in `auth/` knows which. That is what lets an app migrate when it chooses.
export {
  OrmAuthenticationAdapter,
  ormAuthenticationAdapter,
  type AuthModels,
} from "../auth/adapters/orm";
