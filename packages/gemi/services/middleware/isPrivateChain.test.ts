import { describe, test, expect } from "vitest";
import { MiddlewareServiceContainer } from "./MiddlewareServiceContainer";
import { MiddlewareServiceProvider } from "../../http/MiddlewareServiceProvider";
import { Middleware } from "../../http/Middleware";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import { CacheMiddleware } from "../../http/CacheMiddleware";

class TenantMiddleware extends Middleware {
  static isPrivate = true;
}

class Provider extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    tenant: TenantMiddleware,
  } as any;
}

const container = new MiddlewareServiceContainer(new Provider());

describe("isPrivateChain()", () => {
  test("an auth-gated chain is private regardless of what else is on it", () => {
    expect(container.isPrivateChain(["cache:public,12840", "auth"])).toBe(true);
  });

  test("a chain with no auth-gating middleware is public", () => {
    expect(container.isPrivateChain(["cache:public,12840"])).toBe(false);
    expect(container.isPrivateChain([])).toBe(false);
  });

  test("cancelling the alias with `-auth` makes the route public again", () => {
    expect(container.isPrivateChain(["auth", "-auth"])).toBe(false);
    // Order matters the same way it does when the chain actually runs.
    expect(container.isPrivateChain(["-auth", "auth"])).toBe(true);
  });

  test("an unregistered alias resolves to nothing, exactly like at request time", () => {
    expect(container.isPrivateChain(["not-a-real-alias"])).toBe(false);
  });

  test("params on the alias don't hide it", () => {
    expect(container.isPrivateChain(["auth:admin"])).toBe(true);
  });

  test("any middleware can opt in with the static flag", () => {
    expect(container.isPrivateChain(["tenant"])).toBe(true);
  });

  test("a middleware class passed inline is resolved too", () => {
    expect(container.isPrivateChain([AuthenticationMiddleware])).toBe(true);
    expect(container.isPrivateChain([CacheMiddleware])).toBe(false);
  });

  test("`configure()` subclasses inherit the flag", () => {
    expect(container.isPrivateChain([AuthenticationMiddleware.configure({})])).toBe(true);
  });
});
