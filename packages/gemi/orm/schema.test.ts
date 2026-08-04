import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  assertSchemaArtifactVersion,
  SCHEMA_ARTIFACT_VERSION,
  StaleSchemaArtifactError,
} from "./schema";

/**
 * The generated artifact's version handshake, which had no test.
 *
 * It was missed by the coverage measurement in #119 for a specific reason worth
 * recording: that pass enumerated error classes out of `errors.ts`, and this
 * one is declared in `schema.ts`. Two of the ORM's twenty live outside that
 * file — this and `UnsupportedDialectError` — so "18 classes" was the count of
 * a file rather than of the ORM. `UnsupportedDialectError` turned out to be
 * well covered by `dialect/unsupported.test.ts`; this one was not covered at
 * all.
 *
 * What it guards is ordinary rather than exotic: upgrading gemi without
 * re-running `prisma generate`. The generated `index.ts` calls this with its own
 * version literal at import time, so the mismatch is caught at registration —
 * before any query — and the message says which way round the versions are and
 * what to run.
 */
describe("the generated artifact's version", () => {
  test("the current version is accepted", () => {
    expect(() => assertSchemaArtifactVersion(SCHEMA_ARTIFACT_VERSION)).not.toThrow();
  });

  /**
   * Both directions. An artifact from a *newer* gemi is as much a mismatch as
   * one from an older gemi, and the check is `!==` rather than `<` precisely so
   * that downgrading is caught too — a comparison that only looked for "older"
   * would pass an artifact this version cannot read.
   */
  test.each([
    ["older", SCHEMA_ARTIFACT_VERSION - 1],
    ["newer", SCHEMA_ARTIFACT_VERSION + 1],
    ["much older", 0],
  ])("an artifact from a %s gemi is refused", (_label, version) => {
    expect(() => assertSchemaArtifactVersion(version)).toThrow(StaleSchemaArtifactError);
  });

  /**
   * The message is the whole diagnosis — an author who hits this has a stale
   * directory and nothing else to go on — so it has to carry both versions and
   * the command.
   */
  test("the message names both versions and what to run", () => {
    let error: StaleSchemaArtifactError | null = null;
    try {
      assertSchemaArtifactVersion(7);
    } catch (raised) {
      error = raised as StaleSchemaArtifactError;
    }

    expect(error).toBeInstanceOf(StaleSchemaArtifactError);
    expect(error!.name).toBe("StaleSchemaArtifactError");
    // What was found, what is wanted, and the fix.
    expect(error!.message).toContain("version 7");
    expect(error!.message).toContain(`version ${SCHEMA_ARTIFACT_VERSION}`);
    expect(error!.message).toContain("prisma generate");
    expect(error!.message).toContain("app/models/generated");
  });

  /**
   * ...and the template's committed artifact actually satisfies it.
   *
   * The unit assertions above would all pass with a generator that emitted a
   * constant this file has never seen. This is the half that ties the two
   * packages together — and it is the same handshake the generated `index.ts`
   * performs at import time.
   */
  test("the committed artifact declares the version this gemi reads", () => {
    const generated = readFileSync(
      join(import.meta.dirname, "../../../templates/saas-starter/app/models/generated/schema.ts"),
      "utf8",
    );

    const declared = generated.match(/export const ARTIFACT_VERSION = (\d+)/);
    expect(declared, "the artifact no longer declares a version").not.toBeNull();

    expect(Number(declared![1])).toBe(SCHEMA_ARTIFACT_VERSION);
    expect(() => assertSchemaArtifactVersion(Number(declared![1]))).not.toThrow();
  });
});
