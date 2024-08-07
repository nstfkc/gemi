import { Prisma } from "@prisma/client";
import { KernelContext } from "../kernel/KernelContext";
import { InsufficientPermissionsError } from "../http/errors";

export const prismaExtension = Prisma.defineExtension({
  name: "Gemi Policies",

  query: {
    async $allOperations({ args, operation, query, model }) {
      const provider = KernelContext.getStore().policiesServiceProvider;

      const policies = provider.policiesList[`${model}Policies`];

      if (!policies) {
        return await query(args);
      }

      const isPassed = await policies.all.call(policies, operation, args);
      if (!isPassed) {
        throw new InsufficientPermissionsError();
      }

      return await query(args);
    },
  },
});
