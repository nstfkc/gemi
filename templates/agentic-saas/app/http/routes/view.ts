import { ViewRouter } from "gemi/http";

class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
  };
}

/**
 * The signed-in half of the app. `middlewares` here guards the views below it
 * and nothing else: view routes and api routes flatten into separate tables, so
 * this says nothing about the agent's four paths. Those are guarded by the
 * explicit `.middleware({ stream, attach, stop, upload })` on `/support` in
 * `api.ts`, and dropping it there would leave the chat open however locked down
 * this router looks — a transcript is the user's mail, and an unguarded agent
 * route hands the next visitor someone else's thread.
 */
class AppRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/": this.layout("AppLayout", {
      "/chat": this.view("Chat"),
    }),
  };
}

export default class extends ViewRouter {
  routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home"),
    }),
    "/auth": AuthViewRouter,
    // The parentheses are a layout group: it nests `/chat` under `AppLayout`
    // without spending a URL segment on it, so the marketing `/` and the app's
    // `/chat` are siblings in the address bar and strangers in the tree.
    "(app)/": AppRouter,
  };
}
