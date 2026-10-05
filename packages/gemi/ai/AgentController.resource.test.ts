import { describe, expect, test } from "vitest";

import { NotFoundError } from "../http/errors";
import { HttpRequest } from "../http/HttpRequest";
import { defineResourcePolicy } from "../http/ResourcePolicy";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import type { AgentStreamParams } from "./Agent";
import { StubAgentRun } from "./store/stubAgentRun";

/**
 * `AgentController.resource` (#726): a resource policy's `forAgent`, checked
 * by the default `authorizeRequest` on every route. The policy's own rules
 * are in `http/ResourcePolicy.test.ts`; this is that they reach each route,
 * ahead of the agent and the store.
 */

type PageBody = { pageId?: string };

const OWNERS: Record<string, string> = { p1: "alice", p2: "bob" };

const PagePolicy = defineResourcePolicy({
  load: (id) => (OWNERS[id] ? { id, ownerId: OWNERS[id] } : null),
  allow: (page, req) => page.ownerId === req.headers.get("x-user"),
});

function stubAgent() {
  const calls: AgentStreamParams[] = [];
  const run = new StubAgentRun("run_1");
  return {
    calls,
    run,
    agent: {
      name: "stub",
      tools: [] as const,
      skills: [] as const,
      output: undefined,
      provider: { upload: async () => "file_123" },
      stream: (params: AgentStreamParams) => {
        calls.push(params);
        return run;
      },
    } as any,
  };
}

async function setup() {
  const store = new MemoryAgentStore();
  const threadPage = new Map<string, string>();
  const alicesThread = (await store.createThread({})).threadId;
  const bobsThread = (await store.createThread({})).threadId;
  threadPage.set(alicesThread, "p1");
  threadPage.set(bobsThread, "p2");
  const { agent, calls, run } = stubAgent();

  class PageChat extends AgentController<any, PageBody> {
    agent = agent;
    store = store;
    liveRuns = new MemoryLiveRuns();
    resource = PagePolicy.forAgent({
      body: (body: PageBody) => body.pageId,
      thread: (threadId) => threadPage.get(threadId) ?? null,
    });
  }

  return { PageChat, calls, run, alicesThread, bobsThread };
}

function jsonRequest(body: unknown, user: string) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user": user },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

function uploadRequest(fields: Record<string, string>, user: string) {
  const form = new FormData();
  form.set("file", new File(["hello"], "a.txt", { type: "text/plain" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const raw = new Request("http://localhost/api/chat/files", {
    method: "POST",
    headers: { "x-user": user },
    body: form,
  });
  return new HttpRequest(raw, {}, "api", "/chat/files");
}

describe("stream", () => {
  test("runs a turn on the caller's own resource and thread", async () => {
    const { PageChat, calls, run, alicesThread } = await setup();
    await new PageChat().stream(
      jsonRequest({ threadId: alicesThread, text: "hi", pageId: "p1" }, "alice"),
    );
    expect(calls).toHaveLength(1);
    run.finish();
  });

  test("refuses someone else's resource, a missing one and none, before the agent", async () => {
    const { PageChat, calls } = await setup();
    for (const body of [{ pageId: "p2" }, { pageId: "nope" }, {}]) {
      await expect(
        new PageChat().stream(jsonRequest({ text: "hi", ...body }, "alice")),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(calls).toHaveLength(0);
  });

  test("refuses the caller's own resource with someone else's thread", async () => {
    const { PageChat, calls, bobsThread } = await setup();
    await expect(
      new PageChat().stream(jsonRequest({ threadId: bobsThread, text: "hi", pageId: "p1" }, "alice")),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toHaveLength(0);
  });
});

test("attach and stop are refused on someone else's thread", async () => {
  const { PageChat, bobsThread, alicesThread } = await setup();
  await expect(
    new PageChat().attach(jsonRequest({ threadId: bobsThread }, "alice")),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    new PageChat().stop(jsonRequest({ threadId: bobsThread }, "alice")),
  ).rejects.toBeInstanceOf(NotFoundError);
  // The owner's own stop goes through (nothing is running).
  await expect(
    new PageChat().stop(jsonRequest({ threadId: alicesThread }, "alice")),
  ).resolves.toEqual({ stopped: false });
});

test("upload is refused for someone else's resource or thread", async () => {
  const { PageChat, alicesThread, bobsThread } = await setup();
  await expect(
    new PageChat().upload(uploadRequest({ body: JSON.stringify({ pageId: "p2" }) }, "alice")),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    new PageChat().upload(
      uploadRequest({ body: JSON.stringify({ pageId: "p1" }), threadId: bobsThread }, "alice"),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  // Past the check, the upload goes on to the attachment policy.
  await expect(
    new PageChat().upload(
      uploadRequest({ body: JSON.stringify({ pageId: "p1" }), threadId: alicesThread }, "alice"),
    ),
  ).rejects.not.toBeInstanceOf(NotFoundError);
});

test("an override of authorizeRequest keeps the check through super", async () => {
  const { PageChat, calls } = await setup();
  const seen: string[] = [];
  class Audited extends PageChat {
    protected async authorizeRequest(req: HttpRequest<any, any>, params: any) {
      seen.push(params.route);
      await super.authorizeRequest(req, params);
    }
  }
  await expect(
    new Audited().stream(jsonRequest({ text: "hi", pageId: "p2" }, "alice")),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(seen).toEqual(["stream"]);
  expect(calls).toHaveLength(0);
});

test("without resource, the default lets every request through, as before", async () => {
  const { agent, calls, run } = stubAgent();
  class Chat extends AgentController {
    agent = agent;
    liveRuns = new MemoryLiveRuns();
  }
  await new Chat().stream(jsonRequest({ text: "hi", pageId: "p2" }, "alice"));
  expect(calls).toHaveLength(1);
  run.finish();
});
