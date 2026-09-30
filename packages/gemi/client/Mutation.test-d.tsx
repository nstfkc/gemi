import type { ComponentProps } from "react";
import { describe, expectTypeOf, test } from "vitest";

import { Form } from "./Mutation";

type Props = Parameters<typeof Form<never, "POST">>[0];

/**
 * `onSubmit` used to be accepted and then silently dropped gemi's handler, so
 * the type is part of the contract: it is still the native event handler, and
 * the lifecycle hooks are typed so a stray return value is caught.
 */
describe("Form lifecycle props", () => {
  test("onSubmit is the native form event handler", () => {
    expectTypeOf<Props["onSubmit"]>().toEqualTypeOf<
      ComponentProps<"form">["onSubmit"]
    >();
  });

  test("onSubmitStart gets the FormData and the form, and may return false", () => {
    type Start = NonNullable<Props["onSubmitStart"]>;
    expectTypeOf<Start>().parameters.toEqualTypeOf<
      [FormData, HTMLFormElement]
    >();
    expectTypeOf<() => false>().toExtend<Start>();
    expectTypeOf<() => undefined>().toExtend<Start>();
    // @ts-expect-error a string is not a cancel signal
    const start: Start = () => "no";
    void start;
  });

  test("onSettled gets the form", () => {
    expectTypeOf<NonNullable<Props["onSettled"]>>().parameters.toEqualTypeOf<
      [HTMLFormElement]
    >();
  });
});
