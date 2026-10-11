import { expectTypeOf, test } from "vitest";

import { HttpRequest } from "./HttpRequest";
import { type StateKey, stateKey } from "./requestState";

type Scope = { kind: "site"; siteId: string };
const scope = stateKey<Scope>("scope");

test("req.state is typed by the key (#887)", () => {
  const req = new HttpRequest(new Request("http://gemi.dev/"));

  expectTypeOf(scope).toEqualTypeOf<StateKey<Scope>>();
  expectTypeOf(req.state.get(scope)).toEqualTypeOf<Scope | undefined>();
  expectTypeOf(req.state.require(scope)).toEqualTypeOf<Scope>();
  expectTypeOf(req.state.set(scope, { kind: "site", siteId: "s1" })).toEqualTypeOf<Scope>();
  // @ts-expect-error a number is not a Scope
  req.state.set(scope, 1);
  // @ts-expect-error a Scope needs its siteId
  req.state.set(scope, { kind: "site" });
  // @ts-expect-error the value does not widen the key's type
  req.state.set(scope, { kind: "post", siteId: "s1" });
});
