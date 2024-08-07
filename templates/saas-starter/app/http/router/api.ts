import { prisma } from "@/app/database/prisma";
import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  middlewares = ["auth"];
  routes = {
    "/users": this.get(async () => {
      prisma.user.createMany;
      const users = await prisma.user.findMany();
      return {
        users,
      };
    }),
  };
}
