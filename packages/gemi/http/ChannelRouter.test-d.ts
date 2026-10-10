/**
 * Type-level tests for `CreateBroadcastRPC` and the `Broadcast` facade's
 * params. Every `@ts-expect-error` is a mistake that must not compile.
 *
 * Run with `bun run typecheck` (or `bun run test:types`).
 */
import { describe, expectTypeOf, test } from "vitest";

import { Broadcast } from "../facades/Broadcast";
import { BroadcastEvent } from "../services/broadcast/BroadcastEvent";
import type { ChannelParams } from "../services/broadcast/channels";
import { ChannelRouter, type CreateBroadcastRPC } from "./ChannelRouter";

class SiteChanged extends BroadcastEvent<{ pages: string[] }, "changed"> {
  static name = "SiteChanged";
  broadcastOn() {
    return "status";
  }
  broadcastAs() {
    return "changed" as const;
  }
}

class SiteDeleted extends BroadcastEvent<undefined, "deleted"> {
  static name = "SiteDeleted";
  broadcastOn() {
    return "status";
  }
  broadcastAs() {
    return "deleted" as const;
  }
}

class Channels extends ChannelRouter {
  channels = {
    "site.:siteId": this.private(() => true).events(SiteChanged, SiteDeleted),
    "org.:orgId.page.:pageId": this.private().events<{ saved: { by: number } }>(),
    status: this.public(),
    user: this.private(),
  };
}

type RPC = CreateBroadcastRPC<Channels>;

describe("CreateBroadcastRPC", () => {
  test("params come from the pattern", () => {
    expectTypeOf<RPC["site.:siteId"]["params"]>().toEqualTypeOf<{ siteId: string | number }>();
    expectTypeOf<RPC["org.:orgId.page.:pageId"]["params"]>().toEqualTypeOf<{
      orgId: string | number;
      pageId: string | number;
    }>();
    expectTypeOf<RPC["status"]["params"]>().toEqualTypeOf<{}>();
    expectTypeOf<RPC["user"]["params"]>().toEqualTypeOf<{}>();
  });

  test("events come from the BroadcastEvent classes or the type argument", () => {
    expectTypeOf<RPC["site.:siteId"]["events"]>().toEqualTypeOf<{
      changed: { pages: string[] };
      deleted: undefined;
    }>();
    expectTypeOf<RPC["org.:orgId.page.:pageId"]["events"]>().toEqualTypeOf<{
      saved: { by: number };
    }>();
    expectTypeOf<RPC["status"]["events"]>().toEqualTypeOf<Record<string, unknown>>();
  });
});

describe("Broadcast.to", () => {
  test("takes exactly the pattern's params", () => {
    expectTypeOf<ChannelParams<"a.:x.b.:y">>().toEqualTypeOf<{
      x: string | number;
      y: string | number;
    }>();

    // Type-checked only; never run.
    const check = () => {
      Broadcast.to("site.:siteId", { siteId: "abc" }).emit("changed", { any: "thing" });
      Broadcast.to("status").emit("ping");
      Broadcast.to(`user.${42 as number}`).emit("credits", { balance: 1 });

      // @ts-expect-error the param is missing
      Broadcast.to("site.:siteId").emit("changed");
      // @ts-expect-error a param the pattern does not have
      Broadcast.to("site.:siteId", { pageId: "x" }).emit("changed");
      // @ts-expect-error a topic without params takes none
      Broadcast.to("status", { siteId: "x" }).emit("ping");
    };
    void check;
  });
});
