import { runAsSystem, runWithTrashed } from "./context";
import { currentEncrypter, encryptedFields, markEncryptionRaw } from "./encryption";
import type { Model } from "./Model";
import * as registry from "./registry";
import type { ModelSchema } from "./schema";

export interface RotateEncryptionOptions {
  /** Rows read and rewritten per round trip. Default 500. */
  batchSize?: number;
  /** Count what would be re-encrypted, and write nothing. */
  dryRun?: boolean;
  /**
   * Also encrypt values that are not encrypted at all — the rows a column held
   * before it was marked `@gemi.encrypted`. Off by default, so a value that is
   * not an envelope is reported rather than silently treated as plaintext.
   */
  encryptPlaintext?: boolean;
  /** Called after each batch, for progress output. */
  onBatch?: (report: RotateEncryptionReport) => void;
}

export interface RotateEncryptionReport {
  model: string;
  fields: string[];
  /** Rows read. */
  scanned: number;
  /** Rows rewritten (or, on a dry run, that would be). */
  rotated: number;
  /** Rows a concurrent write changed between the read and the rewrite; already current. */
  skipped: number;
  /** Values that are not envelopes, left alone because `encryptPlaintext` is off. */
  plaintext: number;
}

/**
 * Re-encrypts `model`'s encrypted columns under the current key: every value
 * still under an older key and, with `encryptPlaintext`, every value not
 * encrypted yet. What `gemi run encryption:rotate` runs.
 *
 * Walks the table in primary-key order in batches, so it can run against a
 * live database and be re-run safely: each row is rewritten with a
 * compare-and-swap on the values it read, so a row written concurrently (and
 * therefore already under the current key) is skipped rather than
 * overwritten. Runs as the system (no policies) and includes soft-deleted
 * rows — they are still encrypted with the old key.
 *
 * Remove the old key from `encryption.keys` only after this reports nothing
 * left to rotate.
 */
export async function rotateEncryptedColumns(
  model: string | typeof Model,
  options: RotateEncryptionOptions = {},
): Promise<RotateEncryptionReport> {
  const target = (typeof model === "string" ? registry.get<typeof Model>(model) : model) as typeof Model & {
    $exec: typeof Model.$exec;
  };
  const schema: ModelSchema = target.$schema;
  const fields = [...encryptedFields(schema)];
  if (fields.length === 0) {
    throw new Error(`${schema.name} has no encrypted columns (mark a String field /// @gemi.encrypted).`);
  }
  const primaryKey = schema.primaryKey;
  if (primaryKey.length === 0) {
    throw new Error(`${schema.name} has no primary key, so its rows cannot be rewritten one by one.`);
  }

  const encrypter = currentEncrypter();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
  const report: RotateEncryptionReport = {
    model: schema.name,
    fields,
    scanned: 0,
    rotated: 0,
    skipped: 0,
    plaintext: 0,
  };

  const raw = markEncryptionRaw({});
  const select = Object.fromEntries([...primaryKey, ...fields].map((name) => [name, true]));
  const orderBy = primaryKey.map((name) => ({ [name]: "asc" }));
  const single = primaryKey.length === 1 ? primaryKey[0] : undefined;

  await runAsSystem(() =>
    runWithTrashed(schema.name, "with", async () => {
      let after: unknown = undefined;
      let offset = 0;

      for (;;) {
        // Keyset pagination on a single-column key, so a rewrite never moves a
        // row across a page boundary. A compound key pages by offset, which is
        // stable here because rewriting a column does not change the key.
        const rows = (await target.$exec(
          "findMany",
          {
            select,
            orderBy,
            take: batchSize,
            ...(single !== undefined && after !== undefined ? { where: { [single]: { gt: after } } } : {}),
            ...(single === undefined ? { skip: offset } : {}),
          },
          raw,
        )) as Record<string, unknown>[];
        if (rows.length === 0) break;

        for (const row of rows) {
          report.scanned += 1;
          const data: Record<string, string> = {};
          const where: Record<string, unknown> = {};
          for (const name of primaryKey) where[name] = row[name];

          for (const field of fields) {
            const value = row[field];
            if (typeof value !== "string" || !encrypter.needsReencryption(value)) continue;
            const isEnvelope = encrypter.isEncrypted(value);
            if (!isEnvelope && !options.encryptPlaintext) {
              report.plaintext += 1;
              continue;
            }
            const plaintext = isEnvelope ? encrypter.decrypt(value) : value;
            data[field] = encrypter.encrypt(plaintext);
            where[field] = value;
          }

          if (Object.keys(data).length === 0) continue;
          if (options.dryRun) {
            report.rotated += 1;
            continue;
          }
          const { count } = (await target.$exec("updateMany", { where, data }, raw)) as {
            count: number;
          };
          if (count === 1) report.rotated += 1;
          else report.skipped += 1;
        }

        options.onBatch?.({ ...report });
        if (rows.length < batchSize) break;
        if (single !== undefined) after = rows[rows.length - 1][single];
        else offset += rows.length;
      }
    }),
  );

  return report;
}

