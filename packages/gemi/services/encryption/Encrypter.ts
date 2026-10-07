import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EncryptionConfig } from "./config";

/**
 * Authenticated encryption for values at rest: encrypted columns
 * (`/// @gemi.encrypted` in the Prisma schema) and the `Crypt` facade.
 *
 * AES-256-GCM with a random 96-bit IV per value, so encrypting the same
 * plaintext twice gives two different ciphertexts, and a value that was
 * altered, truncated or encrypted under another key fails to decrypt rather
 * than decrypting to something else.
 *
 * Every value is a self-describing envelope:
 *
 *     v1:<keyId>:<iv>:<ciphertext+tag>       (iv and ciphertext base64url)
 *
 * The key id is what makes rotation work: a value names the key it was
 * written with, so after `current` moves to a new key the old values still
 * decrypt as long as their key stays in `keys`, and `encryption:rotate` can
 * tell which values still need re-encrypting without decrypting them. The
 * `v1:<keyId>` prefix is authenticated as associated data, so it cannot be
 * edited to point a value at a different key.
 *
 * The envelope is plain ASCII, so it fits any text column. It is longer than
 * the plaintext: 4/3 of it plus about 50 characters.
 */
export class Encrypter {
  static token = "encrypter";

  private readonly keys = new Map<string, Buffer>();
  private readonly currentId: string | undefined;

  /**
   * @throws EncryptionKeyError when a key is empty or not 32 bytes, an id is
   * not a valid name, or `current` names no key. Construction is where a bad
   * configuration is reported, which is why the provider builds this at boot.
   */
  constructor(config: EncryptionConfig = {}) {
    for (const [id, value] of Object.entries(config.keys ?? {})) {
      if (!KEY_ID.test(id)) {
        throw new EncryptionKeyError(
          `Encryption key id "${id}" is not valid. Use 1-32 letters, digits, ` +
            `"_" or "-": the id is written into every encrypted value.`,
        );
      }
      this.keys.set(id, parseKey(id, value));
    }

    if (config.current !== undefined) {
      if (!this.keys.has(config.current)) {
        throw new EncryptionKeyError(
          `encryption.current is "${config.current}", but encryption.keys has ` +
            `no key by that id (${describeIds(this.keys)}).`,
        );
      }
      this.currentId = config.current;
    } else if (this.keys.size === 1) {
      this.currentId = [...this.keys.keys()][0];
    } else if (this.keys.size > 1) {
      throw new EncryptionKeyError(
        `encryption.keys has ${this.keys.size} keys (${describeIds(this.keys)}) ` +
          `and no encryption.current to say which one encrypts new values.`,
      );
    }
  }

  /** Whether a key is configured at all. */
  get configured(): boolean {
    return this.currentId !== undefined;
  }

  /** The id of the key new values are encrypted with. */
  get currentKeyId(): string {
    return this.requireCurrent();
  }

  /** Encrypts `plaintext` under the current key. */
  encrypt(plaintext: string): string {
    if (typeof plaintext !== "string") {
      throw new TypeError(
        `Encrypter.encrypt takes a string, got ${describeValue(plaintext)}. ` +
          `Serialise other values first (JSON.stringify).`,
      );
    }
    const id = this.requireCurrent();
    const key = this.keys.get(id)!;
    const header = `${VERSION}:${id}`;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(header));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${header}:${iv.toString("base64url")}:${body.toString("base64url")}`;
  }

  /**
   * The plaintext of an envelope `encrypt` produced, under whichever
   * configured key it names.
   *
   * @throws DecryptionError when the value is not an envelope, names a key
   * that is not configured, or fails authentication (tampered, truncated, or
   * encrypted under a different key with the same id). Never returns the input.
   */
  decrypt(envelope: string): string {
    const parsed = parseEnvelope(envelope);
    if (!parsed) {
      throw new DecryptionError("malformed", "The value is not an encrypted envelope.");
    }
    if (!this.configured) this.requireCurrent();
    const key = this.keys.get(parsed.keyId);
    if (!key) {
      throw new DecryptionError(
        "unknown_key",
        `The value was encrypted with key "${parsed.keyId}", which is not in ` +
          `encryption.keys (${describeIds(this.keys)}). Keep a key configured ` +
          `until encryption:rotate has re-encrypted the values written with it.`,
      );
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, parsed.iv);
      decipher.setAAD(Buffer.from(`${VERSION}:${parsed.keyId}`));
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new DecryptionError(
        "invalid",
        `The value did not authenticate under key "${parsed.keyId}": it was ` +
          `altered, or encrypted with a different key under the same id.`,
      );
    }
  }

  /** Whether `value` has the shape of an envelope. Says nothing about its key. */
  isEncrypted(value: unknown): value is string {
    return parseEnvelope(value) !== null;
  }

  /** The key id an envelope names, or `null` when `value` is not one. */
  keyIdOf(value: unknown): string | null {
    return parseEnvelope(value)?.keyId ?? null;
  }

  /**
   * Whether `value` should be re-encrypted to be under the current key: true
   * for an envelope under an older key and for anything that is not an
   * envelope at all (a plaintext value written before the column was
   * encrypted).
   */
  needsReencryption(value: string): boolean {
    return this.keyIdOf(value) !== this.requireCurrent();
  }

  private requireCurrent(): string {
    if (this.currentId === undefined) {
      throw new EncryptionKeyError(
        "No encryption key is configured. Add app/config/encryption.ts " +
          "(defineEncryptionConfig({ keys: { k1: process.env.APP_ENCRYPTION_KEY } })) " +
          "and list it as `encryption` in your Kernel's config. Generate a key " +
          "with `openssl rand -base64 32`.",
      );
    }
    return this.currentId;
  }
}

/**
 * The encryption configuration is unusable: no key, a key that is not 32
 * bytes, or a `current` naming no key. Raised at boot when the app has
 * encrypted columns, and by the first encrypt or decrypt otherwise.
 */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/**
 * A value could not be decrypted. `reason` says why: `malformed` (not an
 * envelope, such as a plaintext value written before the column was
 * encrypted), `unknown_key` (its key is no longer configured) or `invalid`
 * (it failed authentication). The value itself is never in the message.
 */
export class DecryptionError extends Error {
  /** The model and field, when the value came from an encrypted column. */
  column?: { model: string; field: string };

  constructor(
    public readonly reason: "malformed" | "unknown_key" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "DecryptionError";
  }
}

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function parseKey(id: string, value: string | undefined): Buffer {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EncryptionKeyError(
      `Encryption key "${id}" is empty. Is the environment variable it reads set?`,
    );
  }
  const text = value.trim().replace(/^base64:/, "");
  const bytes = /^[A-Za-z0-9+/=_-]+$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (bytes.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `Encryption key "${id}" is not ${KEY_BYTES} bytes of base64 ` +
        `(it decodes to ${bytes.length}). Generate one with ` +
        "`openssl rand -base64 32`.",
    );
  }
  return bytes;
}

interface Envelope {
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function parseEnvelope(value: unknown): Envelope | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, keyId, iv, body] = parts;
  if (!KEY_ID.test(keyId) || !BASE64URL.test(iv) || !BASE64URL.test(body)) return null;
  const ivBytes = Buffer.from(iv, "base64url");
  const bodyBytes = Buffer.from(body, "base64url");
  if (ivBytes.length !== IV_BYTES || bodyBytes.length < TAG_BYTES) return null;
  return {
    keyId,
    iv: ivBytes,
    ciphertext: bodyBytes.subarray(0, bodyBytes.length - TAG_BYTES),
    tag: bodyBytes.subarray(bodyBytes.length - TAG_BYTES),
  };
}

function describeIds(keys: Map<string, unknown>): string {
  return keys.size === 0 ? "none configured" : [...keys.keys()].map((id) => `"${id}"`).join(", ");
}

function describeValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
}
