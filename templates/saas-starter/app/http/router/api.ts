import { prisma } from "@/app/database/prisma";
import { ApiRouter, HttpRequest, ResourceController } from "gemi/http";
import { FileStorage } from "gemi/facades";
import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { FooController } from "../controllers/FooController";

class BarController extends ResourceController {
  create() {}
  delete() {}
  list() {}
  show() {}
  update() {}
}

class BarRouter extends ApiRouter {
  routes = {
    "/": this.resource(BarController),
  };
}

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

    "/test/:testId": this.get((req: HttpRequest) => {
      return `${req.params.testId}`;
    }),

    "/email": this.get(async () => {
      const result = await WelcomeEmail.send({
        to: ["enesxtufekci@gmail.com"],
        data: { name: "Enes" },
      });
      return { success: result };
    }),

    "/upload": this.post(async (req: HttpRequest<{ images: Blob[] }>) => {
      const input = await req.input();
      console.log(input.get("images"));
      return {};
    }),
    "/bar": BarRouter,
    "/foo-bar-baz": this.resource(FooController),
    "/file/:path*": this.get(async (req: HttpRequest<{ path: string }>) => {
      return await FileStorage.fetch(req.params.path);
    }),
    "/invite": this.get(async () => {
      return await prisma.organizationInvitation.create({
        data: {
          email: "enesxtufekci+2@gmail.com",
          organizationId: 1,
          role: 0,
        },
      });
    }),
    "/organization": this.get(async () => {
      return await prisma.organization.create({
        data: {
          name: "Enes org",
        },
      });
    }),
  };
}
