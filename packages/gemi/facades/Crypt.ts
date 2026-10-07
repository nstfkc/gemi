import { Encrypter } from "../services/encryption/Encrypter";
import { Facade } from "./Facade";

/**
 * Encrypts and decrypts strings with the app's encryption keys
 * (`app/config/encryption.ts`) — the same keys and envelope as encrypted
 * columns, for a secret that is not a column: a value in a JSON blob, a token
 * in a queued job's payload, a file.
 *
 * ```ts
 * const sealed = Crypt.encrypt(apiKey); // "v1:k1:…"
 * const apiKey = Crypt.decrypt(sealed);
 * ```
 *
 * `decrypt` throws `DecryptionError` for anything it cannot authenticate;
 * it never returns its input.
 */
export class Crypt extends Facade {
  static getFacadeAccessor() {
    return Encrypter;
  }

  /** `plaintext`, encrypted under the current key. */
  static encrypt(plaintext: string): string {
    return this.getFacadeRoot().encrypt(plaintext);
  }

  /** The plaintext of a value `encrypt` produced, under any configured key. */
  static decrypt(value: string): string {
    return this.getFacadeRoot().decrypt(value);
  }

  /** Whether `value` is under an older key (or not encrypted at all). */
  static needsReencryption(value: string): boolean {
    return this.getFacadeRoot().needsReencryption(value);
  }
}
