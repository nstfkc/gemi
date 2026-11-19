process.env.SECRET ??= "agent-controller-test-secret";

import { describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import type { ReadResult } from "../services/file-storage/drivers/types";
import { Agent, AgentTool } from "./Agent";
import {
  AgentController,
  MemoryAttachmentStore,
  MemoryFileOwners,
  MemoryLiveRuns,
  ScopedAttachments,
  type AttachmentRetention,
  type UploadResult,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { ImageModel } from "./ImageModel";
import { fakeImageProvider, fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentStreamEvent } from "./types";

/**
 * #1307: short-lived attachments. Everything here is offline: the chat model
 * is a script, the image model a fake, storage a map.
 */

/** A `FileStorage` that is a map, with `delete`, recording what it deleted. */
class FakeStorage {
  readonly objects = new Map<string, Blob>();
  readonly deleted: string[] = [];

  async put(params: any): Promise<string> {
    const blob: Blob = params instanceof Blob ? params : params.body;
    const name: string = params instanceof Blob ? `blob-${this.objects.size}` : params.name;
    this.objects.set(name, blob);
    return name;
  }

  async read(params: any): Promise<ReadResult> {
    const name = typeof params === "string" ? params : params.name;
    const blob = this.objects.get(name);
    if (!blob) throw new Error(`no object ${name}`);
    return {
      body: blob,
      start: 0,
      end: blob.size - 1,
      total: blob.size,
      partial: false,
      type: blob.type,
      name,
    };
  }

  async delete(params: any): Promise<void> {
    const name = typeof params === "string" ? params : params.name;
    this.deleted.push(name);
    this.objects.delete(name);
  }
}

const file = (name: string, type: string, body: string) => new File([body], name, { type });

function uploadRequest(f: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", f);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const raw = new Request("http://localhost/api/chat/files", { method: "POST", body: form });
  return new HttpRequest(raw, {}, "api", "/chat/files");
}

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

async function eventsOf(response: Response): Promise<AgentStreamEvent[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

const toolCall = (name: string, args: unknown): ProviderEvent => ({
  type: "tool-call",
  toolCallId: "c1",
  name,
  args: JSON.stringify(args),
});

/**
 * A store page's photo tool: reads the shopper's photo by id, edits it, and
 * returns the result inline, since under `"turn"` nothing can fetch it later.
 */
function tryOnTool() {
  const images = fakeImageProvider("edited-png");
  const model = ImageModel.create({ name: "tryon", provider: images, size: "1024x1024" });
  const seen: string[] = [];
  const tool = AgentTool.create({
    name: "try_on",
    description: "Shows the product on the shopper's photo",
    inputSchema: s.object({ photoId: s.string() }),
    outputSchema: s.object({ image: s.string() }),
    execute: async ({ photoId }, ctx) => {
      const photo = await ctx.attachments.file(photoId);
      seen.push(await photo.text());
      const edited = await ctx.editImage(model, {
        prompt: "put the glasses on",
        images: [photoId],
        showModel: true,
      });
      const bytes = await (await ctx.attachments.file(edited.attachment.id)).text();
      return { image: `data:image/png;base64,${btoa(bytes)}` };
    },
  });
  return { tool, seen, images };
}

function chatFor(agent: any, retention: AttachmentRetention | null) {
  return class extends AgentController {
    agent = agent;
    liveRuns = new MemoryLiveRuns();
    attachments = new MemoryAttachmentStore();
    attachmentStorage = new FakeStorage();
    fileOwners = new MemoryFileOwners();
    completed = vi.fn();
    storedAtComplete = -1;

    attachmentScope() {
      return { key: "visitor:v1" };
    }

    attachmentRetention() {
      return retention;
    }

    onStreamComplete() {
      this.storedAtComplete = this.attachmentStorage.objects.size;
      this.completed();
    }
  };
}

describe('attachmentRetention: "turn"', () => {
  test("the upload and the tool's image are gone from storage and the provider once the turn completes, after the client got the image", async () => {
    const { tool, seen } = tryOnTool();
    const provider = fakeProvider();
    const scripts = (provider as any).scripts as ProviderEvent[][];
    const agent = Agent.create({ name: "store", provider, tools: [tool] });
    const Chat = chatFor(agent, "turn");
    const controller = new Chat();

    const photo = await controller.upload(uploadRequest(file("me.png", "image/png", "selfie")));
    expect(photo.attachmentId).toMatch(/^gemi_att_/);
    expect(photo.fileId).toBe("file_1");
    expect(controller.attachmentStorage.objects.size).toBe(1);

    scripts.push(
      [toolCall("try_on", { photoId: photo.attachmentId }), finish()],
      [{ type: "text-delta", delta: "Here you go" }, finish()],
    );
    const response = await controller.stream(
      jsonRequest({ turn: { text: "how do these look on me?", files: [photo] } }),
    );
    const events = await eventsOf(response);

    // The client was streamed the edited image.
    const result = events.find((event: any) => event.type === "tool-result") as any;
    expect(JSON.stringify(result)).toContain(btoa("edited-png"));
    expect(seen).toEqual(["selfie"]);

    await vi.waitFor(() => expect(controller.attachmentStorage.objects.size).toBe(0));
    // `onStreamComplete` still saw both copies: deletion comes after it.
    expect(controller.completed).toHaveBeenCalledOnce();
    expect(controller.storedAtComplete).toBe(2);
    // Both provider files: the upload's and the one `showModel` sent.
    expect([...(provider as any).deletedFiles].sort()).toEqual(["file_1", "file_2"]);
    // And the records: the ids no longer resolve.
    const handle = new ScopedAttachments(controller.attachments, controller.attachmentStorage, {
      key: "visitor:v1",
    });
    await expect(handle.get(photo.attachmentId!)).rejects.toThrow(/No attachment/);
    expect(controller.attachments.size).toBe(0);
    expect(await controller.fileOwners.get("file_1")).toBeNull();
  });

  test("a provider-only upload is deleted at the provider after the turn that names it", async () => {
    const provider = fakeProvider([{ type: "text-delta", delta: "nice" }, finish()]);
    const agent = Agent.create({ name: "store", provider });
    class Chat extends chatFor(agent, "turn") {
      attachmentDestination() {
        return "provider" as const;
      }
    }
    const controller = new Chat();
    const photo = await controller.upload(uploadRequest(file("me.png", "image/png", "selfie")));
    expect(photo.attachmentId).toBeUndefined();
    expect(await controller.fileOwners.get(photo.fileId!)).toMatchObject({ deleteAfterTurn: true });

    await eventsOf(await controller.stream(jsonRequest({ turn: { text: "shade?", files: [photo] } })));

    await vi.waitFor(() => expect((provider as any).deletedFiles).toEqual([photo.fileId]));
    expect(await controller.fileOwners.get(photo.fileId!)).toBeNull();
  });

  test("an upload kept by a controller without retention is not deleted by a turn naming it", async () => {
    const provider = fakeProvider([finish()], [finish()]);
    const agent = Agent.create({ name: "store", provider });
    const Keep = chatFor(agent, null);
    const keeper = new Keep();
    const kept = await keeper.upload(uploadRequest(file("logo.png", "image/png", "logo")));

    // Same stores, a controller that does answer "turn".
    const Short = chatFor(agent, "turn");
    const short = new Short();
    short.attachments = keeper.attachments;
    short.attachmentStorage = keeper.attachmentStorage;
    short.fileOwners = keeper.fileOwners;
    await eventsOf(await short.stream(jsonRequest({ turn: { text: "hi", files: [kept] } })));
    await vi.waitFor(() => expect(short.completed).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(keeper.attachmentStorage.objects.size).toBe(1);
    expect((provider as any).deletedFiles).toEqual([]);
  });

  test("a turn does not delete a provider file another caller uploaded", async () => {
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "store", provider });
    class Chat extends chatFor(agent, "turn") {
      owner = "user:a";
      attachmentDestination() {
        return "provider" as const;
      }
      runOwner() {
        return this.owner;
      }
    }
    const controller = new Chat();
    const theirs = await controller.upload(uploadRequest(file("a.png", "image/png", "a")));
    controller.owner = "user:b";
    // Refused before the run (#443), and nothing is deleted.
    const response = await controller.stream(jsonRequest({ turn: { text: "x", files: [theirs] } }));
    expect(response.status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((provider as any).deletedFiles).toEqual([]);
  });

  test("a failed deletion is reported and left for the sweep", async () => {
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "store", provider });
    const reported: unknown[] = [];
    class Chat extends chatFor(agent, "turn") {
      reportHookFailure(error: unknown) {
        reported.push(error);
      }
    }
    const controller = new Chat();
    const photo = await controller.upload(uploadRequest(file("me.png", "image/png", "selfie")));
    const storage = controller.attachmentStorage;
    const realDelete = storage.delete.bind(storage);
    storage.delete = async () => {
      throw new Error("storage is down");
    };

    await eventsOf(await controller.stream(jsonRequest({ turn: { text: "x", files: [photo] } })));
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(String(reported[0])).toMatch(/storage is down/);
    expect(controller.attachments.size).toBe(1);

    storage.delete = realDelete;
    const later = new Date(Date.now() + controller.turnAttachmentMaxAgeMs + 1);
    expect(await controller.sweepAttachments({ now: later })).toEqual({ deleted: 1, failed: 0 });
    expect(storage.objects.size).toBe(0);
    expect(controller.attachments.size).toBe(0);
  });
});

describe("attachmentRetention: { ttlMs }", () => {
  test("attachments are removed by the sweep, and not before", async () => {
    const provider = fakeProvider();
    const agent = Agent.create({ name: "store", provider });
    const Chat = chatFor(agent, { ttlMs: 60_000 });
    const controller = new Chat();
    const before = Date.now();
    const photo = await controller.upload(uploadRequest(file("me.png", "image/png", "selfie")));

    const handle = new ScopedAttachments(controller.attachments, controller.attachmentStorage, {
      key: "visitor:v1",
    });
    expect((await handle.get(photo.attachmentId!)).expiresAt).toBeDefined();

    expect(await controller.sweepAttachments({ now: new Date(before + 59_000) })).toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(controller.attachmentStorage.objects.size).toBe(1);
    expect((provider as any).deletedFiles).toEqual([]);

    // Past its time it no longer resolves, even before a sweep.
    vi.useFakeTimers({ now: before + 61_000, toFake: ["Date"] });
    try {
      await expect(handle.get(photo.attachmentId!)).rejects.toThrow(/No attachment/);
    } finally {
      vi.useRealTimers();
    }

    // The attachment (bytes, provider copy, record) and nothing twice.
    expect(await controller.sweepAttachments({ now: new Date(before + 61_000) })).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(controller.attachmentStorage.objects.size).toBe(0);
    expect((provider as any).deletedFiles).toEqual([photo.fileId]);
    expect(controller.attachments.size).toBe(0);
    expect(await controller.fileOwners.get(photo.fileId!)).toBeNull();
  });

  test("a tool's output gets the turn's ttl and is not deleted after the turn", async () => {
    const tool = AgentTool.create({
      name: "draw",
      description: "draws",
      inputSchema: s.object({}),
      outputSchema: s.object({ id: s.string() }),
      execute: async (_input, ctx) => ({
        id: (await ctx.attachments.put(new Blob(["png"], { type: "image/png" }), { name: "a.png" })).id,
      }),
    });
    const provider = fakeProvider([toolCall("draw", {}), finish()], [finish()]);
    const agent = Agent.create({ name: "store", provider, tools: [tool] });
    const Chat = chatFor(agent, { ttlMs: 1_000 });
    const controller = new Chat();
    await eventsOf(await controller.stream(jsonRequest({ turn: { text: "draw" } })));
    await vi.waitFor(() => expect(controller.completed).toHaveBeenCalledOnce());
    expect(controller.attachmentStorage.objects.size).toBe(1);
    expect(
      await controller.sweepAttachments({ now: new Date(Date.now() + 1_001) }),
    ).toEqual({ deleted: 1, failed: 0 });
    expect(controller.attachmentStorage.objects.size).toBe(0);
  });

  test("a retention that is not one is refused", async () => {
    const agent = Agent.create({ name: "store", provider: fakeProvider() });
    const Chat = chatFor(agent, { ttlMs: -1 } as any);
    await expect(
      new Chat().upload(uploadRequest(file("me.png", "image/png", "x"))),
    ).rejects.toThrow(/attachmentRetention\(\) must answer/);
  });
});

/**
 * The open question from the store-agents plan: can a shopper who is not
 * signed in, with no thread, upload a photo that a tool reads in the same turn?
 */
describe("an anonymous, threadless upload", () => {
  test("by default it goes to the provider alone, so a tool has no bytes to read", async () => {
    const agent = Agent.create({ name: "store", provider: fakeProvider() });
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      attachments = new MemoryAttachmentStore();
      attachmentStorage = new FakeStorage();
      fileOwners = new MemoryFileOwners();
    }
    const result = await new Chat().upload(uploadRequest(file("me.png", "image/png", "selfie")));
    expect(result.attachmentId).toBeUndefined();
    expect(result.downgraded).toBe("no_scope");
  });

  test("with a scope from a server-checked visitor token, the tool reads it and \"turn\" deletes it", async () => {
    // What the app minted when it rendered the store page, and checks here.
    const visitors = new Set(["vis_9f2c7e"]);
    const { tool, seen } = tryOnTool();
    const provider = fakeProvider();
    const scripts = (provider as any).scripts as ProviderEvent[][];
    const agent = Agent.create({ name: "store", provider, tools: [tool] });
    class StoreChat extends AgentController<typeof agent, { visitor?: string }> {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      attachments = new MemoryAttachmentStore();
      attachmentStorage = new FakeStorage();
      fileOwners = new MemoryFileOwners();

      attachmentScope(_req: HttpRequest<any, any>, _threadId?: string, extra?: { body: { visitor?: string } }) {
        const visitor = extra?.body.visitor;
        return typeof visitor === "string" && visitors.has(visitor) ? { key: `visitor:${visitor}` } : null;
      }

      attachmentRetention() {
        return "turn" as const;
      }
    }
    const controller = new StoreChat();
    const body = JSON.stringify({ visitor: "vis_9f2c7e" });

    const photo: UploadResult = await controller.upload(
      uploadRequest(file("me.png", "image/png", "selfie"), { body }),
    );
    expect(photo.attachmentId).toMatch(/^gemi_att_/);
    expect(photo.downgraded).toBeUndefined();

    scripts.push(
      [toolCall("try_on", { photoId: photo.attachmentId }), finish()],
      [{ type: "text-delta", delta: "done" }, finish()],
    );
    const events = await eventsOf(
      await controller.stream(
        jsonRequest({ visitor: "vis_9f2c7e", turn: { text: "try these", files: [photo] } }),
      ),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(seen).toEqual(["selfie"]);

    await vi.waitFor(() => expect(controller.attachmentStorage.objects.size).toBe(0));
    expect(controller.attachments.size).toBe(0);
  });
});
