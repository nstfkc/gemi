import { prisma } from "@/app/database/prisma";
import { ApiRouter, HttpRequest } from "gemi/http";
import { Storage } from "gemi/storage";

export default class extends ApiRouter {
  routes = {
    "/users": this.get(async () => {
      prisma.user.createMany;
      const users = await prisma.user.findMany();
      return {
        users,
      };
    }),

    "/file": this.post(async (req: HttpRequest<{ file: Blob }>) => {
      const input = await req.input();
      const file = input.get("file");
      const { width = 0, height = 0 } = await Storage.metadata(file);

      return { width, height, type: file.type, size: file.size };

      // const data = await Storage.put(file);

      return { data };
    }),
  };
}
