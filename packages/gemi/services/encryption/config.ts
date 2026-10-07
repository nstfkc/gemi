// Config key: `encryption`. Read by `EncryptionServiceProvider`.
export interface EncryptionConfig {
  /**
   * Every key that may have encrypted a value, by id. A key is 32 random
   * bytes, base64 encoded (`openssl rand -base64 32`); a `base64:` prefix is
   * accepted and ignored.
   *
   * The id is written into every value encrypted with the key, so it is how a
   * value finds its key again after a rotation. Ids are short names you choose
   * (`k1`, `2026-10`), made of letters, digits, `_` and `-`. Never reuse an id
   * for a different key: values written under the old one would stop
   * decrypting.
   *
   * Keep an old key here until `gemi run encryption:rotate` has re-encrypted
   * everything it wrote. A key removed early makes those values unreadable.
   */
  keys?: Record<string, string | undefined>;

  /**
   * The id of the key new values are encrypted with. Must name an entry in
   * `keys`. May be omitted when there is exactly one key.
   */
  current?: string;
}

/**
 * Identity helper for `app/config/encryption.ts`:
 *
 * ```ts
 * import { defineEncryptionConfig } from "gemi/services";
 *
 * export default defineEncryptionConfig({
 *   keys: { k1: process.env.APP_ENCRYPTION_KEY },
 *   current: "k1",
 * });
 * ```
 */
export function defineEncryptionConfig(config: EncryptionConfig): EncryptionConfig {
  return config;
}
