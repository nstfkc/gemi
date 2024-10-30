import { HttpRequest, ViewRouter } from "gemi/http";
import { HomeController } from "../controllers/HomeController";
import { FooController } from "../controllers/FooController";
import { FileStorage } from "gemi/facades";

class AppRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/": this.layout("app/AppLayout", {
      "/": this.view("Home", [HomeController, "index"]),
      "/dashboard": this.view("Dashboard", () => {
        return { title: "Dashboard" };
      }),
    }),
  };
}

export default class extends ViewRouter {
  override routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home", [HomeController, "index"]),
      "/:testId": this.view("Test"),
      "/foo": this.view("FooList", [FooController, "index"]),
      "/foo/:id": this.view("FooEdit", [FooController, "details"]),
      "/about": this.view("About", [HomeController, "about"]),
      "/log": this.view("Logs", async () => {
        const result = await FileStorage.list("logs/");
        return { files: result.Contents.map((content) => content.Key) };
      }),
      "/log/:filePath*": this.view("Log", async (req: HttpRequest) => {
        const response = await FileStorage.fetch(`logs/${req.params.filePath}`);
        const logs = await response.text();
        const lines = logs
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));

        return { lines };
      }),
    }),
    "/app": AppRouter,
  };
}
