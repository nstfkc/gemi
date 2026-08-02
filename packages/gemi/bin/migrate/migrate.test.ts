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

/** `runMigrate` reports through `console.log`; the assertions read the tree. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gemi-migrate-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
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

  test("the retired adapter member is commented out rather than renamed", () => {
    const config = read("app/config/auth.ts");
    // It used to become `userProvider`, a field `AuthConfig` no longer has —
    // a migration whose output does not type-check.
    expect(config).not.toMatch(/^\s*userProvider:/m);
    expect(config).toContain("// adapter = new PrismaAuthenticationAdapter(prisma);");
    expect(config).toContain("verifyEmail: false");
  });
});
