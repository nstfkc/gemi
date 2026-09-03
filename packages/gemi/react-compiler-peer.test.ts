import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The `oxc-transform-react` pin, held against the peer range that justifies it.
 *
 * `@vitejs/plugin-react` declares `oxc-transform-react` as an *optional* peer at
 * `^0.145.0`, and npm's latest is already `0.148.0` — outside it, because
 * `^0.145.0` on a `0.x` means `>=0.145.0 <0.146.0`. So the template pins
 * `^0.145.0` to match.
 *
 * Until this file existed, the only record of that reasoning was prose: a
 * paragraph in `docs/configuration.md` and a note in a PR description. Neither
 * fails when it stops being true. The template pins the *plugin* at `^6.1.1`, so
 * a `6.2.0` that widens the peer range arrives on the next `bun install` — and
 * the first person to see the resulting peer warning is someone who scaffolded
 * an app, not anyone working in this repo.
 *
 * This asserts the two ranges still agree. When it fails, upstream has moved:
 * read the plugin's new range, update the template to match, and update the
 * paragraph in `docs/configuration.md` that explains the pin.
 */

const ROOT = import.meta.dirname;
const TEMPLATE = join(ROOT, "../../templates/saas-starter");

function json(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("the oxc-transform-react pin", () => {
  const templateManifest = join(TEMPLATE, "package.json");
  const pluginManifest = join(TEMPLATE, "node_modules/@vitejs/plugin-react/package.json");

  test("the template declares the dependency at all", () => {
    // Its absence is not a passing state: `react({ compiler: … })` fails the
    // build with "React Compiler requires the optional `oxc-transform-react`
    // package" when it is missing.
    const { devDependencies } = json(templateManifest);
    expect(devDependencies["oxc-transform-react"]).toBeTruthy();
  });

  test.skipIf(!existsSync(pluginManifest))(
    "matches the optional-peer range @vitejs/plugin-react declares",
    () => {
      // Skipped rather than failed when the template's node_modules is absent —
      // this asserts a fact about an installed tree, and a fresh checkout that
      // has not run `bun install` has no tree to assert about. CI installs.
      const pinned = json(templateManifest).devDependencies["oxc-transform-react"];
      const peer = json(pluginManifest).peerDependencies?.["oxc-transform-react"];

      expect(
        peer,
        "@vitejs/plugin-react no longer declares an `oxc-transform-react` peer — " +
          "the pin in templates/saas-starter/package.json may no longer be needed.",
      ).toBeTruthy();
      expect(
        pinned,
        `templates/saas-starter pins oxc-transform-react at ${pinned}, but ` +
          `@vitejs/plugin-react now declares the peer as ${peer}. Update the ` +
          "template to match, and the pin's explanation in docs/configuration.md.",
      ).toBe(peer);
    },
  );
});
