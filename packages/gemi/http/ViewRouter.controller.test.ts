import { describe, expect, test, beforeEach } from "vitest";
import {
  FileRoute,
  LayoutRoute,
  RedirectRoute,
  ViewRoute,
} from "./ViewRouter";
import { Controller } from "./Controller";
import type { HttpRequest } from "./HttpRequest";

let constructed = 0;

class CountingController extends Controller {
  readonly id: number;

  constructor() {
    super();
    this.id = ++constructed;
  }

  show() {
    return { id: this.id };
  }

  file() {
    return new File([`${this.id}`], "x.txt");
  }

  redirect() {
    return { destination: "/" };
  }
}

const req = {} as HttpRequest<any, any>;

beforeEach(() => {
  constructed = 0;
});

/**
 * The view path used to build the controller in the route handler's
 * constructor, which runs when `app/http/routes/view.ts` is evaluated — at
 * module load, before the kernel boots. That made one instance serve every
 * request (so anything a handler wrote to a field leaked between users) and it
 * put construction before the container existed, which is where a constructor
 * default like `Service.inject()` would be evaluated.
 */
describe("view routes construct their controller per request", () => {
  test("defining a route does not construct the controller", () => {
    new ViewRoute("Home", [CountingController, "show"]);
    new FileRoute([CountingController, "file"]);
    new RedirectRoute([CountingController, "redirect"]);
    new LayoutRoute("Layout", [CountingController, "show"], {});

    expect(constructed).toBe(0);
  });

  test("a ViewRoute builds a fresh instance on every run", async () => {
    const route = new ViewRoute("Home", [CountingController, "show"]);

    const first = await route.run(req, "/");
    const second = await route.run(req, "/");

    expect(constructed).toBe(2);
    expect(first.Home.id).toBe(1);
    expect(second.Home.id).toBe(2);
  });

  test("a FileRoute builds a fresh instance on every run", async () => {
    const route = new FileRoute([CountingController, "file"]);

    await route.run(req, "/x.txt");
    await route.run(req, "/x.txt");

    expect(constructed).toBe(2);
  });
});
