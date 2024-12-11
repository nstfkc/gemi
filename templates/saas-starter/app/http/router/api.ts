import {
  ApiRouter,
  Controller,
  HttpRequest,
  ResourceController,
} from "gemi/http";
// import { FileStorage, Log, Url } from "gemi/facades";
// import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { FooController, TestController } from "../controllers/FooController";
import BarController from "@/app/http/controllers/BarController";
import { TestApiRouter } from "./test";
import { FileStorage } from "gemi/facades";

class XXRouter extends ApiRouter {
  routes = {
    "/": this.get(async () => {}),
  };
}

class InlineContoller extends Controller {
  foo() {}
  list() {}
  create() {}
}

class InlineRContoller extends ResourceController {
  create() {}
  delete() {}
  list() {}
  show() {}
  update() {}
}

export default class extends ApiRouter {
  middlewares = ["cache:private"];
  routes = {
    "/bar": this.put(BarController, "test"),
    "/post": this.resource(FooController),
    "/inline/resource": this.get(InlineRContoller, "create"),
    "/test": TestApiRouter,
    "/xx": XXRouter,
    "/multi": {
      create: this.post(InlineContoller, "create"),
      list: this.get(InlineContoller, "list"),
    },
    "/image/:path*": this.file((req: HttpRequest) => {
      return FileStorage.fetch(req.params.path);
    }),
    // "/users": this.get(FooController, "index"),
    // "/home": this.get(async (req: HttpRequest<{ color: string }>) => {
    //   const input = req.search;
    //   const items = [
    //     { id: 1, name: "Red", hex: "#FF0000", color: "red" },
    //     { id: 2, name: "Green", hex: "#00FF00", color: "green" },
    //     { id: 3, name: "Blue", hex: "#0000FF", color: "blue" },
    //     { id: 4, name: "Yellow", hex: "#FFFF00", color: "yellow" },
    //     { id: 5, name: "Purple", hex: "#800080", color: "purple" },
    //   ];
    //   const filteredItems = items.filter((item) =>
    //     input.get("color")
    //       ? input.get("color").split(".").includes(item.color)
    //       : true,
    //   );

    //   return filteredItems;
    // }),

    // "/test/:testId": this.get((req: HttpRequest) => {
    //   Log.info("Hello from /test/:testId");
    //   return Url.relative("/foo/:id", { id: "enes1-1234" });
    // }),

    // "/logs": this.get(async () => {
    //   const result = await FileStorage.list("logs/");
    //   console.dir({ result: result.Contents }, { depth: 100 });
    //   return [];
    // }),

    // "/email": this.get(async () => {
    //   const result = await WelcomeEmail.send({
    //     to: ["enesxtufekci@gmail.com"],
    //     from: "Noreply <noreply@noreply.thetryhub.com>",
    //     data: { name: "Enes" },
    //   });
    //   return { success: result };
    // }),

    // "/upload": this.post(async (req: HttpRequest<{ file: Blob }>) => {
    //   const input = await req.input();
    //   await FileStorage.put(input.get("file"));
    //   return {};
    // }),
  };
}
