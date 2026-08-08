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

/**
 * The two ORM-port passes (#356, #357).
 *
 * Neither is a rename, and neither can be one. What they look for is a *value* —
 * whether `limit` holds an integer, whether the error a `catch` receives came
 * from Prisma or from gemi — and a value is the one thing this command cannot
 * see, because `lex.ts` is a scanner and the answer is only known at run time.
 *
 * They earn their place anyway because both failures are invisible to everything
 * else. `tsc` accepts `Number(x)` as a `number` and accepts a guard over
 * `unknown` accepting anything; the unit suite passes integer literals and mocks
 * `{ code: "P2002" }`; and the failing inputs — a race, a hand-edited URL — are
 * ones the app itself never produces. Four green signals, and a defect under
 * them.
 *
 * The negative cases below are the more important half. A marker that fires on
 * correct code is one people learn to ignore, and these passes are already
 * accepting false positives by design — so the shapes that must stay quiet are
 * pinned as hard as the shapes that must speak.
 */
describe("the P2002 pass (#357)", () => {
  const GUARD = `import { AICredit } from "@/app/models";

export async function grant(userId: number) {
  try {
    return await AICredit.create({ data: { userId, amount: 10 } });
  } catch (error) {
    if (isRecord(error) && error.code === "P2002") {
      return AICredit.findFirst({ where: { userId } });
    }
    throw error;
  }
}
`;

  test("a P2002 literal beside a model import is annotated", async () => {
    write("app/services/credits.ts", GUARD);
    await runMigrate({ rootDir: root });

    const lines = read("app/services/credits.ts").split("\n");
    const guard = lines.findIndex((line) => line.includes('error.code === "P2002"'));
    expect(guard).toBeGreaterThan(0);

    const annotation = lines[guard - 1]!;
    expect(annotation).toContain("TODO(gemi-migrate)");
    // The three things a reader needs: what replaced the code, what to write
    // instead, and why nothing told them. The last is the whole point — a
    // reader whose tests pass will otherwise conclude the guard is fine.
    expect(annotation).toContain("UniqueConstraintError");
    expect(annotation).toContain("isUniqueConstraintError");
    expect(annotation).toContain("gemi/orm");
    expect(annotation).toContain("still passes");
    // Annotated, never rewritten: which `catch` arm belongs on which taxonomy
    // is a fact about which writers this app has already ported.
    expect(lines[guard]).toBe('    if (isRecord(error) && error.code === "P2002") {');
  });

  test("the same guard with no model import is left alone", async () => {
    // Still-Prisma code, where `code === "P2002"` is correct exactly as
    // written. Annotating it would teach the reader the marker means nothing.
    write(
      "app/services/legacy.ts",
      GUARD.replace(
        'import { AICredit } from "@/app/models";',
        'import { prisma } from "@prisma/client";',
      ).replace(/AICredit/g, "prisma.aICredit"),
    );
    await runMigrate({ rootDir: root });

    expect(read("app/services/legacy.ts")).not.toContain("TODO(gemi-migrate)");
  });

  test("a P2002 inside a comment is not a guard", async () => {
    // Also the mechanism that makes the pass idempotent: the annotation it
    // writes quotes `"P2002"` itself, so a pass that searched comments would
    // annotate its own output on the second run.
    write(
      "app/services/note.ts",
      `import { AICredit } from "@/app/models";

// Prisma used to raise P2002 here; the string "P2002" is only mentioned.
export const model = AICredit;
`,
    );
    await runMigrate({ rootDir: root });

    expect(read("app/services/note.ts")).not.toContain("TODO(gemi-migrate)");
  });

  test("a second run does not stack a second annotation", async () => {
    write("app/services/credits.ts", GUARD);
    await runMigrate({ rootDir: root });
    await runMigrate({ rootDir: root });

    const occurrences = read("app/services/credits.ts").match(
      /TODO\(gemi-migrate\)/g,
    );
    expect(occurrences).toHaveLength(1);
  });

  test("the report names the file, not just the tree", async () => {
    write("app/services/credits.ts", GUARD);
    await runMigrate({ rootDir: root });

    const summary = logged.join("\n");
    expect(summary).toContain("app/services/credits.ts");
    expect(summary).toContain("1 occurrence");
  });
});

describe("the take/skip pass (#356)", () => {
  test("a query-string page size is annotated, once per line", async () => {
    // The exact two lines #356 measured across nine controllers, including the
    // `skip` that is where a fractional `page` actually lands.
    write(
      "app/http/controllers/PostController.ts",
      `import { Controller } from "gemi/http";
import { Post } from "@/app/models";

export class PostController extends Controller {
  async index(req) {
    const limit = Number(req.search.get("limit")) || 25;
    const page = Number(req.search.get("page")) || 1;
    return Post.findMany({ take: limit, skip: limit * (page - 1) });
  }
}
`,
    );
    await runMigrate({ rootDir: root });

    const lines = read("app/http/controllers/PostController.ts").split("\n");
    const call = lines.findIndex((line) => line.includes("Post.findMany"));
    const annotation = lines[call - 1]!;
    expect(annotation).toContain("TODO(gemi-migrate)");
    expect(annotation).toContain("paginate");
    expect(annotation).toContain('Number(req.search.get("limit"))');
    // `page` gets the louder mention: it never reaches the ORM itself, so a
    // reader scanning for `take` misses it.
    expect(annotation).toContain("multiplied");
    // Both keys are on one line, and one sentence covers the line.
    expect(
      read("app/http/controllers/PostController.ts").match(/TODO\(gemi-migrate\)/g),
    ).toHaveLength(1);
  });

  test("the wording asks for a confirmation rather than reporting a bug", async () => {
    // The pass cannot tell a clamped constant from a query-string float, and
    // most non-literal `take`s are the former. An annotation that claimed a
    // defect would be wrong more often than right, and a marker that is wrong
    // more often than right is one that gets filtered out by eye.
    write(
      "app/http/controllers/PostController.ts",
      `import { Post } from "@/app/models";
export const list = (perPage) => Post.findMany({ take: perPage });
`,
    );
    await runMigrate({ rootDir: root });

    const annotation = read("app/http/controllers/PostController.ts")
      .split("\n")
      .find((line) => line.includes("TODO(gemi-migrate)"))!;
    expect(annotation).toContain("usually fine");
    expect(annotation).toContain("confirm");
  });

  test("an integer literal is not annotated", async () => {
    write(
      "app/http/controllers/FeedController.ts",
      `import { Post } from "@/app/models";
export const recent = () => Post.findMany({ take: 25, skip: 0 });
export const back = () => Post.findMany({ take: -5 });
`,
    );
    await runMigrate({ rootDir: root });

    expect(read("app/http/controllers/FeedController.ts")).not.toContain(
      "TODO(gemi-migrate)",
    );
  });

  test("a site that already truncates is not annotated", async () => {
    // Two of #356's nine call sites had already truncated. Flagging the sites
    // that carry the fix is the fastest way to turn the pass into noise.
    write(
      "app/http/controllers/TrimController.ts",
      `import { Post } from "@/app/models";
export const list = (raw, page) =>
  Post.findMany({ take: Math.trunc(raw), skip: parseInt(page, 10) });
`,
    );
    await runMigrate({ rootDir: root });

    expect(read("app/http/controllers/TrimController.ts")).not.toContain(
      "TODO(gemi-migrate)",
    );
  });

  test("arithmetic on a truncated value is still annotated", async () => {
    // `Math.trunc(a) / 2` is not integral, and it is the same shape to a
    // scanner as `Math.trunc(a) * b`. The exemption anchors on the whole value
    // so only the unambiguous spelling is let through.
    write(
      "app/http/controllers/HalfController.ts",
      `import { Post } from "@/app/models";
export const list = (raw) => Post.findMany({ take: Math.trunc(raw) / 2 });
`,
    );
    await runMigrate({ rootDir: root });

    expect(read("app/http/controllers/HalfController.ts")).toContain(
      "TODO(gemi-migrate)",
    );
  });

  test("a type declaration is not a call site", async () => {
    // The wrapper interface every app writes around its own pagination
    // arguments. `take?: number` is a shape an object literal cannot even
    // spell.
    write(
      "app/http/PageArgs.ts",
      `export interface PageArgs {
  take?: number;
  skip: number;
}
`,
    );
    await runMigrate({ rootDir: root });

    expect(read("app/http/PageArgs.ts")).not.toContain("TODO(gemi-migrate)");
  });

  test("a `take:` inside a string or comment is not a call site", async () => {
    write(
      "app/http/controllers/DocController.ts",
      `// findMany({ take: limit }) is what this used to do.
export const doc = "take: limit";
`,
    );
    await runMigrate({ rootDir: root });

    expect(read("app/http/controllers/DocController.ts")).not.toContain(
      "TODO(gemi-migrate)",
    );
  });

  test("a second run does not stack a second annotation", async () => {
    write(
      "app/http/controllers/PostController.ts",
      `import { Post } from "@/app/models";
export const list = (perPage) => Post.findMany({ take: perPage });
`,
    );
    await runMigrate({ rootDir: root });
    await runMigrate({ rootDir: root });

    expect(
      read("app/http/controllers/PostController.ts").match(/TODO\(gemi-migrate\)/g),
    ).toHaveLength(1);
  });
});

/**
 * **A file that can hold JSX is reported, never spliced.**
 *
 * A `//` line above a hit is a comment in a `.ts` file and page text in a
 * `.tsx` one — and the `{ code: "P2002" }` inside the P2002 message becomes a
 * JSX expression container, so the splice stopped the file parsing outright.
 * A migration command that leaves the app unable to build is worse than one
 * that says nothing, so these assert the *file* first and the report second.
 *
 * The gate is the extension, which TypeScript makes a guarantee: JSX is legal
 * only in `.tsx` / `.jsx`.
 */
describe("a view file, where a comment is not a comment", () => {
  const VIEW = `import { User } from "@/app/models";

export function SignupForm({ error }: { error?: { code?: string } }) {
  return (
    <div>
      {error?.code === "P2002" ? <p>Email taken</p> : null}
    </div>
  );
}
`;

  test("the P2002 guard is not annotated, and the file still parses", async () => {
    write("app/views/SignupForm.tsx", VIEW);
    await runMigrate({ rootDir: root });

    const after = read("app/views/SignupForm.tsx");
    expect(after).toBe(VIEW);

    // The assertion that matters is not "unchanged" but "still builds" — the
    // first is a proxy and this is the property.
    expect(() =>
      new Bun.Transpiler({ loader: "tsx" }).transformSync(after),
    ).not.toThrow();
  });

  test("it is reported instead, with the line to look at", async () => {
    write("app/views/SignupForm.tsx", VIEW);
    await runMigrate({ rootDir: root });

    const summary = logged.join("\n");
    expect(summary).toContain("app/views/SignupForm.tsx");
    // The splice carried its location by sitting on it; the report has to say
    // it, or the reader is left grepping the file the command just declined to
    // mark.
    expect(summary).toContain("line 6");
    expect(summary).toContain("isUniqueConstraintError");
  });

  test("the take/skip pass holds off there too", async () => {
    // Worse-exposed than the P2002 pass: no import gate, and its message parses
    // in children position rather than failing — so it would have rendered a
    // paragraph of migration advice onto the page instead of erroring.
    const list = `export function List({ limit }: { limit: string }) {
  const rows = usePosts({ take: Number(limit) });
  return <ul>{rows.map((r) => <li key={r.id}>{r.title}</li>)}</ul>;
}
`;
    write("app/views/List.tsx", list);
    await runMigrate({ rootDir: root });

    expect(read("app/views/List.tsx")).toBe(list);
    expect(logged.join("\n")).toContain("app/views/List.tsx");
  });

  test("the same code in a .ts file is still annotated", async () => {
    // The gate is the extension and nothing else, so the pass must not have
    // quietly become conservative everywhere.
    write(
      "app/services/signup.ts",
      `import { User } from "@/app/models";
export const failed = (error: any) => error.code === "P2002";
`,
    );
    await runMigrate({ rootDir: root });

    expect(read("app/services/signup.ts")).toContain("TODO(gemi-migrate)");
  });
});

/**
 * **The ORM passes sweep the files this command itself writes.**
 *
 * Step 4 supersedes a provider by moving its body into `app/config/*.ts`, so
 * the user code inside it lands in a file the earlier `touched` skip excluded
 * from the sweep. On the one run that matters — the first run on an old-layout
 * app — a guard carried over that way was never looked at.
 */
describe("hazards inside the files the migration itself produces", () => {
  const PROVIDER_WITH_HAZARDS = `import { AuthenticationServiceProvider } from "gemi/services";
import { User } from "@/app/models";

export default class AuthServiceProvider extends AuthenticationServiceProvider {
  verifyEmail = false;
  pageSize = { take: Number(process.env.PAGE) };
}
`;

  test("a take carried out of a provider into app/config is annotated", async () => {
    write("app/kernel/providers/AuthServiceProvider.ts", PROVIDER_WITH_HAZARDS);
    write("app/kernel/Kernel.ts", KERNEL_43);

    await runMigrate({ rootDir: root });

    // The provider is gone and its body is here — user code, in a file that
    // did not exist when the tree was walked. Before the sweep moved, this was
    // never looked at on the only run where it could have been.
    const config = read("app/config/auth.ts");
    expect(config).toContain("pageSize: { take: Number(process.env.PAGE) }");
    expect(config).toContain("TODO(gemi-migrate)");
    expect(logged.join("\n")).toContain("app/config/auth.ts");
  });

  test("a second run adds nothing, so the sweep is idempotent across both paths", async () => {
    write("app/kernel/providers/AuthServiceProvider.ts", PROVIDER_WITH_HAZARDS);
    write("app/kernel/Kernel.ts", KERNEL_43);

    await runMigrate({ rootDir: root });
    await runMigrate({ rootDir: root });

    expect(read("app/config/auth.ts").match(/TODO\(gemi-migrate\)/g)).toHaveLength(1);
  });

  /**
   * The P2002 half does **not** reach this file, and the reason is the import
   * gate rather than the sweep: the generated config imports `gemi/services`
   * and not the model surface, because the provider's own model import is not
   * carried across. That is the gate's documented false negative arriving by a
   * new route — asserted rather than left for someone to discover, since the
   * neighbouring `take` hazard in the same file *is* found and the asymmetry
   * would otherwise read as a bug in the sweep.
   *
   * UPGRADE.md carries the plain grep, which is what covers this.
   */
  test("the P2002 gate still asks for a model import, even here", async () => {
    write(
      "app/kernel/providers/AuthServiceProvider.ts",
      PROVIDER_WITH_HAZARDS.replace(
        "  verifyEmail = false;",
        '  verifyEmail = false;\n  onDuplicate = (error: any) => error.code === "P2002";',
      ),
    );
    write("app/kernel/Kernel.ts", KERNEL_43);

    await runMigrate({ rootDir: root });

    const config = read("app/config/auth.ts");
    expect(config).toContain('error.code === "P2002"');
    expect(config).not.toContain("isUniqueConstraintError");
  });
});
