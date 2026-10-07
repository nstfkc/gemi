import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";

import { Crypt } from "../../facades/Crypt";
import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { frameworkProviders } from "../../kernel/providers";
import { Model } from "../../orm/Model";
import { clearRegistry, register } from "../../orm/registry";
import type { ModelSchema } from "../../orm/schema";
import { Repository } from "../../support/Repository";
import { DecryptionError, Encrypter, EncryptionKeyError } from "./Encrypter";
import { EncryptionServiceProvider } from "./EncryptionServiceProvider";

const key = randomBytes(32).toString("base64");

async function makeApp(encryption?: Record<string, unknown>) {
  const application = new Application(
    new Repository(encryption === undefined ? {} : { encryption }),
  );
  application.registerMany([EncryptionServiceProvider]);
  await application.boot();
  return application;
}

const secretSchema: ModelSchema = {
  name: "Secret",
  table: "Secret",
  fields: {
    id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false },
    token: {
      name: "token",
      column: "token",
      type: "String",
      nullable: false,
      isId: false,
      isUpdatedAt: false,
      encrypted: true,
    },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};

class Secret extends Model {
  static $schema = secretSchema;
}

afterEach(() => clearRegistry());

describe("EncryptionServiceProvider", () => {
  test("is one of the providers every app boots with", () => {
    expect(frameworkProviders).toContain(EncryptionServiceProvider);
  });

  test("binds an Encrypter from the encryption slice, and Crypt reaches it", async () => {
    const application = await makeApp({ keys: { k1: key } });
    expect(application.make(Encrypter).currentKeyId).toBe("k1");

    await kernelContext.run(application, async () => {
      const sealed = Crypt.encrypt("api-key");
      expect(sealed.startsWith("v1:k1:")).toBe(true);
      expect(Crypt.decrypt(sealed)).toBe("api-key");
      expect(Crypt.needsReencryption(sealed)).toBe(false);
      expect(() => Crypt.decrypt("api-key")).toThrow(DecryptionError);
    });
  });

  test("a bad key fails the boot", async () => {
    await expect(makeApp({ keys: { k1: "too-short" } })).rejects.toThrow(EncryptionKeyError);
  });

  test("an app without keys and without encrypted columns boots", async () => {
    const application = await makeApp();
    expect(application.make(Encrypter).configured).toBe(false);
  });

  test("an encrypted column without a key fails the boot, naming the column", async () => {
    register("Secret", Secret);
    await expect(makeApp()).rejects.toThrow(/Secret\.token is an encrypted column/);
  });

  test("an encrypted column with a key boots", async () => {
    register("Secret", Secret);
    await expect(makeApp({ keys: { k1: key } })).resolves.toBeInstanceOf(Application);
  });
});
