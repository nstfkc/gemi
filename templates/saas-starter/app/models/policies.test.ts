import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  PolicyDeniedError,
  RecordNotFoundError,
  clearPlanCache,
  planCacheStats,
  softDelete,
  softDeleteMany,
  register,
  softDeletes,
  UnregisteredPolicyClassError,
  type ModelPolicy,
} from "gemi/orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL, applyMigrations } from "./differential";
import { AccountModel, OrganizationModel, UserModel } from "./generated";

/**
 * Policies are declared on **registered subclasses**, exactly as an application
 * declares them — not by assigning `$policy` onto the generated base.
 *
 * That distinction is load-bearing, and getting it wrong is how a cross-tenant
 * leak passed review here: `generated/index.ts` registers the generated base, a
 * nested relation read resolves through the registry, and a policy sitting on a
 * subclass is therefore invisible to every `include`. Attaching `$policy` to
 * `AccountModel` made the headline test green while the documented pattern
 * leaked. These subclasses are registered in `beforeEach`, so the tests exercise
 * the same wiring an application does.
 */
class ScopedUser extends UserModel {}
class ScopedAccount extends AccountModel {}

/**
 * Policies, against a real database.
 *
 * `policy.test.ts` in `packages/gemi` covers dispatch and rewriting as pure
 * functions. What needs a database is the pair of properties that cannot be
 * checked any other way:
 *
 * 1. **A scope applies to nested relation reads.** This is the headline, and
 *    the thing Prisma's query extensions get wrong: a scope written for
 *    `Account` is bypassed by `User.findMany({ include: { accounts: true } })`
 *    there. It works here because a relation read *is* `$exec` on the related
 *    model's own class — so the test is proving invariant 1 held, as much as it
 *    is proving the policy fired.
 *
 * 2. **Policies run before the plan key is computed.** Get that ordering wrong
 *    and two differently-scoped users share one plan, which is a cross-tenant
 *    data leak wearing a caching bug's clothes. It does not fail loudly; it
 *    returns the wrong rows.
 *
 * Both dialects, because a leak that only reproduces on one is still a leak.
 */

/**
 * The two actors, filled in by the seed rather than hard-coded.
 *
 * Not fussiness: SQLite's AUTOINCREMENT high-water mark survives a `DELETE`, so
 * after the first `beforeEach` the seeded rows do not have ids 1 and 2 any more.
 * Hard-coding them made the headline test pass in isolation and return zero
 * accounts in a full run — the accounts pointed at a `userId` no longer present
 * — and it would have passed on Postgres either way, where the harness's
 * `TRUNCATE ... RESTART IDENTITY` resets the sequence. A test that depends on
 * which run it is in is worse than no test.
 */
let ALICE: { id: number; organizationId: number };
let BOB: { id: number; organizationId: number };

/** Scopes every read and every affected row to the caller's organisation. */
const tenantScoped: ModelPolicy = {
  scope: (context) => ({
    organizationId: (context.user as { organizationId: number }).organizationId,
  }),
  onCreate: (context, data) => ({
    ...data,
    organizationId: (context.user as { organizationId: number }).organizationId,
  }),
};

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    const TABLES = [
      "SocialAccount",
      "Session",
      "PasswordResetToken",
      "MagicLinkToken",
      "Account",
      "User",
      "OrganizationInvitation",
      "Organization",
    ];

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-policy-"));
        const path = join(workspace, "policy.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      // The registry decides which class every nested read runs on, so the
      // subclasses under test have to own their names for the duration.
      register("User", ScopedUser);
      register("Account", ScopedAccount);

      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((table) => `"${table}"`).join(", ")} ` +
            `RESTART IDENTITY CASCADE`,
        );
      } else {
        for (const table of TABLES) await raw.unsafe(`DELETE FROM "${table}"`);
      }

      // Two organisations, a user in each, and an account in each. Seeded
      // through `asSystem` because the models under test are policied — which
      // is itself the deny-by-default rule doing its job on the seed path.
      await Model.asSystem(async () => {
        const one: any = await OrganizationModel.create({
          data: { name: "Org One" },
        });
        const two: any = await OrganizationModel.create({
          data: { name: "Org Two" },
        });

        const alice: any = await UserModel.create({
          data: { email: "alice@x.test", organizationId: one.id },
        });
        const bob: any = await UserModel.create({
          data: { email: "bob@x.test", organizationId: two.id },
        });

        await AccountModel.create({
          data: { userId: alice.id, organizationId: one.id },
        });
        await AccountModel.create({
          data: { userId: bob.id, organizationId: two.id },
        });

        ALICE = { id: alice.id, organizationId: one.id };
        BOB = { id: bob.id, organizationId: two.id };
      });
    });

    afterEach(() => {
      // A static on a class shared across the file, so it outlives the test.
      delete (ScopedUser as any).$policy;
      delete (ScopedAccount as any).$policy;
      register("User", UserModel);
      register("Account", AccountModel);
    });

    // --- criterion 1: deny, scope, redact on a root query -----------------

    test("before denies", async () => {
      (ScopedUser as any).$policy = { before: () => false } satisfies ModelPolicy;

      await expect(
        Model.asUser(ALICE, () => ScopedUser.findMany({})),
      ).rejects.toThrow(PolicyDeniedError);
    });

    test("scope narrows a root read", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const rows = await Model.asUser(ALICE, () => ScopedUser.findMany({}));
      expect(rows.map((row: any) => row.email)).toEqual(["alice@x.test"]);

      const others = await Model.asUser(BOB, () => ScopedUser.findMany({}));
      expect(others.map((row: any) => row.email)).toEqual(["bob@x.test"]);
    });

    test("a caller's own where still applies alongside the scope", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      // Bob's row, asked for by Alice — the scope must win.
      const rows = await Model.asUser(ALICE, () =>
        ScopedUser.findMany({ where: { email: "bob@x.test" } }),
      );
      expect(rows).toEqual([]);
    });

    test("redact removes a field from the result", async () => {
      (ScopedUser as any).$policy = {
        redact: (_context, row) => {
          if ("email" in row) row.email = null;
        },
      } satisfies ModelPolicy;

      const rows = await Model.asUser(ALICE, () => ScopedUser.findMany({}));
      expect(rows).toHaveLength(2);
      expect(rows.every((row: any) => row.email === null)).toBe(true);

      // The column is still selected and still read — redaction is about the
      // result, not the SQL, which is what keeps the plan key user-independent.
      const stored: any = await raw.unsafe(`SELECT "email" FROM "User"`);
      expect([...stored].every((row: any) => row.email !== null)).toBe(true);
    });

    // --- criterion 2: THE HEADLINE ----------------------------------------

    /**
     * The single most important test in this iteration.
     *
     * `Account` is scoped to the caller's organisation. Reading users with
     * `include: { accounts: true }` must not return accounts from another one.
     * Prisma's extensions do not fire on that nested read at all; ours does,
     * because the nested read is `$exec` on `AccountModel` and therefore goes
     * through the same hook as a root query.
     *
     * Note `User` is deliberately *unpolicied* here, so the only thing that can
     * scope the accounts is `Account`'s own policy firing on a nested read.
     */
    test("a scope on the related model applies to a nested include", async () => {
      (ScopedAccount as any).$policy = tenantScoped;

      const rows = await Model.asUser(ALICE, () =>
        ScopedUser.findMany({ include: { accounts: true } }),
      );

      // Both users come back — User has no policy.
      expect(rows).toHaveLength(2);

      // ...but only organisation 1's account is attached anywhere.
      const accounts = rows.flatMap((row: any) => row.accounts);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].organizationId).toBe(ALICE.organizationId);

      // Bob's row is present and his account is *not*, which is the exact
      // cross-tenant read Prisma would have returned.
      const bob = rows.find((row: any) => row.email === "bob@x.test");
      expect(bob.accounts).toEqual([]);
    });

    /**
     * The regression guard for the wiring itself, not for the mechanism.
     *
     * The headline test above was green while the *documented* pattern leaked:
     * it attached `$policy` to the generated base, which is what
     * `generated/index.ts` registers, so the nested read found it. An
     * application declares its policy on a subclass — and if that subclass does
     * not own the model's name, the nested read resolves to the generated base
     * and skips the policy entirely. Root queries scoped, includes unscoped.
     *
     * This asserts the failure is now loud. Leaving the generated base
     * registered while the policy sits on a subclass raises rather than reading
     * across tenants, which is the only acceptable behaviour for a
     * misconfiguration with this consequence.
     */
    test("a policy on an unregistered subclass raises instead of leaking", async () => {
      class Unregistered extends AccountModel {
        static $policy = tenantScoped;
      }
      // Deliberately *not* registered: "Account" still resolves to the
      // generated base, exactly as it would in an application that declared a
      // policy and forgot the registration.
      register("Account", AccountModel);

      await expect(
        Model.asUser(ALICE, () => (Unregistered as any).findMany({})),
      ).rejects.toThrow(UnregisteredPolicyClassError);

      // ...and the message names the fix rather than describing the symptom.
      await expect(
        Model.asUser(ALICE, () => (Unregistered as any).findMany({})),
      ).rejects.toThrow(/register\("Account", Unregistered\)/);
    });

    /**
     * The guard fires on a divergence in the *policy chain*, not on the two
     * classes merely differing.
     *
     * A plain subclass of a registered, policied class inherits the same policy
     * objects in the same order, so a nested read resolving to the parent
     * applies exactly what a root query through the child applied. There is no
     * leak, and an identity check refused it — `class AdminUser extends User {}`
     * as a typed view is a natural thing to write, and it failed with an error
     * about policies it had not written.
     */
    test("a subclass adding no policy of its own is allowed", async () => {
      (ScopedAccount as any).$policy = tenantScoped;

      // A typed view over the registered, policied class.
      class AdminAccount extends ScopedAccount {}

      const rows = await Model.asUser(ALICE, () =>
        (AdminAccount as any).findMany({}),
      );

      // Allowed, and still scoped — the inherited policy is the same object.
      expect(rows).toHaveLength(1);
      expect(rows[0].organizationId).toBe(ALICE.organizationId);
    });

    // ...and the divergent case is still refused, which is the half that
    // distinguishes "stricter than the risk" from "matching the risk".
    test("a subclass adding its own policy must own the name", async () => {
      (ScopedAccount as any).$policy = tenantScoped;

      class Narrower extends ScopedAccount {
        static $policy: ModelPolicy = {
          scope: () => ({ deletedAt: null }),
          onCreate: (_c, data) => data,
        };
      }

      await expect(
        Model.asUser(ALICE, () => (Narrower as any).findMany({})),
      ).rejects.toThrow(UnregisteredPolicyClassError);
    });

    /**
     * The mirror image of the original bug, and the one the guard's first
     * placement missed.
     *
     * There, the policied class was unregistered and *nested* reads were
     * unscoped. Here the policied class **is** registered — so nested reads are
     * correctly scoped — and a *direct* query through the generated base skips
     * the policy instead. Both are "the scope silently does not apply", and this
     * one needs no include to reach.
     *
     * It is not exotic: `AccountModel` and `Account` come out of the same barrel
     * with near-identical names, and querying the generated base is what every
     * test in this file used to do.
     */
    test("querying the generated base when a policied class owns the name raises", async () => {
      (ScopedAccount as any).$policy = tenantScoped;

      await expect(
        Model.asUser(ALICE, () => AccountModel.findMany({})),
      ).rejects.toThrow(UnregisteredPolicyClassError);

      // The message has to speak to *this* direction — the caller is skipping
      // policies rather than failing to register any.
      await expect(
        Model.asUser(ALICE, () => AccountModel.findMany({})),
      ).rejects.toThrow(/carries policies AccountModel does not/);
    });

    // ...and the exemption that keeps it usable: under `asSystem` policies are
    // suspended by design, so a seed or a script querying the base directly is
    // correct and must not raise. Without this the guard would break every
    // seeded fixture in the repo.
    test("asSystem may query the generated base without raising", async () => {
      (ScopedAccount as any).$policy = tenantScoped;

      const rows = await Model.asSystem(() => AccountModel.findMany({}));
      expect(rows).toHaveLength(2);
    });

    test("the same include for the other tenant sees only theirs", async () => {
      (ScopedAccount as any).$policy = tenantScoped;

      const rows = await Model.asUser(BOB, () =>
        ScopedUser.findMany({ include: { accounts: true } }),
      );

      const accounts = rows.flatMap((row: any) => row.accounts);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].organizationId).toBe(BOB.organizationId);
    });

    test("a deny on the related model denies the whole include", async () => {
      (ScopedAccount as any).$policy = { before: () => false } satisfies ModelPolicy;

      await expect(
        Model.asUser(ALICE, () =>
          ScopedUser.findMany({ include: { accounts: true } }),
        ),
      ).rejects.toThrow(PolicyDeniedError);
    });

    /**
     * Iteration 9's deliverable 1c, end to end: a nested model's policies are
     * applied to the *argument tree* in `$exec`, not only by the recursion the
     * batched strategy happens to do.
     *
     * The observable consequence under batching is that the scope must apply
     * exactly **once** — the parent's walk scopes the child's node, and the
     * child's own `$exec` must then not scope it again. Twice would give the same
     * rows through different SQL and a different plan key.
     */
    test("a nested scope applies exactly once, not twice", async () => {
      let scopeCalls = 0;
      (ScopedAccount as any).$policy = {
        scope: (context: any) => {
          scopeCalls++;
          return { organizationId: context.user.organizationId };
        },
        onCreate: (_c: any, data: any) => data,
      } satisfies ModelPolicy;

      const rows = await Model.asUser(ALICE, () =>
        ScopedUser.findMany({ include: { accounts: true } }),
      );

      // Still correctly scoped...
      const accounts = rows.flatMap((row: any) => row.accounts);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].organizationId).toBe(ALICE.organizationId);

      // ...and the policy ran once, so the nested `where` carries one predicate
      // rather than the same one twice.
      expect(scopeCalls).toBe(1);
    });

    // The other half: with nothing to apply, the argument tree is untouched, so an
    // unpolicied include mints no new plan and invalidates no cached one.
    test("an unpolicied nested model leaves the plan key alone", async () => {
      clearPlanCache();

      await Model.asSystem(() =>
        ScopedUser.findMany({ include: { accounts: true } }),
      );
      const first = planCacheStats();

      await Model.asSystem(() =>
        ScopedUser.findMany({ include: { accounts: true } }),
      );
      const second = planCacheStats();

      expect(second.size).toBe(first.size);
      expect(second.compiles).toBe(first.compiles);
    });

    // --- criterion 3: base-class policies ---------------------------------

    test("a base class policy applies to a subclass, and narrows further", async () => {
      class Tenanted extends ScopedUser {
        static $policy = tenantScoped;
      }
      class Named extends Tenanted {
        static $policy: ModelPolicy = { scope: () => ({ email: "alice@x.test" }) };
      }

      // The leaf carries a policy, so the leaf owns the name — the same rule
      // the suite's own subjects follow, and the guard enforces it.
      register("User", Named);

      // Base scope (org 1) AND derived scope (that email) — Alice matches both.
      const mine = await Model.asUser(ALICE, () => (Named as any).findMany({}));
      expect(mine.map((row: any) => row.email)).toEqual(["alice@x.test"]);

      // Bob matches the base scope but not the derived one, and cannot escape
      // the base by matching only the derived: nothing comes back.
      const theirs = await Model.asUser(BOB, () => (Named as any).findMany({}));
      expect(theirs).toEqual([]);
    });

    // --- criterion 4: THE PLAN CACHE, where a bug is a data leak ----------

    /**
     * A scope that injects a *value* keeps the same argument shape for every
     * user, so the plan is shared and only the bound value differs. That is the
     * desired outcome — but it is only safe because policies run *before* the
     * plan key is computed. Reversed, the two users would share a plan compiled
     * from the pre-policy args and neither would be scoped at all.
     *
     * Asserted through the results rather than through the cache alone: one
     * plan, and each user still gets only their own rows.
     */
    test("same shape, different users: one plan, no leak", async () => {
      (ScopedUser as any).$policy = tenantScoped;
      clearPlanCache();

      const alice = await Model.asUser(ALICE, () => ScopedUser.findMany({}));
      const afterFirst = planCacheStats();

      const bob = await Model.asUser(BOB, () => ScopedUser.findMany({}));
      const afterSecond = planCacheStats();

      // One plan, reused.
      expect(afterSecond.size).toBe(afterFirst.size);
      expect(afterSecond.hits).toBe(afterFirst.hits + 1);

      // And the shared plan did not leak either user's rows to the other.
      expect(alice.map((row: any) => row.email)).toEqual(["alice@x.test"]);
      expect(bob.map((row: any) => row.email)).toEqual(["bob@x.test"]);
    });

    /**
     * The other half: a scope whose *shape* varies by user — an admin getting
     * none at all — must produce a different plan key, or the admin runs the
     * scoped SQL or vice versa.
     */
    test("differently-shaped scopes get different plans", async () => {
      const ADMIN = { ...ALICE, admin: true };

      (ScopedUser as any).$policy = {
        scope: (context) => {
          const user = context.user as any;
          return user.admin ? undefined : { organizationId: user.organizationId };
        },
      } satisfies ModelPolicy;

      clearPlanCache();

      await Model.asUser(ALICE, () => ScopedUser.findMany({}));
      const afterScoped = planCacheStats();

      const admin = await Model.asUser(ADMIN, () => ScopedUser.findMany({}));
      const afterAdmin = planCacheStats();

      // A second, distinct plan rather than a hit on the scoped one.
      expect(afterAdmin.size).toBe(afterScoped.size + 1);
      expect(afterAdmin.compiles).toBe(afterScoped.compiles + 1);

      // The admin genuinely sees everyone.
      expect(admin).toHaveLength(2);
    });

    // --- criterion 5: writes ----------------------------------------------

    test("onCreate defaults the tenant column", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const created: any = await Model.asUser(BOB, () =>
        ScopedUser.create({ data: { email: "new@x.test" } }),
      );
      expect(created.organizationId).toBe(BOB.organizationId);
    });

    test("scope restricts which rows an updateMany affects", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const result: any = await Model.asUser(ALICE, () =>
        ScopedUser.updateMany({ data: { name: "renamed" } }),
      );
      expect(result.count).toBe(1);

      const rows: any = await raw.unsafe(
        `SELECT "email", "name" FROM "User" ORDER BY "id"`,
      );
      const named = [...rows].map((row: any) => [row.email, row.name]);
      expect(named).toEqual([
        ["alice@x.test", "renamed"],
        ["bob@x.test", null],
      ]);
    });

    test("scope restricts which rows a deleteMany affects", async () => {
      // Accounts reference users, so clear the children first.
      await Model.asSystem(() => ScopedAccount.deleteMany({}));
      (ScopedUser as any).$policy = tenantScoped;

      const result: any = await Model.asUser(ALICE, () =>
        ScopedUser.deleteMany({}),
      );
      expect(result.count).toBe(1);

      const rows: any = await raw.unsafe(`SELECT "email" FROM "User"`);
      expect([...rows].map((row: any) => row.email)).toEqual(["bob@x.test"]);
    });

    /**
     * The error type is asserted, not just the fact of throwing.
     *
     * This test used to say `rejects.toThrow()` and passed for the wrong
     * reason: the scope was wrapping the caller's `{ id }` inside an `AND`, so
     * `matchUniqueKey` could not see it and every scoped `delete` failed with
     * "needs a unique field" rather than finding no row. A bare `toThrow()`
     * cannot tell those apart, which is exactly how the bug survived.
     */
    test("a scoped delete of another tenant's row finds nothing", async () => {
      await Model.asSystem(() => ScopedAccount.deleteMany({}));
      (ScopedUser as any).$policy = tenantScoped;

      await expect(
        Model.asUser(ALICE, () => ScopedUser.delete({ where: { id: BOB.id } })),
      ).rejects.toThrow(RecordNotFoundError);

      const rows: any = await raw.unsafe(`SELECT "email" FROM "User"`);
      expect([...rows]).toHaveLength(2);
    });

    // ...and the same delete of the caller's *own* row succeeds, which is the
    // half that proves the refusal above was about the scope and not about the
    // unique key being unreachable.
    test("a scoped delete of the caller's own row succeeds", async () => {
      await Model.asSystem(() => ScopedAccount.deleteMany({}));
      (ScopedUser as any).$policy = tenantScoped;

      const deleted: any = await Model.asUser(ALICE, () =>
        ScopedUser.delete({ where: { id: ALICE.id } }),
      );
      expect(deleted.email).toBe("alice@x.test");

      const rows: any = await raw.unsafe(`SELECT "email" FROM "User"`);
      expect([...rows].map((row: any) => row.email)).toEqual(["bob@x.test"]);
    });

    test("a scoped update of the caller's own row succeeds", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const updated: any = await Model.asUser(ALICE, () =>
        ScopedUser.update({ where: { id: ALICE.id }, data: { name: "renamed" } }),
      );
      expect(updated.name).toBe("renamed");
    });

    // --- criteria 6 and 7: no user, and system access ---------------------

    test("a policied model with no user is denied, not left unscoped", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      await expect(ScopedUser.findMany({})).rejects.toThrow(PolicyDeniedError);
      await expect(ScopedUser.findMany({})).rejects.toThrow(/no user in scope/);
    });

    test("asSystem is the explicit opt-out, and returns everything", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const rows = await Model.asSystem(() => ScopedUser.findMany({}));
      expect(rows).toHaveLength(2);
    });

    test("asSystem suspends policies rather than widening the user's scope", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      // Even with a user in scope, asSystem is unscoped — a script that has
      // said it is a script is not then re-scoped to whoever is around.
      const rows = await Model.asUser(ALICE, () =>
        Model.asSystem(() => ScopedUser.findMany({})),
      );
      expect(rows).toHaveLength(2);
    });

    /**
     * `asUser` inside `asSystem` must narrow back.
     *
     * Acting as a user is strictly narrower than acting as the system, and the
     * realistic shape is a worker that enters `asSystem` to read its job queue
     * and then narrows to the job's owner for the work. Before the fix
     * `runAsUser` spread `system: true` forward, so `$exec` short-circuited to
     * no policies at all while `currentUser()` returned the actor — the actor
     * was set and nothing scoped on it. Silently unscoped, which is the failure
     * this whole iteration is arranged against.
     */
    test("asUser inside asSystem narrows back to the user", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const rows = await Model.asSystem(() =>
        Model.asUser(ALICE, () => ScopedUser.findMany({})),
      );

      expect(rows.map((row: any) => row.email)).toEqual(["alice@x.test"]);
    });

    // The reverse nesting is unchanged and correct: naming the system inside a
    // user scope suspends policies, because that is what asSystem means.
    test("asSystem inside asUser still suspends", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const rows = await Model.asUser(ALICE, () =>
        Model.asSystem(() => ScopedUser.findMany({})),
      );

      expect(rows).toHaveLength(2);
    });

    // `asUser` with nothing to act as is the "user failed to turn up" case, and
    // it must deny rather than read unscoped — `asUser(byId.get(id))` on a miss.
    test.each([
      ["undefined", undefined],
      ["null", null],
    ])("asUser(%s) is denied, not unscoped", async (_label, absent) => {
      (ScopedUser as any).$policy = tenantScoped;

      await expect(
        Model.asUser(absent, () => ScopedUser.findMany({})),
      ).rejects.toThrow(PolicyDeniedError);
    });

    test("an unpolicied model is untouched by any of this", async () => {
      const rows = await OrganizationModel.findMany({});
      expect(rows).toHaveLength(2);
    });

    // --- interaction with iteration 5 -------------------------------------

    test("a scope survives inside a transaction", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const rows = await Model.asUser(ALICE, () =>
        Model.transaction(() => ScopedUser.findMany({})),
      );
      expect(rows.map((row: any) => row.email)).toEqual(["alice@x.test"]);
    });

    // The scope object is merged rather than replaced on the way in, so opening
    // a transaction inside `asSystem` must not silently re-enable policies for
    // its whole subtree.
    test("a transaction inside asSystem stays system", async () => {
      (ScopedUser as any).$policy = tenantScoped;

      const rows = await Model.asSystem(() =>
        Model.transaction(() => ScopedUser.findMany({})),
      );
      expect(rows).toHaveLength(2);
    });
  });
}

/**
 * Soft deletes, the proof case for the hook being expressive enough.
 *
 * `User` and `Account` both carry a nullable `deletedAt`, so the recipe is
 * exercised against the template's real schema rather than a fixture. The part
 * that matters is the same part as the headline test: a soft-deleted row
 * disappears from *nested* reads too, which is what ORM-level soft deletes
 * usually get wrong.
 */
/**
 * Soft-delete subjects, registered like the policy suite's — the recipe is a
 * policy, so it is subject to the same registry wiring.
 */
class SoftUser extends UserModel {}
class SoftAccount extends AccountModel {}

function softDeleteSuite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let aliceId: number;
    let bobId: number;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-soft-"));
        const path = join(workspace, "soft.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      register("User", SoftUser);
      register("Account", SoftAccount);
      if (url) {
        await raw.unsafe(
          `TRUNCATE "Account", "User" RESTART IDENTITY CASCADE`,
        );
      } else {
        await raw.unsafe(`DELETE FROM "Account"`);
        await raw.unsafe(`DELETE FROM "User"`);
      }

      const alice: any = await SoftUser.create({
        data: { email: "alice@x.test" },
      });
      const bob: any = await SoftUser.create({ data: { email: "bob@x.test" } });
      aliceId = alice.id;
      bobId = bob.id;
      await SoftAccount.create({ data: { userId: alice.id } });
    });

    afterEach(() => {
      delete (SoftUser as any).$policy;
      delete (SoftAccount as any).$policy;
    });

    // No user is needed: the soft-delete scope does not read one, so
    // deny-by-default has nothing to deny. Worth asserting, because a policy
    // that forced every query in the application through `asUser` would make
    // the recipe unusable for anything but request-scoped code.
    test("the scope works with no user in scope", async () => {
      (SoftUser as any).$policy = softDeletes();
      const rows = await SoftUser.findMany({});
      expect(rows).toHaveLength(2);
    });

    test("a soft-deleted row disappears from reads", async () => {
      (SoftUser as any).$policy = softDeletes();
      const remove = softDelete(SoftUser);

      await remove({ where: { id: bobId } });

      const rows = await SoftUser.findMany({});
      expect(rows.map((row: any) => row.email)).toEqual(["alice@x.test"]);

      // Still in the table — that is the whole point.
      const stored: any = await raw.unsafe(`SELECT "email" FROM "User"`);
      expect([...stored]).toHaveLength(2);
    });

    test("the timestamp is set, not the row removed", async () => {
      (SoftUser as any).$policy = softDeletes();
      await softDelete(SoftUser)({ where: { id: bobId } });

      const stored: any = await raw.unsafe(
        `SELECT "email", "deletedAt" FROM "User" ORDER BY "id"`,
      );
      const rows = [...stored];
      expect(rows.find((row: any) => row.email === "alice@x.test").deletedAt).toBeNull();
      expect(rows.find((row: any) => row.email === "bob@x.test").deletedAt).not.toBeNull();
    });

    /**
     * The half ORM-level soft deletes usually miss. `Account` is soft-deleted;
     * a deleted account must not appear under an `include` on `User` — and
     * nothing is written at the include site to make that true.
     */
    test("a soft-deleted row disappears from a nested include too", async () => {
      (SoftAccount as any).$policy = softDeletes();

      const before = await SoftUser.findMany({ include: { accounts: true } });
      expect(before.flatMap((row: any) => row.accounts)).toHaveLength(1);

      await softDeleteMany(SoftAccount)({});

      const after = await SoftUser.findMany({ include: { accounts: true } });
      expect(after.flatMap((row: any) => row.accounts)).toHaveLength(0);

      // ...and the account row is still there.
      const stored: any = await raw.unsafe(`SELECT "id" FROM "Account"`);
      expect([...stored]).toHaveLength(1);
    });

    // The rewrite goes through `update`, so the model's own scope applies to it:
    // deleting an already-deleted row matches nothing, exactly as a hard delete
    // of a missing row would.
    test("soft-deleting an already-deleted row finds nothing", async () => {
      (SoftUser as any).$policy = softDeletes();
      const remove = softDelete(SoftUser);

      await remove({ where: { id: bobId } });
      await expect(remove({ where: { id: bobId } })).rejects.toThrow();
    });

    test("softDeleteMany reports a count and respects a where", async () => {
      (SoftUser as any).$policy = softDeletes();

      const result: any = await softDeleteMany(SoftUser)({
        where: { email: "bob@x.test" },
      });
      expect(result.count).toBe(1);
      expect(await SoftUser.findMany({})).toHaveLength(1);
    });

    // Synchronously, before any query is built — the rewrite validates its own
    // arguments rather than handing a contradictory pair to `update`.
    test("a data argument is refused rather than overwritten", () => {
      (SoftUser as any).$policy = softDeletes();
      expect(() =>
        softDelete(SoftUser)({ where: { id: aliceId }, data: { name: "x" } }),
      ).toThrow(/takes no 'data'/);
    });

    test("a custom field name is honoured", async () => {
      (SoftUser as any).$policy = softDeletes({ field: "deletedAt" });
      await softDelete(SoftUser, { field: "deletedAt" })({
        where: { id: bobId },
      });
      expect(await SoftUser.findMany({})).toHaveLength(1);
    });

    // Composed through the prototype chain, which is the documented route and
    // gets the ordering right for free: the soft-delete scope is applied first
    // and the subclass's narrows further.
    test("composes with another policy via a base class", async () => {
      class SoftDeleted extends SoftUser {
        static $policy = softDeletes();
      }
      class Restricted extends SoftDeleted {
        static $policy: ModelPolicy = {
          scope: () => ({ email: { contains: "alice" } }),
          onCreate: (_c, data) => data,
        };
      }

      // One class owns the name — the leaf, which is the one carrying a policy
      // an application would query through. `Restricted` inherits the base's
      // soft-delete scope through the prototype chain, so both apply to it, and
      // that is the composition under test. Registering `SoftDeleted` as well
      // would be two policy-carrying classes for one model, which the guard
      // refuses precisely because nested reads can only resolve to one.
      register("User", Restricted);

      await softDelete(Restricted as any)({ where: { id: aliceId } });

      // Alice matches the derived scope but is now soft-deleted, so the base's
      // scope excludes her; Bob matches the base but not the derived. Nothing
      // satisfies both, which is what "narrowing only" means.
      expect(await (Restricted as any).findMany({})).toEqual([]);
    });
  });
}

suite("policies (sqlite)", undefined);
softDeleteSuite("soft deletes (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("policies (postgres)", POSTGRES_URL);
  softDeleteSuite("soft deletes (postgres)", POSTGRES_URL);
} else {
  describe("policies (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
