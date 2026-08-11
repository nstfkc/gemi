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

  show(req?: HttpRequest<any, any>) {
    return { id: this.id, got: req };
  }

  file() {
    return new File([`${this.id}`], "x.txt");
  }

  redirect(req?: HttpRequest<any, any>) {
    return { destination: `/${(req as any)?.params?.id ?? "none"}` };
  }
}

const req = { params: { id: "42" } } as unknown as HttpRequest<any, any>;

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

/**
 * `[Controller, "method"]` types the method as taking the request, and the
 * params of a route like `/post/:id` are only reachable through it. Two of the
 * four route classes called the method with nothing, so a handler that read
 * `req.params` type-checked and then threw on the first request.
 */
describe("view routes pass the request to the controller method", () => {
  test("a ViewRoute forwards the request", async () => {
    const route = new ViewRoute("Home", [CountingController, "show"]);

    const result = await route.run(req, "/");

    expect(result.Home.got).toBe(req);
  });

  test("a LayoutRoute forwards the request", async () => {
    const route = new LayoutRoute("Layout", [CountingController, "show"], {});

    const result = await route.run(req, "/");

    expect(result.Layout.got).toBe(req);
  });

  test("a RedirectRoute forwards the request", async () => {
    let seen: unknown;
    class RedirectController extends Controller {
      go(r: HttpRequest<any, any>) {
        seen = r;
        return { destination: `/${(r as any).params.id}` };
      }
    }
    const route = new RedirectRoute([RedirectController, "go"]);

    // `Redirect.to` signals by throwing, which is how the redirect reaches the
    // response — the handler has already run by then.
    await expect(route.run(req, "/")).rejects.toThrow();

    expect(seen).toBe(req);
  });

  test("a FileRoute forwards the request", async () => {
    let seen: unknown;
    class FileController extends Controller {
      download(r: HttpRequest<any, any>) {
        seen = r;
        return new File(["x"], "x.txt");
      }
    }
    const route = new FileRoute([FileController, "download"]);

    await route.run(req, "/x.txt");

    expect(seen).toBe(req);
  });
});
