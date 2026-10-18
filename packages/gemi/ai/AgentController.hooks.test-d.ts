import { expectTypeOf, test } from "vitest";

import type { HttpRequest } from "../http/HttpRequest";
import {
  AgentController,
  type AgentControllerHooks,
  type AgentHookContext,
  type AuthorizeRequestParams,
  defineAgentHooks,
  type UploadContext,
} from "./AgentController";

/**
 * #989: a hooks object typed for the body its controllers share, used by
 * controllers whose bodies have more.
 */

type Shared = { pageId: string };
type SiteBody = { pageId: string; focus?: string };
type PostBody = { pageId: string; format: "square" | "story" };

test("defineAgentHooks types each hook's parameters from Body", () => {
  defineAgentHooks<Shared>({
    authorizeRequest(req, params) {
      expectTypeOf(req).toEqualTypeOf<HttpRequest<any, any>>();
      expectTypeOf(params).toEqualTypeOf<AuthorizeRequestParams<Shared>>();
      if (params.route === "stream") expectTypeOf(params.body.pageId).toBeString();
    },
    context(_req, { body }) {
      expectTypeOf(body).toEqualTypeOf<Shared>();
      return {};
    },
    attachmentDestination(_file, _req, upload) {
      expectTypeOf(upload).toEqualTypeOf<UploadContext<Shared> | undefined>();
      return "both";
    },
    onStreamComplete(_result, ctx) {
      expectTypeOf(ctx).toEqualTypeOf<AgentHookContext>();
    },
  });
});

test("one hooks object serves controllers whose Body has its fields", () => {
  const chatHooks = defineAgentHooks<Shared>({ runOwner: () => null });

  class SiteChat extends AgentController<any, SiteBody> {
    agent = {} as any;
    hooks = chatHooks;
  }
  class PostChat extends AgentController<any, PostBody> {
    agent = {} as any;
    hooks = chatHooks;
  }
  void SiteChat;
  void PostChat;
});

test("a hook returns what the method it stands in for returns", () => {
  expectTypeOf<NonNullable<AgentControllerHooks["runOwner"]>>().returns.toEqualTypeOf<
    string | null | Promise<string | null>
  >();
  defineAgentHooks({
    // @ts-expect-error a run owner is a string or null.
    runOwner: () => 42,
  });
});
