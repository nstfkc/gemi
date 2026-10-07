import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";

import { DecryptionError, Encrypter, EncryptionKeyError } from "./Encrypter";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

describe("Encrypter", () => {
  test("round-trips a string, unicode and the empty string included", () => {
    const encrypter = new Encrypter({ keys: { k1 } });
    for (const value of ["figd_token", "", "ünïcødé ✓ 🔑", "a".repeat(10_000)]) {
      expect(encrypter.decrypt(encrypter.encrypt(value))).toBe(value);
    }
  });

  test("the envelope names its key and never contains the plaintext", () => {
    const encrypter = new Encrypter({ keys: { k1 } });
    const envelope = encrypter.encrypt("secret-value");
    expect(envelope).toMatch(/^v1:k1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain("secret-value");
    expect(encrypter.isEncrypted(envelope)).toBe(true);
    expect(encrypter.keyIdOf(envelope)).toBe("k1");
  });

  test("encrypting the same value twice gives two different envelopes", () => {
    const encrypter = new Encrypter({ keys: { k1 } });
    expect(encrypter.encrypt("same")).not.toBe(encrypter.encrypt("same"));
  });

  test("accepts a base64: prefix and url-safe base64", () => {
    const bytes = randomBytes(32);
    const a = new Encrypter({ keys: { k1: `base64:${bytes.toString("base64")}` } });
    const b = new Encrypter({ keys: { k1: bytes.toString("base64url") } });
    expect(b.decrypt(a.encrypt("x"))).toBe("x");
  });

  describe("rotation", () => {
    test("values under an older key still decrypt after current moves", () => {
      const before = new Encrypter({ keys: { k1 } });
      const old = before.encrypt("written before the rotation");

      const after = new Encrypter({ keys: { k1, k2 }, current: "k2" });
      expect(after.decrypt(old)).toBe("written before the rotation");
      expect(after.keyIdOf(after.encrypt("new"))).toBe("k2");
    });

    test("needsReencryption is true for an older key and for plaintext", () => {
      const encrypter = new Encrypter({ keys: { k1, k2 }, current: "k2" });
      const old = new Encrypter({ keys: { k1 } }).encrypt("x");
      expect(encrypter.needsReencryption(old)).toBe(true);
      expect(encrypter.needsReencryption(encrypter.encrypt("x"))).toBe(false);
      expect(encrypter.needsReencryption("plain text")).toBe(true);
    });

    test("a value whose key was removed fails with unknown_key", () => {
      const old = new Encrypter({ keys: { k1 } }).encrypt("x");
      const error = catchError(() => new Encrypter({ keys: { k2 } }).decrypt(old));
      expect(error).toBeInstanceOf(DecryptionError);
      expect(error.reason).toBe("unknown_key");
      expect(error.message).toContain('"k1"');
    });
  });

  describe("never returns what it cannot authenticate", () => {
    const encrypter = new Encrypter({ keys: { k1, k2 }, current: "k1" });

    test("a tampered ciphertext", () => {
      const envelope = encrypter.encrypt("value");
      const parts = envelope.split(":");
      const body = Buffer.from(parts[3], "base64url");
      body[0] ^= 1;
      parts[3] = body.toString("base64url");
      expect(catchError(() => encrypter.decrypt(parts.join(":"))).reason).toBe("invalid");
    });

    test("a key id edited to point at another configured key", () => {
      const envelope = encrypter.encrypt("value").replace("v1:k1:", "v1:k2:");
      expect(catchError(() => encrypter.decrypt(envelope)).reason).toBe("invalid");
    });

    test("a different key under the same id", () => {
      const other = new Encrypter({ keys: { k1: k2 } }).encrypt("value");
      expect(catchError(() => encrypter.decrypt(other)).reason).toBe("invalid");
    });

    test.each([["plaintext"], [""], ["v1:k1:abc"], ["v2:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA"]])(
      "a value that is not an envelope: %j",
      (value) => {
        const error = catchError(() => encrypter.decrypt(value));
        expect(error).toBeInstanceOf(DecryptionError);
        expect(error.reason).toBe("malformed");
        expect(error.message).not.toContain(value === "" ? "\u0000" : value);
      },
    );
  });

  describe("configuration", () => {
    test("one key is current without saying so", () => {
      expect(new Encrypter({ keys: { only: k1 } }).currentKeyId).toBe("only");
    });

    test.each([
      ["an empty key (an unset env var)", { keys: { k1: undefined } }, /empty/],
      ["a key that is not 32 bytes", { keys: { k1: Buffer.alloc(16).toString("base64") } }, /32 bytes/],
      ["a key that is not base64", { keys: { k1: "not a key!" } }, /32 bytes/],
      ["a bad key id", { keys: { "k:1": k1 } }, /not valid/],
      ["current naming no key", { keys: { k1 }, current: "k2" }, /no key by that id/],
      ["two keys and no current", { keys: { k1, k2 } }, /no encryption.current/],
    ] as const)("refuses %s at construction", (_label, config, message) => {
      expect(() => new Encrypter(config as never)).toThrow(EncryptionKeyError);
      expect(() => new Encrypter(config as never)).toThrow(message);
    });

    test("no keys is a valid, unconfigured state that fails on use", () => {
      const encrypter = new Encrypter({});
      expect(encrypter.configured).toBe(false);
      expect(() => encrypter.encrypt("x")).toThrow(EncryptionKeyError);
      expect(() => encrypter.decrypt(new Encrypter({ keys: { k1 } }).encrypt("x"))).toThrow(
        EncryptionKeyError,
      );
    });

    test("encrypt refuses a non-string", () => {
      expect(() => new Encrypter({ keys: { k1 } }).encrypt(42 as never)).toThrow(TypeError);
    });
  });
});

function catchError(fn: () => unknown): DecryptionError {
  try {
    fn();
  } catch (error) {
    return error as DecryptionError;
  }
  throw new Error("expected a throw");
}
