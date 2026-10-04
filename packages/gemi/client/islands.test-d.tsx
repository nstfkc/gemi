import { expectTypeOf, test } from "vitest";

import { island } from "./islands";

declare const mod: {
  default: (props: { start: number; label: string }) => null;
  Greeting: (props: { name: string }) => null;
};
const load = () => Promise.resolve(mod);

test("island() returns the component it wraps, typed by its props", () => {
  const Counter = island(load);
  expectTypeOf<Parameters<typeof Counter>[0]>().toEqualTypeOf<{ start: number; label: string }>();

  const Greeting = island(load, { export: "Greeting", load: "visible" });
  expectTypeOf<Parameters<typeof Greeting>[0]>().toEqualTypeOf<{ name: string }>();

  // @ts-expect-error: not an export of the module
  island(load, { export: "Nope" });
  // @ts-expect-error: not a load strategy
  island(load, { load: "soon" });
});
