import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { island } from "./islands";

/**
 * `gemi/vitest`'s `gemiIslandPlugin` (in this package's `vitest.config.ts`,
 * as in an app's): `island(() => import(…))` gets the same module key as the
 * build, and the module is imported statically (#795).
 */

const Counter = island(() => import("../services/router/__fixtures__/islands/Counter"));
const Greeting = island(() => import("../services/router/__fixtures__/islands/Counter"), {
  export: "Greeting",
});

describe("island() under vitest with gemiIslandPlugin", () => {
  test("carries the module's build key", () => {
    expect(Counter.displayName).toBe("island(services/router/__fixtures__/islands/Counter.tsx)");
    expect(Greeting.displayName).toBe(
      "island(services/router/__fixtures__/islands/Counter.tsx#Greeting)",
    );
  });

  test("renders in place synchronously, as in a hydrated view", () => {
    expect(renderToString(<Greeting name="Ada" />)).toBe("<p>Hello, <!-- -->Ada</p>");
    expect(renderToString(<Counter start={2} label="n" />)).toContain("<output");
  });
});
