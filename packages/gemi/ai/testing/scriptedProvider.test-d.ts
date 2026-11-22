import { describe, expectTypeOf, test } from "vitest";
import { type ScriptedProviderOptions, scriptedProvider } from "./scriptedProvider";

describe("scriptedProvider's exhausted (#1378)", () => {
  test("a string is a mode, so a misspelt one doesn't compile", () => {
    // @ts-expect-error — "thorw" is not a mode, and a bare string is never a reply here
    scriptedProvider([], { exhausted: "thorw" });
    // @ts-expect-error — a fixed text reply is `{ text }`
    scriptedProvider([], { exhausted: "Fine." });
    expectTypeOf<"throw">().toMatchTypeOf<NonNullable<ScriptedProviderOptions["exhausted"]>>();
    expectTypeOf<"stop">().toMatchTypeOf<NonNullable<ScriptedProviderOptions["exhausted"]>>();
  });

  test("a reply or a function step, which may still answer with a string", () => {
    scriptedProvider([], { exhausted: { text: "Fine." } });
    scriptedProvider([], { exhausted: () => "Fine." });
    scriptedProvider({ main: [] }, { exhausted: async (call) => `Hi ${call.agent}` });
  });
});
