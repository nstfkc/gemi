import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runMigrate } from "./index";

/**
 * What `gemi migrate` does to an app that has **already** migrated.
 *
 * The command advertises itself as a no-op without an `app/kernel/providers/`
 * directory, and it was not one. Steps 2 and 3 ran unconditionally, so on a
 * current app it rewrote `Kernel.ts` from the slices it had just generated —
 * of which there were none — and carried the Kernel's existing `config` member
 * over commented out, on the grounds that `buildKernel` writes that member
 * itself and anything already there is an unrecognised leftover.
 *
 * `config` is part of the current Kernel shape (`kernel/Kernel.ts`), so that is
 * not a leftover, it is the app's configuration. Commenting it out leaves a file
 * that compiles and an app that boots with **every config slice silently
 * unmerged** — no error, no crash, just defaults everywhere. The failure mode
 * has no symptom at the point of the change.
 *
 * That is worth a test rather than a fix on its own because of who runs this
 * command. An app still on 0.42 gets the rewrite it asked for; an app on the
 * current layout runs it to find out what *else* changed — which is exactly the
 * case that was destructive, and exactly the case no fixture covered.
 */
const KERNEL_43 = `import { Kernel as BaseKernel } from "gemi/kernel";
import authConfig from "../config/auth";

export default class Kernel extends BaseKernel {
  config = { auth: authConfig };
}
`;

const CONFIG_43 = `import { defineAuthConfig } from "gemi/services";
import { OrgProvisioningAuthAdapter } from "@/app/kernel/adapters/OrgProvisioningAuthAdapter";

export default defineAuthConfig({
  verifyEmail: false,
  userProvider: new OrgProvisioningAuthAdapter(prisma),
});
`;

const PROVIDER_42 = `import { AuthenticationServiceProvider } from "gemi/services";
import { PrismaAuthenticationAdapter } from "gemi/kernel";

export default class AuthServiceProvider extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);
  verifyEmail = false;
}
`;

let root: string;
let logged: string[];

/**
 * `runMigrate` reports through `console.log`. Most assertions read the tree
 * instead, but the summary is this command's entire output surface, so it is
 * captured rather than discarded.
 */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gemi-migrate-"));
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string) {
  const file = join(root, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

const read = (relative: string) => readFileSync(join(root, relative), "utf8");
const exists = (relative: string) => {
  try {
    readFileSync(join(root, relative));
    return true;
  } catch {
    return false;
  }
};

describe("an app already on the config + container layout", () => {
  beforeEach(async () => {
    write("app/kernel/Kernel.ts", KERNEL_43);
    write("app/config/auth.ts", CONFIG_43);
    await runMigrate({ rootDir: root });
  });

  test("its Kernel is left exactly as it was", () => {
    // Byte-identical, not merely "still has a config member": the bug commented
    // the member out rather than dropping it, so a substring check for `config`
    // passes on the broken output.
    expect(read("app/kernel/Kernel.ts")).toBe(KERNEL_43);
  });

  test("no AppServiceProvider is invented for it", () => {
    expect(exists("app/providers/AppServiceProvider.ts")).toBe(false);
  });

  test("the retired config field is marked where it is", () => {
    const config = read("app/config/auth.ts");
    expect(config).toContain("TODO(gemi-migrate)");
    // Marked, not removed — the value is an expression the app wrote.
    expect(config).toContain("userProvider: new OrgProvisioningAuthAdapter(prisma)");
    expect(config).toContain("UserProvider");
  });

  test("a second run does not stack a second TODO", async () => {
    await runMigrate({ rootDir: root });
    const occurrences = read("app/config/auth.ts").match(/TODO\(gemi-migrate\)/g);
    expect(occurrences).toHaveLength(1);
  });
});

describe("a config file whose retired field is not the first match", () => {
  test("the real top-level field is annotated, not just the first name-alike", async () => {
    // The nested key is the false positive the line-matching approach accepts.
    // Annotating only the first match turned that into a false *negative*: the
    // nested one absorbed the TODO and the real retired field went unmarked,
    // which is the single outcome this pass exists to prevent.
    write(
      "app/config/auth.ts",
      `import { defineAuthConfig } from "gemi/services";

export default defineAuthConfig({
  social: {
    userProvider: "unrelated",
  },
  userProvider: new OrgAdapter(prisma),
});
`,
    );
    await runMigrate({ rootDir: root });

    const lines = read("app/config/auth.ts").split("\n");
    const real = lines.findIndex((line) => line.startsWith("  userProvider:"));
    expect(real).toBeGreaterThan(-1);
    expect(lines[real - 1]).toContain("TODO(gemi-migrate)");
  });
});

describe("a half-migrated app: providers AND a hand-written config", () => {
  const HANDWRITTEN = `import { defineAuthConfig } from "gemi/services";

export default defineAuthConfig({
  handcrafted: true,
  redirectPath: "/somewhere-important",
});
`;

  beforeEach(async () => {
    write("app/kernel/Kernel.ts", `import { Kernel } from "gemi/kernel";
export default class extends Kernel {}
`);
    write("app/kernel/providers/AuthenticationServiceProvider.ts", PROVIDER_42);
    write("app/config/auth.ts", HANDWRITTEN);
    await runMigrate({ rootDir: root });
  });

  test("the hand-written config survives untouched", () => {
    // It used to be replaced wholesale by the provider-derived file, under an
    // `update` line and a "Nothing needs manual attention" summary. Both files
    // are the app's, and neither is derivable from the other.
    expect(read("app/config/auth.ts")).toBe(HANDWRITTEN);
  });

  test("the provider it would have come from is left on disk", () => {
    // Deleting it would strand the only copy of the settings the config file
    // was not allowed to receive.
    expect(exists("app/kernel/providers/AuthenticationServiceProvider.ts")).toBe(true);
  });
});

describe("an app still on the 0.42 provider layout", () => {
  beforeEach(async () => {
    write("app/kernel/Kernel.ts", `import { Kernel } from "gemi/kernel";
export default class extends Kernel {}
`);
    write("app/kernel/providers/AuthenticationServiceProvider.ts", PROVIDER_42);
    await runMigrate({ rootDir: root });
  });

  test("still gets the provider-to-config rewrite", () => {
    const kernel = read("app/kernel/Kernel.ts");
    expect(kernel).toContain("config = {");
    expect(kernel).toContain("auth,");
    expect(exists("app/providers/AppServiceProvider.ts")).toBe(true);
    expect(exists("app/kernel/providers/AuthenticationServiceProvider.ts")).toBe(false);
  });

  test("the retired-adapter sentence is reported once, not once per table", () => {
    // The same sentence reaches the report twice for this file — once from
    // `DELETED_EXPORTS` on the import, once from `memberRemovals` on the
    // member — and they differ only by the `` `adapter` — `` qualifier, so an
    // exact-string dedup did not see them. A ~330-character paragraph printed
    // twice under one filename is most of the report.
    const summary = logged.join("\n");
    const occurrences = summary.match(/The authentication adapter seam was removed/g);
    expect(occurrences).toHaveLength(1);

    // And the surviving copy is the one that says which member to look at.
    expect(summary).toContain("`adapter` — The authentication adapter seam was removed");
  });

  test("the retired adapter member is commented out rather than renamed", () => {
    const config = read("app/config/auth.ts");
    // It used to become `userProvider`, a field `AuthConfig` no longer has —
    // a migration whose output does not type-check.
    expect(config).not.toMatch(/^\s*userProvider:/m);
    expect(config).toContain("// adapter = new PrismaAuthenticationAdapter(prisma);");
    expect(config).toContain("verifyEmail: false");
  });
});
