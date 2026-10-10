/**
 * Type-level tests for the channel hooks' types, against a `BroadcastRPC`
 * table built the way `gemi.d.ts` builds the app's. Every `@ts-expect-error`
 * is a mistake that must not compile.
 */
import { describe, expectTypeOf, test } from "vitest";

import { ChannelRouter, type CreateBroadcastRPC } from "../http/ChannelRouter";
import type {
  ChannelEventsFor,
  ChannelParamsFor,
  ChannelPattern,
  LiveChannel,
  UseChannelConfig,
} from "./useChannel";

class Channels extends ChannelRouter {
  channels = {
    "site.:siteId": this.private(() => true).events<{ changed: { pages: string[] } }>(),
    status: this.public(),
    user: this.private(),
  };
}

type Table = CreateBroadcastRPC<Channels>;

describe("channel hook types", () => {
  test("patterns are the router's keys; any string without a router", () => {
    expectTypeOf<ChannelPattern<Table>>().toEqualTypeOf<"site.:siteId" | "status" | "user">();
    expectTypeOf<ChannelPattern<{}>>().toEqualTypeOf<string>();
  });

  test("params come from the pattern", () => {
    expectTypeOf<ChannelParamsFor<"site.:siteId", Table>>().toEqualTypeOf<{
      siteId: string | number;
    }>();
    expectTypeOf<ChannelParamsFor<"user", Table>>().toEqualTypeOf<{}>();
    const ok: ChannelParamsFor<"site.:siteId", Table> = { siteId: "abc" };
    // @ts-expect-error a param the pattern does not have
    const bad: ChannelParamsFor<"site.:siteId", Table> = { pageId: "abc" };
    void ok;
    void bad;
  });

  test("on handlers are typed by the channel's events", () => {
    const config: UseChannelConfig<ChannelEventsFor<"site.:siteId", Table>> = {
      on: {
        changed: (data) => {
          expectTypeOf(data).toEqualTypeOf<{ pages: string[] }>();
        },
      },
    };
    const wrong: UseChannelConfig<ChannelEventsFor<"site.:siteId", Table>> = {
      // @ts-expect-error an event the channel does not carry
      on: { deleted: () => {} },
    };
    void config;
    void wrong;
    // Untyped channels take any event.
    expectTypeOf<ChannelEventsFor<"status", Table>>().toEqualTypeOf<Record<string, unknown>>();
  });

  test("live takes a pattern, a tuple or an object", () => {
    const a: LiveChannel = "user";
    const b: LiveChannel = ["site.:siteId", { siteId: "abc" }];
    const c: LiveChannel = { channel: "status" };
    void a;
    void b;
    void c;
  });
});
