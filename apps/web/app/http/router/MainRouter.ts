import { Router } from "@/framework/Router";

import { HomeController } from "../controllers/HomeController";

export class MainRouter extends Router {
  public routes = {
    "/foo": Router.get(() => {
      return new Response(JSON.stringify({ message: "Hello, Enes" }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
    "/home": Router.view([HomeController, "index", "Home"]),
    "/layout": Router.layout("Layout", {
      "/foo": [HomeController, "foo", "Foo"],
    }),
  };
}
