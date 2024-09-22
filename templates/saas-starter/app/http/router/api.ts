import { prisma } from "@/app/database/prisma";
import { ApiRouter, HttpRequest } from "gemi/http";
import { Auth, Broadcast, FileStorage } from "gemi/facades";
import { WelcomeEmail } from "@/app/email/WelcomeEmail";

export default class extends ApiRouter {
  routes = {
    "/users": this.get(async () => {
      return await prisma.user.findFirst();
    }),
    "/home": this.get(async (req: HttpRequest<{ color: string }>) => {
      const input = req.search;
      const items = [
        { id: 1, name: "Red", hex: "#FF0000", color: "red" },
        { id: 2, name: "Green", hex: "#00FF00", color: "green" },
        { id: 3, name: "Blue", hex: "#0000FF", color: "blue" },
        { id: 4, name: "Yellow", hex: "#FFFF00", color: "yellow" },
        { id: 5, name: "Purple", hex: "#800080", color: "purple" },
      ];
      const filteredItems = items.filter((item) =>
        input.get("color")
          ? input.get("color").split(".").includes(item.color)
          : true,
      );

      return filteredItems;
    }),

    "/test/:id": this.get((req: HttpRequest) => {
      return req.params.id;
    }),

    "/upload": this.post(async (req: HttpRequest<{ file: Blob }>) => {
      const input = await req.input();
      const url = await FileStorage.put(input.get("file"));
      return { url };
    }),
    "/file/:path*": this.get(async (req: HttpRequest<{ path: string }>) => {
      return await FileStorage.fetch(req.params.path);
    }),
  };
}
