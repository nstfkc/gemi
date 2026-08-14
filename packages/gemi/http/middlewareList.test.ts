import { describe, expect, test } from "vitest";
import { ViewRouter } from "./ViewRouter";
import { toMiddlewareList } from "./middlewareList";

describe("toMiddlewareList", () => {
  test("wraps a bare string", () => {
    expect(toMiddlewareList("auth")).toEqual(["auth"]);
  });

  test("passes an array through", () => {
    expect(toMiddlewareList(["auth", "cache:private"])).toEqual(["auth", "cache:private"]);
  });

  test("keeps alias parameters intact", () => {
    expect(toMiddlewareList("rate-limit:60,1")).toEqual(["rate-limit:60,1"]);
  });

  test("an empty array stays empty", () => {
    expect(toMiddlewareList([])).toEqual([]);
  });
});

describe("route .middleware()", () => {
  /**
   * The regression: a bare string was assigned straight to `middlewares`, and
   * everything downstream iterates that value. Iterating a string yields
   * characters, so `"auth"` became the aliases `a`, `u`, `t`, `h` — none of
   * which resolve, all of which are dropped. The route was public and nothing
   * reported it.
   */
  const router = new ViewRouter();

  test("a string becomes a one-element list, not a list of characters", () => {
    const route = router.view("Test").middleware("cache:private");

    expect(route.middlewares).toEqual(["cache:private"]);
    expect(route.middlewares).not.toContain("c");
    expect(route.middlewares).toHaveLength(1);
  });

  test("an array is unchanged", () => {
    const route = router.view("Test").middleware(["auth", "cache:private"]);

    expect(route.middlewares).toEqual(["auth", "cache:private"]);
  });

  test("layout routes normalize too", () => {
    const route = router.layout("Layout", {}).middleware("auth");

    expect(route.middlewares).toEqual(["auth"]);
  });

  test("redirect routes normalize too", () => {
    const route = router.redirect(() => ({})).middleware("auth");

    expect((route as any).middlewares).toEqual(["auth"]);
  });

  test("file routes normalize too", () => {
    const route = router.file(() => ({}) as any).middleware("auth");

    expect(route.middlewares).toEqual(["auth"]);
  });
});
