import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UserProvider } from "gemi/kernel";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, register } from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { applyMigrations } from "./scratch";
import {
  AccountModel,
  MagicLinkTokenModel,
  OrganizationInvitationModel,
  OrganizationModel,
  PasswordResetTokenModel,
  SessionModel,
  SocialAccountModel,
  UserModel,
} from "./generated";

/**
 * What `config.onUserCreated` may and may not do to a **policied** model.
 *
 * `UserProvider.transaction` deliberately does not wrap the hook in `asSystem`
 * — the provider applies it per query, to its own reads and writes, and
 * hoisting it would leave an application's provisioning writes unpoliced with
 * nothing at the call site saying so.
 *
 * The consequence is the thing worth pinning, because it is a 500 on the very
 * first sign-up rather than a subtle wrong answer: the hook runs with **no user
 * in scope**, so a tenant scope reading `ctx.user` denies under
 * deny-by-default. `docs/authentication.md` now documents `Model.asSystem` in
 * the provisioning example for exactly this reason, and these two tests are
 * what keep that documentation honest — the first version of it did not have
 * the wrapper and would have 500'd for anyone who followed it.
 *
 * In its own file because `register` is global: pointing the name
 * `Organization` at a policied subclass would otherwise change what every other
 * test in a shared file queries.
 */
class PoliciedOrganization extends OrganizationModel {
  // The ordinary shape of a tenant policy. Both members read `ctx.user`, which
  // is what raises rather than silently returning or writing everything when
  // nobody is in scope.
  //
  // `onCreate` is not optional decoration here: the ORM refuses a `create` on a
  // model whose policy scopes reads and says nothing about inserts, because
  // that combination reads as "confine reads to the caller, let an insert name
  // any value it likes". So a scope-only policy could not reach the denial this
  // file is about.
  static $policies = [
    {
      scope: (ctx: any) => ({ id: ctx.user?.organizationId }),
      onCreate: (ctx: any, data: any) => {
        const owner = ctx.user;
        return { ...data, description: `created by ${owner.name}` };
      },
    },
  ];
}

register("Organization", PoliciedOrganization);

describe("onUserCreated's scope, against a policied model", () => {
  let workspace: string;
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;
  let auth: UserProvider;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "gemi-auth-policy-"));
    const path = join(workspace, "policy.db");
    await applyMigrations(path);
    const target = `sqlite://${path}`;

    database = new DatabaseManager({ url: target });
    raw = new SQL(target);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);

    auth = new UserProvider({
      User: UserModel,
      Session: SessionModel,
      Account: AccountModel,
      PasswordResetToken: PasswordResetTokenModel,
      MagicLinkToken: MagicLinkTokenModel,
      OrganizationInvitation: OrganizationInvitationModel,
      SocialAccount: SocialAccountModel,
    });
  }, 120_000);

  afterAll(async () => {
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearPlanCache();
    for (const table of ["Account", "User", "Organization"]) {
      await raw.unsafe(`DELETE FROM "${table}"`);
    }
  });

  test("an unwrapped write to a policied model is denied, and rolls the user back", async () => {
    await expect(
      auth.transaction(async () => {
        const user: any = await auth.createUser({
          name: "A",
          email: "a@x.test",
        });
        await PoliciedOrganization.create({
          data: { name: `${user.name}'s org` },
        });
      }),
    ).rejects.toThrow(/there is no user in scope/);

    // The denial is the documented failure, and the rollback is what makes it
    // survivable: no half-provisioned user is left behind to collide with a
    // retry of the same address.
    const users: any = await raw.unsafe(`SELECT "id" FROM "User"`);
    expect([...users]).toHaveLength(0);
  });

  test("`Model.asSystem` inside the hook is the documented fix, and still joins the transaction", async () => {
    const user: any = await auth.transaction(async () => {
      const created: any = await auth.createUser({
        name: "A",
        email: "a@x.test",
      });
      await Model.asSystem(() =>
        PoliciedOrganization.create({ data: { name: `${created.name}'s org` } }),
      );
      return created;
    });

    expect(user.email).toBe("a@x.test");
    const orgs: any = await raw.unsafe(`SELECT "name" FROM "Organization"`);
    expect([...orgs]).toHaveLength(1);
  });

  /**
   * `asSystem` merges into the current scope rather than replacing it
   * (`orm/context.ts`), so it does not drop the open transaction handle. Worth
   * a test rather than a comment: the docs tell applications to wrap their
   * provisioning in it, and if that silently escaped the transaction, the whole
   * hook would be pointless — the rows it wrote would survive the rollback.
   */
  test("a rollback still reaches writes made inside `asSystem`", async () => {
    await expect(
      auth.transaction(async () => {
        await auth.createUser({ name: "A", email: "a@x.test" });
        await Model.asSystem(() =>
          PoliciedOrganization.create({ data: { name: "orphan" } }),
        );
        throw new Error("provisioning failed");
      }),
    ).rejects.toThrow("provisioning failed");

    const users: any = await raw.unsafe(`SELECT "id" FROM "User"`);
    const orgs: any = await raw.unsafe(`SELECT "id" FROM "Organization"`);
    expect([...users]).toHaveLength(0);
    expect([...orgs]).toHaveLength(0);
  });
});
