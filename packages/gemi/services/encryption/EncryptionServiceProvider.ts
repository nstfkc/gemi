import { encryptedColumnsInRegistry } from "../../orm/encryption";
import { ServiceProvider } from "../../support/ServiceProvider";
import type { EncryptionConfig } from "./config";
import { Encrypter, EncryptionKeyError } from "./Encrypter";

export class EncryptionServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      Encrypter,
      () => new Encrypter(this.app.config.get<EncryptionConfig>("encryption", {})),
    );
  }

  /**
   * A bad key fails the boot, not the first request that reads an encrypted
   * column: constructing the `Encrypter` validates every key, and an app whose
   * models have encrypted columns, or that configures OAuth connections,
   * must have one configured. An app with
   * neither pays for nothing but this check.
   */
  boot() {
    const encrypter = this.app.make(Encrypter);
    if (encrypter.configured) return;

    // OAuth connections (#845) keep their tokens encrypted in gemi's table.
    const auth = this.app.config.get<{ connections?: Record<string, unknown>; connectionStore?: unknown }>("auth", {});
    const connections = Object.keys(auth?.connections ?? {});
    if (connections.length > 0 && !auth?.connectionStore) {
      throw new EncryptionKeyError(
        `auth.connections (${connections.join(", ")}) keeps OAuth tokens encrypted, ` +
          "but no encryption key is configured. Add app/config/encryption.ts " +
          "(defineEncryptionConfig({ keys: { k1: process.env.APP_ENCRYPTION_KEY } })) " +
          "and list it as `encryption` in your Kernel's config. Generate a key " +
          "with `openssl rand -base64 32`.",
      );
    }

    const columns = encryptedColumnsInRegistry();
    if (columns.length === 0) return;

    throw new EncryptionKeyError(
      `${columns.join(", ")} ${columns.length === 1 ? "is an encrypted column" : "are encrypted columns"}, ` +
        "but no encryption key is configured. Add app/config/encryption.ts " +
        "(defineEncryptionConfig({ keys: { k1: process.env.APP_ENCRYPTION_KEY } })) " +
        "and list it as `encryption` in your Kernel's config. Generate a key " +
        "with `openssl rand -base64 32`.",
    );
  }
}
