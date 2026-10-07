import { ConnectionManager } from "../auth/connections/ConnectionManager";
import { DatabaseConnectionStore } from "../auth/connections/ConnectionStore";
import { app } from "../foundation/app";
import { encryptedColumnsInRegistry } from "../orm/encryption";
import { rotateEncryptedColumns } from "../orm/encryption-rotate";
import { defineCommand } from "./builder";
import type { CommandClass } from "./Command";

/**
 * `gemi run encryption:rotate [Model]` (#844): re-encrypts encrypted columns
 * still under an older key, after `encryption.current` has moved to a new one.
 * Without a model it also re-encrypts the OAuth connection tokens (#845).
 */
export const EncryptionRotateCommand = defineCommand("encryption:rotate")
  .describe("Re-encrypt encrypted columns that are still under an older key")
  .arg("model", {
    description: "The model to rotate. Omit to rotate every model with encrypted columns",
  })
  .option("batchSize", {
    type: "number",
    default: 500,
    description: "Rows read and rewritten per batch",
  })
  .option("dryRun", {
    type: "boolean",
    description: "Count what would be re-encrypted, and write nothing",
  })
  .option("encryptPlaintext", {
    type: "boolean",
    description:
      "Also encrypt values that are not encrypted yet (a column just marked @gemi.encrypted)",
  })
  .handle(async ({ args, options, line, fail }) => {
    const models = args.model
      ? [args.model]
      : [...new Set(encryptedColumnsInRegistry().map((column) => column.split(".")[0]))];
    // OAuth connection tokens (#845) live in gemi's own table, not a model.
    const connections = args.model ? null : connectionStoreToRotate();
    if (models.length === 0 && !connections) {
      line("No model has encrypted columns.");
      return;
    }
    if (connections) {
      const report = await connections.rotateEncryption({ dryRun: options.dryRun });
      line(
        `OAuth connections: ${report.scanned} rows, ` +
          `${report.rotated} ${options.dryRun ? "to re-encrypt" : "re-encrypted"}`,
      );
    }

    let plaintext = 0;
    for (const model of models) {
      const report = await rotateEncryptedColumns(model, {
        batchSize: options.batchSize,
        dryRun: options.dryRun,
        encryptPlaintext: options.encryptPlaintext,
      });
      plaintext += report.plaintext;
      line(
        `${report.model} (${report.fields.join(", ")}): ${report.scanned} rows, ` +
          `${report.rotated} ${options.dryRun ? "to re-encrypt" : "re-encrypted"}` +
          (report.skipped > 0 ? `, ${report.skipped} changed meanwhile (already current)` : "") +
          (report.plaintext > 0 ? `, ${report.plaintext} not encrypted yet` : ""),
      );
    }

    if (plaintext > 0) {
      fail(
        `${plaintext} value${plaintext === 1 ? " is" : "s are"} not encrypted. If the ` +
          "column was just marked @gemi.encrypted, run again with --encrypt-plaintext.",
      );
    }
  });

/** The app's connection store, when it is gemi's table and some provider is configured. */
function connectionStoreToRotate(): DatabaseConnectionStore | null {
  const application = app();
  if (!application.bound(ConnectionManager)) return null;
  const manager = application.make(ConnectionManager);
  if (Object.keys(manager.providers).length === 0) return null;
  const store = manager.store;
  return store instanceof DatabaseConnectionStore ? store : null;
}

/**
 * Commands gemi itself provides. Reachable by name from every app, listed
 * after the app's own, and shadowed by an app command of the same name.
 */
export const frameworkCommands: CommandClass[] = [EncryptionRotateCommand];
