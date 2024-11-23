import { prisma } from "@/app/database/prisma";
import { ApiRouter, HttpRequest, ResourceController } from "gemi/http";
import { FileStorage, Log, Url } from "gemi/facades";
import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { FooController } from "../controllers/FooController";
import { Job } from "gemi/services";
import { TestJob } from "@/app/jobs/TestJob";

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
  middlewares = ["cache:private"];
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
      Log.info("Hello from /test/:testId");
      return Url.relative("/foo/:id", { id: "enes1-1234" });
    }),

    "/csrf": this.post(async (req: HttpRequest) => {
      return {};
    }).middleware(["csrf"]),
  };
}
