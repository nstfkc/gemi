import { describe, expect, test } from "vitest";

import { PrismaNonceStore } from "../../../../ai/store/Nonces";
import { memoryModel, memoryOAuthModels } from "./__fixtures__/memoryModel";
import { PrismaMcpOAuthStore } from "./prismaStore";
import type { McpOAuthToken } from "./store";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function token(overrides: Partial<McpOAuthToken> = {}): McpOAuthToken {
  return {
    hash: `h_${Math.random().toString(36).slice(2)}`,
    kind: "refresh",
    clientId: "client_a",
    userId: "1",
    scopes: ["support:read"],
    resource: "https://shop.test/mcp",
    familyId: "fam_1",
    expiresAt: Date.now() + 30 * DAY,
    ...overrides,
  };
}

async function client(store: PrismaMcpOAuthStore, clientId: string, clientName: string | null) {
  await store.createClient({
    clientId,
    clientSecretHash: null,
    tokenEndpointAuthMethod: "none",
    redirectUris: ["https://claude.example/cb"],
    clientName,
    clientUri: null,
    createdAt: Date.now(),
  });
}

describe("PrismaMcpOAuthStore", () => {
  test("refuses models that are not models", () => {
    expect(() => new PrismaMcpOAuthStore(undefined as any)).toThrow(/models\.clients must be/);
    const models = memoryOAuthModels();
    expect(() => new PrismaMcpOAuthStore({ ...models, credentials: { create() {} } as any })).toThrow(
      /models\.credentials .* no findFirst, findMany, count, updateMany, deleteMany/,
    );
  });

  test("a client round-trips", async () => {
    const store = new PrismaMcpOAuthStore(memoryOAuthModels());
    await client(store, "client_a", "Claude");
    expect(await store.findClient("client_a")).toMatchObject({
      clientId: "client_a",
      clientSecretHash: null,
      tokenEndpointAuthMethod: "none",
      redirectUris: ["https://claude.example/cb"],
      clientName: "Claude",
    });
    expect(await store.findClient("nope")).toBeNull();
  });

  test("lists read from a Json column are arrays of strings", async () => {
    const models = memoryOAuthModels();
    const store = new PrismaMcpOAuthStore(models);
    const saved = token();
    await store.saveToken(saved);
    expect((await store.findToken(saved.hash))!.scopes).toEqual(["support:read"]);
    models.credentials.rows.get(saved.hash)!.scopes = null;
    expect((await store.findToken(saved.hash))!.scopes).toEqual([]);
  });

  for (const unique of ["gemi", "prisma"] as const) {
    test(`use() spends a key once, across instances (${unique} unique errors)`, async () => {
      const models = memoryOAuthModels(unique);
      const instances = [new PrismaMcpOAuthStore(models), new PrismaMcpOAuthStore(models)];
      const wins = await Promise.all(
        Array.from({ length: 20 }, (_, i) => instances[i % 2].use("code_hash", Date.now() + HOUR)),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await instances[0].use("code_hash", Date.now() + HOUR)).toBe(false);
    });
  }

  test("a token saved after its family was revoked is refused, and so is every other", async () => {
    const store = new PrismaMcpOAuthStore(memoryOAuthModels());
    const first = token();
    await store.saveToken(first);
    await store.revokeFamily("fam_1");
    const late = token({ kind: "access" });
    await store.saveToken(late);
    expect(await store.findToken(first.hash)).toBeNull();
    expect(await store.findToken(late.hash)).toBeNull();
  });

  test("connected apps: live grants, newest first, named by their client", async () => {
    const store = new PrismaMcpOAuthStore(memoryOAuthModels());
    await client(store, "client_a", "Claude");
    await client(store, "client_b", null);
    await store.saveToken(token({ familyId: "fam_old", clientId: "client_a" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.saveToken(token({ familyId: "fam_new", clientId: "client_b" }));
    await store.saveToken(token({ familyId: "fam_new", clientId: "client_b", kind: "access", expiresAt: Date.now() + HOUR }));
    await store.saveToken(token({ familyId: "fam_expired", expiresAt: Date.now() - 1 }));
    await store.saveToken(token({ familyId: "fam_revoked" }));
    await store.revokeFamily("fam_revoked");
    await store.saveToken(token({ familyId: "fam_bob", userId: "2" }));

    const apps = await store.connectedApps(1);
    expect(apps.map(({ familyId, clientName, scopes }) => ({ familyId, clientName, scopes }))).toEqual([
      { familyId: "fam_new", clientName: null, scopes: ["support:read"] },
      { familyId: "fam_old", clientName: "Claude", scopes: ["support:read"] },
    ]);
    expect(apps[0].connectedAt).toBeInstanceOf(Date);
  });

  test("disconnect revokes the user's own grant only; revokeUser revokes them all", async () => {
    const store = new PrismaMcpOAuthStore(memoryOAuthModels());
    const alice = [token({ familyId: "fam_a1" }), token({ familyId: "fam_a2" })];
    const bob = token({ familyId: "fam_b", userId: "2" });
    for (const each of [...alice, bob]) await store.saveToken(each);

    expect(await store.disconnect(1, "fam_b")).toBe(false);
    expect(await store.findToken(bob.hash)).not.toBeNull();
    expect(await store.disconnect(1, "fam_a1")).toBe(true);
    expect(await store.findToken(alice[0].hash)).toBeNull();
    expect(await store.findToken(alice[1].hash)).not.toBeNull();

    await store.revokeUser("1");
    expect(await store.findToken(alice[1].hash)).toBeNull();
    expect(await store.connectedApps("1")).toEqual([]);
    expect(await store.findToken(bob.hash)).not.toBeNull();
  });

  test("prune keeps a revoked family's revoked rows while any of its rows is live", async () => {
    const models = memoryOAuthModels();
    const store = new PrismaMcpOAuthStore(models);
    const old = Date.now() - 3 * DAY;
    // fam_r: revoked long ago, but a token saved as it was revoked still lives.
    const revokedOld = token({ familyId: "fam_r", expiresAt: old });
    await store.saveToken(revokedOld);
    await store.revokeFamily("fam_r");
    const racing = token({ familyId: "fam_r" });
    await store.saveToken(racing);
    // fam_gone: revoked and entirely expired.
    await store.saveToken(token({ familyId: "fam_gone", expiresAt: old, hash: "gone" }));
    await store.revokeFamily("fam_gone");
    // fam_live: an expired access token beside a live refresh token.
    await store.saveToken(token({ familyId: "fam_live", kind: "access", expiresAt: old, hash: "stale" }));
    const live = token({ familyId: "fam_live" });
    await store.saveToken(live);
    await store.use("spent_old", old);
    await store.use("spent_new", Date.now() + HOUR);

    await store.prune();

    expect(models.credentials.rows.has(revokedOld.hash)).toBe(true);
    expect(await store.findToken(racing.hash)).toBeNull();
    expect(models.credentials.rows.has("gone")).toBe(false);
    expect(models.credentials.rows.has("stale")).toBe(false);
    expect(await store.findToken(live.hash)).not.toBeNull();
    expect([...models.uses.rows.keys()]).toEqual(["spent_new"]);
  });
});

describe("PrismaNonceStore", () => {
  test("refuses something that is not a model", () => {
    expect(() => new PrismaNonceStore({} as any)).toThrow(/needs a model with create\(\) and deleteMany\(\)/);
  });

  for (const unique of ["gemi", "prisma"] as const) {
    test(`a nonce is spent once, by one of many instances racing (${unique})`, async () => {
      const model = memoryModel("McpOAuthUse", { id: "key", unique });
      const instances = [new PrismaNonceStore(model), new PrismaNonceStore(model), new PrismaNonceStore(model)];
      const wins = await Promise.all(
        Array.from({ length: 30 }, (_, i) => instances[i % 3].consume("n1", Date.now() + HOUR)),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
    });
  }

  test("a row left past its expiry binds nothing, and only one racer takes it", async () => {
    const model = memoryModel("McpOAuthUse", { id: "key" });
    const store = new PrismaNonceStore(model);
    expect(await store.consume("n1", Date.now() - 1)).toBe(true);
    const wins = await Promise.all(Array.from({ length: 10 }, () => store.consume("n1", Date.now() + HOUR)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await store.consume("n1", Date.now() + HOUR)).toBe(false);
  });

  test("a failing database rejects rather than letting the answer through", async () => {
    const model = memoryModel("McpOAuthUse", { id: "key" });
    model.create = async () => {
      throw new Error("connection refused");
    };
    await expect(new PrismaNonceStore(model).consume("n1", Date.now() + HOUR)).rejects.toThrow(/connection refused/);
  });

  test("the OAuth store's nonces() shares the table under a prefix, and prunes only its own", async () => {
    const models = memoryOAuthModels();
    const store = new PrismaMcpOAuthStore(models);
    const nonces = store.nonces();
    expect(await nonces.consume("abc", Date.now() + HOUR)).toBe(true);
    expect(await nonces.consume("abc", Date.now() + HOUR)).toBe(false);
    // The same string spent by the OAuth server is another key.
    expect(await store.use("abc", Date.now() - 1)).toBe(true);
    expect(await nonces.consume("old", Date.now() - 1)).toBe(true);
    expect([...models.uses.rows.keys()].sort()).toEqual(["abc", "nonce:abc", "nonce:old"]);

    expect(await nonces.prune()).toBe(1);
    expect([...models.uses.rows.keys()].sort()).toEqual(["abc", "nonce:abc"]);
  });
});
