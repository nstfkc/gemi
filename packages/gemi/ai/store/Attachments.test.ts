import { describe, expect, test } from "vitest";

import type { ReadResult } from "../../services/file-storage/drivers/types";
import {
  type Attachment,
  type AttachmentScope,
  type AttachmentStore,
  AttachmentNotFoundError,
  InvalidAttachmentScopeError,
  MemoryAttachmentStore,
  ScopedAttachments,
} from "./Attachments";

/** A `FileStorage` that is a map, so these tests need no container and no disk. */
class FakeStorage {
  readonly objects = new Map<string, { blob: Blob; type: string }>();

  async put(params: any): Promise<string> {
    const blob: Blob = params instanceof Blob ? params : params.body;
    const name: string = params instanceof Blob ? `blob-${this.objects.size}` : params.name;
    this.objects.set(name, { blob, type: params?.contentType ?? blob.type ?? "" });
    return name;
  }

  async read(params: any): Promise<ReadResult> {
    const name = typeof params === "string" ? params : params.name;
    const object = this.objects.get(name);
    if (!object) {
      throw new Error(`no object ${name}`);
    }
    return {
      body: object.blob,
      start: 0,
      end: object.blob.size - 1,
      total: object.blob.size,
      partial: false,
      type: object.type,
      name,
    };
  }
}

const acme: AttachmentScope = { key: "org:acme" };
const initech: AttachmentScope = { key: "org:initech" };

/**
 * Puts a file through the store as `scope`, the way `AgentController.upload`
 * would, and answers the record.
 */
async function seed(
  store: AttachmentStore,
  storage: FakeStorage,
  scope: AttachmentScope,
  params: { id: string; name?: string; body?: string; mimeType?: string },
): Promise<Attachment> {
  const name = params.name ?? "invoice.csv";
  const blob = new Blob([params.body ?? "id,total\n1,9"], {
    type: params.mimeType ?? "text/csv",
  });
  const objectName = await storage.put({ name: `attachments/${params.id}`, body: blob });
  const record: Attachment = {
    id: params.id,
    scopeKey: scope.key,
    objectName,
    name,
    mimeType: params.mimeType ?? "text/csv",
    size: blob.size,
    createdAt: new Date(0).toISOString(),
    destination: "storage",
  };
  await store.put(scope, record);
  return record;
}

describe("ScopedAttachments", () => {
  test("resolves an id filed under its own scope", async () => {
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    await seed(store, storage, acme, { id: "gemi_att_a", body: "acme rows" });

    const attachments = new ScopedAttachments(store, storage, acme);

    expect((await attachments.get("gemi_att_a")).name).toBe("invoice.csv");
    expect(await (await attachments.file("gemi_att_a")).text()).toBe("acme rows");
  });

  test("hands back a File under the uploaded name and type, which is what a tool forwards", async () => {
    // The motivating case: a tool that has to `form.append("image", file)`.
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    await seed(store, storage, acme, {
      id: "gemi_att_img",
      name: "shoe.png",
      mimeType: "image/png",
      body: "PNGDATA",
    });

    const file = await new ScopedAttachments(store, storage, acme).file("gemi_att_img");

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("shoe.png");
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("PNGDATA");
  });

  /**
   * THE CROSS-TENANT READ. Initech's attachment genuinely exists and its bytes
   * are genuinely in storage — a test where the other tenant's row is absent
   * proves nothing, because "not found" is then the only answer available.
   */
  test("an id belonging to another tenant fails, with that tenant's row present", async () => {
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    await seed(store, storage, initech, { id: "gemi_att_secret", body: "initech payroll" });
    await seed(store, storage, acme, { id: "gemi_att_mine", body: "acme rows" });

    // The row is there, and readable by the tenant it belongs to.
    expect(
      await (await new ScopedAttachments(store, storage, initech).file("gemi_att_secret")).text(),
    ).toBe("initech payroll");

    const asAcme = new ScopedAttachments(store, storage, acme);
    await expect(asAcme.get("gemi_att_secret")).rejects.toBeInstanceOf(AttachmentNotFoundError);
    await expect(asAcme.file("gemi_att_secret")).rejects.toBeInstanceOf(AttachmentNotFoundError);
    await expect(asAcme.read("gemi_att_secret")).rejects.toBeInstanceOf(AttachmentNotFoundError);
  });

  /**
   * The error must not be an oracle: a model that can tell "exists, not yours"
   * from "does not exist" can enumerate a tenant's ids through whatever tool it
   * was injected into.
   */
  test("someone else's id fails exactly the way an unknown id does", async () => {
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    await seed(store, storage, initech, { id: "gemi_att_real" });

    const asAcme = new ScopedAttachments(store, storage, acme);

    const foreign = await asAcme
      .get("gemi_att_real")
      .catch((err) => err as AttachmentNotFoundError);
    const unknown = await asAcme
      .get("gemi_att_never")
      .catch((err) => err as AttachmentNotFoundError);

    expect(foreign.code).toBe(unknown.code);
    expect(foreign.name).toBe(unknown.name);
    // Same sentence, with only the id the caller supplied differing.
    expect(foreign.message.replace("gemi_att_real", "X")).toBe(
      unknown.message.replace("gemi_att_never", "X"),
    );
  });

  /**
   * The second gate. An app's `find` is a `WHERE` clause somebody had to
   * remember, and forgetting it passes every test the app writes about its own
   * uploads. This is the store that forgot.
   */
  test("a store that ignores the scope still cannot leak, because the handle re-checks", async () => {
    const storage = new FakeStorage();
    const rows = new Map<string, Attachment>();
    const forgetfulStore: AttachmentStore = {
      async put(scope, attachment) {
        rows.set(attachment.id, { ...attachment, scopeKey: scope.key });
      },
      // `SELECT * FROM attachments WHERE id = ?` — the leak, written out.
      async find(_scope, id) {
        return rows.get(id) ?? null;
      },
    };
    await seed(forgetfulStore, storage, initech, {
      id: "gemi_att_secret",
      body: "initech payroll",
    });

    const asAcme = new ScopedAttachments(forgetfulStore, storage, acme);

    // The store hands the record over; the handle refuses it.
    expect(await forgetfulStore.find(acme, "gemi_att_secret")).not.toBeNull();
    await expect(asAcme.get("gemi_att_secret")).rejects.toBeInstanceOf(AttachmentNotFoundError);
  });

  test("an attachment whose bytes were never kept reads as not found", async () => {
    // A `provider`-destination upload: the record exists, the bytes are at the
    // vendor. Same error as an unknown id, so the answer never says where a
    // file lives.
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    await store.put(acme, {
      id: "gemi_att_vision",
      scopeKey: acme.key,
      fileId: "file_openai_1",
      name: "chart.png",
      mimeType: "image/png",
      size: 12,
      createdAt: new Date(0).toISOString(),
      destination: "provider",
    });

    const attachments = new ScopedAttachments(store, storage, acme);
    expect((await attachments.get("gemi_att_vision")).fileId).toBe("file_openai_1");
    await expect(attachments.read("gemi_att_vision")).rejects.toBeInstanceOf(
      AttachmentNotFoundError,
    );
  });

  test("put() files a tool's bytes under the caller's scope and nobody else's", async () => {
    // The surface #490 builds `ctx.attachments.put(blob)` on.
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    const asAcme = new ScopedAttachments(store, storage, acme);

    const record = await asAcme.put(new Blob(["report"], { type: "text/plain" }), {
      name: "report.txt",
    });

    expect(record.id.startsWith("gemi_att_")).toBe(true);
    expect(record.scopeKey).toBe("org:acme");
    expect(record.destination).toBe("storage");
    expect(await (await asAcme.file(record.id)).text()).toBe("report");

    const asInitech = new ScopedAttachments(store, storage, initech);
    await expect(asInitech.get(record.id)).rejects.toBeInstanceOf(AttachmentNotFoundError);
  });

  test("refuses the empty scope, which is the bucket everyone shares", async () => {
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    expect(() => new ScopedAttachments(store, storage, { key: "" })).toThrow(
      InvalidAttachmentScopeError,
    );
    await expect(store.find({ key: "" }, "gemi_att_a")).rejects.toBeInstanceOf(
      InvalidAttachmentScopeError,
    );
  });
});

/**
 * The store's OWN scope clause, asserted without a `ScopedAttachments` in front
 * of it.
 *
 * Every test above goes through the handle, and the handle re-checks
 * `record.scopeKey` — so all of them stay green with the store's comparison
 * deleted, and the store's comment says it is the reference implementation whose
 * check every real store has to copy. A claim like that has to be pinned
 * somewhere the second gate cannot answer for it. `AttachmentStore` is also
 * public: an app is entitled to call `controller.attachments.find(scope, id)`
 * itself, and there is no handle in that path at all.
 */
describe("MemoryAttachmentStore.find", () => {
  test("answers null for an id filed under another scope, with the row present", async () => {
    const store = new MemoryAttachmentStore();
    const storage = new FakeStorage();
    const theirs = await seed(store, storage, initech, {
      id: "gemi_att_secret",
      body: "initech payroll",
    });

    // The row is real and the store hands it to the scope that owns it.
    expect(await store.find(initech, theirs.id)).toEqual(theirs);
    // `SELECT * FROM attachments WHERE id = ?` would return it here.
    expect(await store.find(acme, theirs.id)).toBeNull();
    // Same answer as an id nobody ever minted, which is the contract callers
    // depend on for the error not to be an oracle.
    expect(await store.find(acme, "gemi_att_never")).toBeNull();
  });
});
