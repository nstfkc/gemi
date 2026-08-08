import { Prisma as PrismaNamespace, type PrismaClient } from "./prisma-client";
import { UniqueConstraintError } from "gemi/orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDifferential,
  stabilizeRelations,
  type Differential,
} from "./differential";
import {
  AccountModel,
  MembershipModel,
  OrganizationModel,
  PasswordResetTokenModel,
  PostModel,
  ProfileModel,
  TagModel,
  SocialAccountModel,
  UserModel,
} from "./generated";
import { POSTGRES_URL } from "./scratch";

/**
 * The write surface, run through Prisma and through gemi against the same
 * schema, and compared on both what it returned *and* what it left in the
 * table.
 *
 * The second half is the one that earns its keep: `updateMany` returns nothing
 * but a count, and a `create` that binds the right values into the wrong
 * columns returns a payload that looks entirely correct. Only reading the rows
 * back catches either.
 */

const EPOCH = 1600000000000;

async function seed(prisma: PrismaClient) {
  await prisma.organization.createMany({
    data: [
      { publicId: "o1", name: "Acme" },
      { publicId: "o2", name: "Globex" },
    ],
  });
  const [acme] = await prisma.organization.findMany({ orderBy: { id: "asc" } });

  await prisma.user.createMany({
    data: [
      {
        publicId: "p1",
        name: "Ada",
        email: "ada@example.dev",
        globalRole: 0,
        organizationId: acme.id,
        createdAt: new Date(EPOCH),
        updatedAt: new Date(EPOCH),
      },
      {
        publicId: "p2",
        name: "Grace",
        email: "grace@example.dev",
        globalRole: 1,
        createdAt: new Date(EPOCH + 1000),
        updatedAt: new Date(EPOCH + 1000),
      },
      {
        publicId: "p3",
        name: null,
        email: null,
        globalRole: 2,
        createdAt: new Date(EPOCH + 2000),
        updatedAt: new Date(EPOCH + 2000),
      },
    ],
  });

  // One seed, two purposes, and both halves are load-bearing.
  //
  // **The rows are here rather than in each test.** `expectSameWrite` resets to
  // the seeded state before each client runs — that is the whole point of it —
  // so rows written in a test body are gone by the time the comparison happens,
  // and a case that depended on them would compare two runs against an empty
  // table and pass whatever the code did.
  //
  // `acc-theirs` belongs to the **second** user, which is what makes "not
  // linked" mean something for `delete`, `update` and the parent-key filter on
  // `updateMany` / `deleteMany`.
  //
  // `a1` / `a2` carry an `organizationId` so a `_count` has a number to be
  // wrong about (#87): without children every count is 0 and a dropped one is
  // indistinguishable from a correct one.
  //
  // Safe for the delete cases either way: `Account_userId_fkey` is
  // `ON DELETE SET NULL`, so removing a user detaches its accounts on both
  // sides rather than failing a constraint.
  // The implicit many-to-many fixtures, **in the seed for the same reason as
  // the accounts above** — and this one was found the hard way. They used to be
  // written by a `seedTags()` helper called from each test body, which
  // `expectSameWrite`'s own reset then wiped: every m-n case was comparing two
  // runs against an empty `Tag` table, agreeing that both clients failed, and
  // passing whatever the code did.
  //
  // One post already linked to two of the three tags, so `disconnect`, `set`
  // and a repeated `connect` all have something to act on and something to
  // leave alone.
  await prisma.tag.createMany({
    data: [{ label: "red" }, { label: "blue" }, { label: "green" }],
  });
  await prisma.post.create({
    data: { title: "existing", tags: { connect: [{ label: "red" }, { label: "blue" }] } },
  });

  const users = await prisma.user.findMany({ orderBy: { id: "asc" } });
  await prisma.account.createMany({
    data: [
      { publicId: "a1", userId: users[0].id, organizationId: acme.id },
      { publicId: "a2", userId: users[0].id, organizationId: acme.id },
      { publicId: "acc-mine-1", userId: users[0].id, organizationRole: 1 },
      { publicId: "acc-mine-2", userId: users[0].id, organizationRole: 2 },
      { publicId: "acc-theirs", userId: users[1].id, organizationRole: 1 },
    ],
  });

  // The to-one whose foreign key is on the **child** (#354) — the shape this
  // schema had none of, so the foreign side of a nested write had never been
  // compared against a real client at all.
  //
  // Two rows, and the split is the whole point. It is the same role `acc-theirs`
  // plays for the to-many above: without a parent that has *no* child, every
  // miss branch is unreachable and the cases below would all take the hit path
  // and pass whatever the miss path did.
  //
  //   `seed`  -> the first user, so `update` / `delete` / `upsert` / `disconnect`
  //             each have a child to act on
  //   `loose` -> nobody, so the second user misses on all four, and `connect`
  //             has an unattached row to attach
  //
  // Measured against this client before the cases were written: every to-one
  // miss is P2025 — the same error and the same wording for "no child" as for
  // "the child did not match the filter" — except an `upsert` whose `where`
  // does not match, which takes the create branch and collides on
  // `Profile.userId`'s unique index (P2002). Both are pinned below.
  await prisma.profile.createMany({
    data: [{ bio: "seed", userId: users[0].id }, { bio: "loose" }],
  });
}

/** `[name, operation, args, tables]` — tables default to the model written. */
type Case = [string, string, unknown, string[]?];

const CASES: Case[] = [
  // --- create -----------------------------------------------------------
  ["create minimal", "create", { data: { email: "new@example.dev" } }],
  ["create with every scalar kind", "create", {
    data: {
      name: "New",
      email: "n2@example.dev",
      globalRole: 1,
      locale: "fr-FR",
      emailVerifiedAt: new Date(EPOCH + 100),
      password: "secret",
    },
  }],
  /**
   * Bare JSON scalars — the one shape `docs/orm.md` says the two dialects
   * disagree on: refused on Postgres because the driver binds the value as an
   * integer against a `jsonb` column, accepted on SQLite.
   *
   * Nothing wrote one. The seed carries objects, an empty object, an array and
   * a JSON *string*, so every Json case the harness had was a shape where the
   * dialects agree — which is how a documented divergence went unmeasured.
   *
   * The harness compares failure *kind*, so these assert the interesting
   * thing without the test needing to know which dialect it is on: whatever
   * Postgres does, gemi and Prisma have to do the same.
   */
  ["create with a wrapped JSON number", "create", {
    data: { email: "json-wrapped@example.dev", metadata: { value: 42 } },
  }],
  // The bare scalars, which used to be excluded here because gemi raised on
  // Postgres where Prisma stored. #216 lifted that, so they belong in the table
  // like every other shape. (The note that replaced them pointed at a
  // `json-scalars.test.ts` that has never existed; the boundary was pinned in
  // `writes.coercion.test.ts`.)
  ["create with a bare JSON number", "create", {
    data: { email: "json-number@example.dev", metadata: 42 },
  }],
  ["create with a bare JSON boolean", "create", {
    data: { email: "json-boolean@example.dev", metadata: true },
  }],
  // Prisma's two null sentinels, which are *different rows*: `DbNull` leaves
  // the column SQL NULL, `JsonNull` stores the JSON value `null`. Both are
  // ordinary objects with no enumerable properties, so anything that reaches
  // `JSON.stringify` turns them into `{}` — which is what gemi stored, on both
  // dialects, silently. The harness compares table contents, so conflating them
  // again fails here.
  ["create with Prisma.DbNull", "create", {
    data: { email: "json-dbnull@example.dev", metadata: PrismaNamespace.DbNull },
  }],
  ["create with Prisma.JsonNull", "create", {
    data: { email: "json-jsonnull@example.dev", metadata: PrismaNamespace.JsonNull },
  }],
  // A nullable column explicitly set to null must stay null, not fall back to
  // a default — the difference between `?? default` and a key-presence check.
  ["create with an explicit null", "create", {
    data: { email: "n3@example.dev", locale: null },
  }],
  ["create overriding a cuid default", "create", {
    data: { publicId: "explicit-id", email: "n4@example.dev" },
  }],
  ["create overriding the timestamps", "create", {
    data: {
      email: "n5@example.dev",
      createdAt: new Date(EPOCH + 777),
      updatedAt: new Date(EPOCH + 888),
    },
  }],
  ["create with select", "create", {
    data: { email: "n6@example.dev" }, select: { email: true, globalRole: true },
  }],
  ["create with include", "create", {
    data: { email: "n7@example.dev" }, include: { accounts: true },
  }],
  ["create violating a unique", "create", {
    data: { email: "ada@example.dev" },
  }],

  // --- createMany -------------------------------------------------------
  ["createMany two rows", "createMany", {
    data: [{ email: "m1@example.dev" }, { email: "m2@example.dev" }],
  }],
  ["createMany one row", "createMany", { data: [{ email: "m3@example.dev" }] }],
  ["createMany empty", "createMany", { data: [] }],
  // Legal in Prisma, and the case a single multi-row INSERT cannot express
  // directly: the union of keys, with defaults filled per row.
  ["createMany mixed key sets", "createMany", {
    data: [
      { email: "m4@example.dev", name: "Has a name" },
      { email: "m5@example.dev" },
      { email: "m6@example.dev", globalRole: 1, locale: "de-DE" },
    ],
  }],
  ["createMany a single object", "createMany", {
    data: { email: "m7@example.dev" },
  }],

  // --- update -----------------------------------------------------------
  ["update by id", "update", { where: { id: 1 }, data: { name: "Renamed" } }],
  ["update by another unique", "update", {
    where: { publicId: "p2" }, data: { name: "Renamed" },
  }],
  ["update to null", "update", { where: { id: 1 }, data: { name: null } }],
  ["update several fields", "update", {
    where: { id: 1 }, data: { name: "N", globalRole: 2, locale: "es-ES" },
  }],
  ["update with set", "update", {
    where: { id: 1 }, data: { name: { set: "Via set" } },
  }],
  ["update with increment", "update", {
    where: { id: 1 }, data: { globalRole: { increment: 2 } },
  }],
  ["update with decrement", "update", {
    where: { id: 2 }, data: { globalRole: { decrement: 1 } },
  }],
  ["update with multiply", "update", {
    where: { id: 3 }, data: { globalRole: { multiply: 3 } },
  }],
  // `divide` was the one arithmetic operator the differential never compared,
  // sitting in the table beside three that it did. It is also the one with an
  // edge that behaves differently per dialect, hence the two cases below it.
  ["update with divide", "update", {
    where: { id: 1 }, data: { globalRole: { divide: 2 } },
  }],
  // An Int divided into a non-integer: whether the result truncates, rounds or
  // becomes a float is a database question, and both clients have to answer it
  // the same way.
  ["update with divide leaving a remainder", "update", {
    where: { id: 2 }, data: { globalRole: { divide: 3 } },
  }],
  // Division by zero: Postgres raises, SQLite yields null — and `globalRole` is
  // not nullable, so the two dialects fail differently. Both clients still have
  // to fail the *same* way as each other on whichever dialect is running.
  ["update with divide by zero", "update", {
    where: { id: 1 }, data: { globalRole: { divide: 0 } },
  }],
  ["update matching nothing", "update", {
    where: { id: 99999 }, data: { name: "x" },
  }],
  ["update with select", "update", {
    where: { id: 1 }, data: { name: "S" }, select: { id: true, name: true },
  }],
  ["update with include", "update", {
    where: { id: 1 }, data: { name: "S" }, include: { organization: true },
  }],
  ["update onto a unique collision", "update", {
    where: { id: 2 }, data: { email: "ada@example.dev" },
  }],

  // --- updateMany -------------------------------------------------------
  ["updateMany several", "updateMany", {
    where: { globalRole: { gte: 0 } }, data: { locale: "it-IT" },
  }],
  ["updateMany one", "updateMany", {
    where: { publicId: "p1" }, data: { name: "Only" },
  }],
  ["updateMany none", "updateMany", {
    where: { publicId: "nope" }, data: { name: "x" },
  }],
  ["updateMany with no where", "updateMany", { data: { globalRole: 2 } }],
  ["updateMany with increment", "updateMany", {
    where: { globalRole: { lt: 2 } }, data: { globalRole: { increment: 1 } },
  }],

  // --- delete -----------------------------------------------------------
  ["delete by id", "delete", { where: { id: 3 } }],
  ["delete by another unique", "delete", { where: { publicId: "p3" } }],
  ["delete matching nothing", "delete", { where: { id: 99999 } }],
  ["delete with select", "delete", {
    where: { id: 3 }, select: { publicId: true },
  }],

  // --- deleteMany -------------------------------------------------------
  ["deleteMany several", "deleteMany", { where: { globalRole: { gte: 1 } } }],
  ["deleteMany none", "deleteMany", { where: { publicId: "nope" } }],
  ["deleteMany empty where", "deleteMany", { where: {} }],

  // --- upsert -----------------------------------------------------------
  ["upsert inserting", "upsert", {
    where: { email: "fresh@example.dev" },
    create: { email: "fresh@example.dev", name: "Fresh" },
    update: { name: "Updated" },
  }],
  ["upsert updating", "upsert", {
    where: { email: "ada@example.dev" },
    create: { email: "ada@example.dev", name: "Fresh" },
    update: { name: "Updated" },
  }],
  ["upsert updating by id", "upsert", {
    where: { id: 1 },
    create: { id: 1, email: "other@example.dev" },
    update: { globalRole: { increment: 5 } },
  }],
  ["upsert with select", "upsert", {
    where: { email: "ada@example.dev" },
    create: { email: "ada@example.dev" },
    update: { name: "U" },
    select: { name: true },
  }],

  // `create` leaves the conflict key unset, which `on conflict` cannot express:
  // the insert could never collide on the target. Prisma means find-then-write,
  // and its semantics here are surprising enough to be worth comparing rather
  // than reasoning about — the inserted row's `publicId` is **generated**, not
  // the one the `where` named. Both branches, and a `select` over each.
  ["upsert omitting the key, missing", "upsert", {
    where: { publicId: "no-such-public-id" },
    create: { email: "omitted@example.dev" },
    update: { name: "Updated" },
    select: { email: true, name: true },
  }],
  ["upsert omitting the key, hitting", "upsert", {
    where: { publicId: "p1" },
    create: { email: "unused@example.dev" },
    update: { name: "Updated" },
    select: { email: true, name: true },
  }],

  // --- _count on a write (#87) ------------------------------------------
  //
  // It used to be accepted and dropped: the row came back with no `_count` key
  // and no error, while an unknown relation name in the same `include` raised.
  // Every case below returns a number Prisma also returns, and the `update` /
  // `upsert` / `delete` ones return a *non-zero* one, which is what separates
  // "projected correctly" from "projected as zero".
  ["create with _count", "create", {
    data: { email: "c1@example.dev" },
    include: { _count: { select: { accounts: true } } },
  }],
  ["update with _count", "update", {
    where: { publicId: "p1" }, data: { name: "Counted" },
    include: { _count: { select: { accounts: true } } },
  }],
  ["update with _count beside a relation", "update", {
    where: { publicId: "p1" }, data: { name: "Counted" },
    include: { accounts: true, _count: { select: { accounts: true } } },
  }],
  ["update with _count in a select", "update", {
    where: { publicId: "p1" }, data: { name: "Counted" },
    select: { email: true, _count: { select: { accounts: true } } },
  }],
  ["update with a filtered _count", "update", {
    where: { publicId: "p1" }, data: { name: "Counted" },
    include: {
      _count: { select: { accounts: { where: { organizationRole: 2 } } } },
    },
  }],
  ["upsert hitting, with _count", "upsert", {
    where: { publicId: "p1" },
    create: { email: "unused2@example.dev" },
    update: { name: "Counted" },
    include: { _count: { select: { accounts: true } } },
  }],
  // The one where the order of operations decides the answer. `Account`'s FK is
  // `ON DELETE SET NULL`, so a count taken *after* the statement is 0 and one
  // taken before it is 2 — which is why a `delete` carrying a `_count` is read
  // first, the same way one carrying an `include` already was.
  //
  // **Discriminating on Postgres only, and the reason is its own bug.** Bun's
  // SQLite driver leaves `pragma foreign_keys` at 0 and nothing in gemi turns it
  // on, so no referential action ever fires there: the accounts keep pointing at
  // the deleted user and a count taken after the delete would read 2 as well.
  // Prisma enables the pragma, so the two disagree about the *table* — #89, and
  // the reason this case compares `User` alone rather than asserting a
  // difference that is really about foreign keys.
  ["delete with _count", "delete", {
    where: { publicId: "p1" },
    include: { _count: { select: { accounts: true } } },
  }],
  // The same call with an `omit` on it. Prisma refuses `select` + `omit` — they
  // describe two different column lists — but takes `include` + `omit`, and the
  // read-first path above is where that stopped being true here: it rebuilt the
  // pre-read's projection out of `select` or `include` alone, so adding a
  // relation to a call that already omitted a column handed the column back.
  //
  // Both halves of that branch's condition, because either one reaches it and
  // they reach it by different routes — `plan.counts` for the `_count`, which
  // has no relation plan behind it at all, and `plan.relations` for the
  // `include`. One of them under Prisma and the other under a hand-written
  // expectation would leave the half nobody measured free to drift.
  ["delete with an omit beside a _count", "delete", {
    where: { publicId: "p1" },
    include: { _count: { select: { accounts: true } } },
    omit: { password: true },
  }],
  ["delete with an omit beside a relation include", "delete", {
    where: { publicId: "p1" },
    include: { accounts: { orderBy: { id: "asc" } } },
    omit: { password: true },
  }],

  // --- foreign keys (#89) -----------------------------------------------
  //
  // Every one of these **succeeded on SQLite** before the pragma was turned on,
  // writing a row that points at an organisation which does not exist, while
  // Prisma refused it. They are in the shared matrix rather than a Postgres-only
  // block precisely because the dialect that used to be wrong is the default
  // one.
  ["create naming a parent that does not exist", "create", {
    data: { email: "orphan@example.dev", organizationId: 99999 },
  }],
  ["createMany naming a parent that does not exist", "createMany", {
    data: [
      { email: "orphan2@example.dev" },
      { email: "orphan3@example.dev", organizationId: 99999 },
    ],
  }],
  ["update repointing at a parent that does not exist", "update", {
    where: { id: 1 }, data: { organizationId: 99999 },
  }],
  ["upsert inserting against a parent that does not exist", "upsert", {
    where: { email: "orphan4@example.dev" },
    create: { email: "orphan4@example.dev", organizationId: 99999 },
    update: { name: "Updated" },
  }],
  // The nested form, where the foreign key is written by an `after` step rather
  // than by the statement itself — a different code path to the same constraint.
  ["nested create naming a parent that does not exist", "create", {
    data: {
      email: "orphan5@example.dev",
      accounts: { create: { organizationRole: 1, organizationId: 99999 } },
    },
  }, ["User", "Account"]],

  // --- a to-one whose foreign key is on the child (#354) -----------------
  //
  // `update`, `delete` and `upsert` were refused by name on this side, and the
  // reason nothing caught how much that mattered is that the harness had no
  // relation of this shape to reach: every child-side relation in the schema
  // was a list. `Profile` is that relation, and these are the measurements the
  // implementation was written from, one case per answer, so the answer is
  // pinned rather than remembered.
  //
  // The `M<n>` labels are the rows of the measurement table in the plan. They
  // are in the test names on purpose: a failure here names the measurement it
  // contradicts, which is the only way to tell "gemi regressed" from "Prisma
  // changed its mind" without re-deriving the whole table.
  //
  // User 1 has a profile, user 2 does not — see the seed. Every case compares
  // both tables, because the interesting half of a to-one write is usually the
  // child's foreign key rather than the parent row that comes back.

  // M1 — a nested `update` on a parent with no child. The open question was
  // P2025 or a silent no-op; it is P2025, and the parent's own assignments do
  // not land either. `notFound` on both sides, so a gemi refusal cannot pass
  // for it: `failureKind` classifies an `UnsupportedQueryError` as `other`.
  ["M1 to-one update with no child raises", "update", {
    where: { id: 2 }, data: { profile: { update: { bio: "changed" } } },
  }, ["User", "Profile"]],
  // M1b — the `{ data }` wrapper makes no difference to the miss.
  ["M1b to-one update with no child, wrapped in data", "update", {
    where: { id: 2 }, data: { profile: { update: { data: { bio: "changed" } } } },
  }, ["User", "Profile"]],

  // M2 — the one the plan flagged as possibly changing the code's shape,
  // because a `findFirst` miss is treated as fatal one level down. It does not:
  // a `where` that matches nothing with a child *present* is the same P2025,
  // with the same wording, as no child at all. Fatal-on-miss was already right.
  ["M2 to-one update whose where matches nothing raises", "update", {
    where: { id: 1 },
    data: { profile: { update: { where: { bio: "nope" }, data: { bio: "changed" } } } },
  }, ["User", "Profile"]],
  // M2b — the control, and the one that shows the `where` is a **filter**:
  // `bio` carries no unique index, and Prisma takes it anyway.
  ["M2b to-one update whose where matches", "update", {
    where: { id: 1 },
    data: { profile: { update: { where: { bio: "seed" }, data: { bio: "changed" } } } },
  }, ["User", "Profile"]],
  // M2c — no child *and* a non-matching filter. One error for both, which is
  // why gemi needs only one `RecordNotFoundError` message here.
  ["M2c to-one update, no child and a non-matching where", "update", {
    where: { id: 2 },
    data: { profile: { update: { where: { bio: "nope" }, data: { bio: "changed" } } } },
  }, ["User", "Profile"]],

  // M3 — `delete: true` with nothing linked. P2025, *not* the to-many
  // "the row named by `true` is not connected" refusal, which would classify as
  // `other` here and disagree.
  ["M3 to-one delete true with no child raises", "update", {
    where: { id: 2 }, data: { profile: { delete: true } },
  }, ["User", "Profile"]],
  // M3b — the control. `delete: true` removes the row rather than unlinking it.
  ["M3b to-one delete true removes the row", "update", {
    where: { id: 1 }, data: { profile: { delete: true } },
  }, ["User", "Profile"]],

  // M4 — a `delete` filter that matches nothing, with a child present. Fatal,
  // exactly like M3, so the filter form needs no miss handling of its own.
  ["M4 to-one delete with a non-matching filter raises", "update", {
    where: { id: 1 }, data: { profile: { delete: { bio: "nope" } } },
  }, ["User", "Profile"]],
  // M4b — the control, and the case that rules out `assertNamedRows` on this
  // path: `bio` is not unique and the operand is accepted regardless.
  ["M4b to-one delete takes a filter, not a unique key", "update", {
    where: { id: 1 }, data: { profile: { delete: { bio: "seed" } } },
  }, ["User", "Profile"]],

  // M5 / M5b — the booleans that mean *nothing happens*, and the pair the plan
  // cache used to collide: `disconnect`/`delete` recorded a non-literal boolean
  // as `"boolean"`, so a plan compiled from `true` served `false` and cleared a
  // foreign key on a call that asked for nothing. Both must leave the child
  // untouched, which the table comparison is what actually checks.
  ["M5 to-one delete false is a strict no-op", "update", {
    where: { id: 1 }, data: { profile: { delete: false } },
  }, ["User", "Profile"]],
  ["M5b to-one disconnect false is a strict no-op", "update", {
    where: { id: 1 }, data: { profile: { disconnect: false } },
  }, ["User", "Profile"]],

  // M6 — `upsert` with no child: the create branch runs **and stamps the
  // child's foreign key** from the parent's key. `where` is genuinely optional
  // on a to-one, which is why it is absent here.
  ["M6 to-one upsert with no child creates and links", "update", {
    where: { id: 2 },
    data: {
      profile: { upsert: { create: { bio: "created" }, update: { bio: "updated" } } },
    },
  }, ["User", "Profile"]],
  // M6b — the other branch, still with no `where`: the single linked child.
  ["M6b to-one upsert with a child updates it", "update", {
    where: { id: 1 },
    data: {
      profile: { upsert: { create: { bio: "created" }, update: { bio: "updated" } } },
    },
  }, ["User", "Profile"]],
  // M7 — the only to-one miss that is *not* P2025. A `where` that matches
  // nothing takes the create branch, which then collides with the child's
  // unique foreign key: `unique`, not `notFound`. gemi has to let the create
  // run and surface the collision rather than pre-empting it, and the harness
  // compares the kind, so pre-empting would show up here as a disagreement.
  ["M7 to-one upsert whose where misses collides on the unique key", "update", {
    where: { id: 1 },
    data: {
      profile: {
        upsert: {
          where: { bio: "nope" },
          create: { bio: "created" },
          update: { bio: "updated" },
        },
      },
    },
  }, ["User", "Profile"]],

  // M8 — the asymmetry that keeps `delete` and `disconnect` from sharing their
  // miss handling even though they share a body: a `disconnect` that finds
  // nothing is **silent**, where the same `delete` is P2025 (M3).
  ["M8 to-one disconnect true with no child is silent", "update", {
    where: { id: 2 }, data: { profile: { disconnect: true } },
  }, ["User", "Profile"]],
  // M8b — the control, and adjacent defect 2: this used to be refused outright.
  // The row survives; only the foreign key is cleared.
  ["M8b to-one disconnect true clears the child's key", "update", {
    where: { id: 1 }, data: { profile: { disconnect: true } },
  }, ["User", "Profile"]],
  // M8c — and a `disconnect` filter that matches nothing is silent too, so the
  // silence is about the operand rather than about the spelling.
  ["M8c to-one disconnect with a non-matching filter is silent", "update", {
    where: { id: 1 }, data: { profile: { disconnect: { bio: "nope" } } },
  }, ["User", "Profile"]],
  // M8d — and `null` is not a third spelling of the silence. Both clients
  // refuse it: a `PrismaClientValidationError` there, an `InvalidArgumentError`
  // here, so `other` on both sides and nothing written. The owning side's
  // twin is `O11`, and the pair is the point — this is the grammar the two
  // sides now share, so a value one of them swallowed and the other refused
  // would be #359 again with the roles reversed.
  ["M8d to-one disconnect null is refused by both", "update", {
    where: { id: 1 }, data: { profile: { disconnect: null } },
  }, ["User", "Profile"]],

  // M9 — the `{ data }` wrapper on the **foreign** side. It was measured on the
  // owning side only, and the three spellings (bare, `{ data }`,
  // `{ where, data }`) are one operation, which is what lets the normaliser
  // collapse them at compile time.
  ["M9 to-one update wrapped in data, child present", "update", {
    where: { id: 1 }, data: { profile: { update: { data: { bio: "changed" } } } },
  }, ["User", "Profile"]],

  // M10 — arrays on a to-one. Prisma refuses every one of them at *validation*
  // time, with no `P` code: the generated operand types are singular, with no
  // `| X[]` arm, unlike their to-many siblings. So this is not gemi being
  // stricter than Prisma — compiling these was a live divergence that wrote or
  // repointed several rows through a relation that holds one.
  //
  // `other` on both sides, which is all the harness can honestly claim for an
  // argument-shape refusal; `refusals.test.ts` asserts the error class and the
  // wording. What these add is the half that suite cannot see: that Prisma
  // refuses them too, and that **nothing is written** by either client.
  ["M10 an array of create on a to-one", "update", {
    where: { id: 2 }, data: { profile: { create: [{ bio: "a" }, { bio: "b" }] } },
  }, ["User", "Profile"]],
  ["M10 an array of connect on a to-one", "update", {
    where: { id: 2 }, data: { profile: { connect: [{ id: 1 }, { id: 2 }] } },
  }, ["User", "Profile"]],
  ["M10 an array of connectOrCreate on a to-one", "update", {
    where: { id: 2 },
    data: {
      profile: {
        connectOrCreate: [
          { where: { id: 2 }, create: { bio: "a" } },
          { where: { id: 99 }, create: { bio: "b" } },
        ],
      },
    },
  }, ["User", "Profile"]],
  ["M10 an array of update on a to-one", "update", {
    where: { id: 1 },
    data: {
      profile: {
        update: [
          { where: { bio: "seed" }, data: { bio: "a" } },
          { where: { bio: "loose" }, data: { bio: "b" } },
        ],
      },
    },
  }, ["User", "Profile"]],
  ["M10 an array of delete on a to-one", "update", {
    where: { id: 1 }, data: { profile: { delete: [{ bio: "seed" }] } },
  }, ["User", "Profile"]],
  ["M10 an array of upsert on a to-one", "update", {
    where: { id: 1 },
    data: {
      profile: {
        upsert: [{ create: { bio: "a" }, update: { bio: "b" } }],
      },
    },
  }, ["User", "Profile"]],
  // The controls for the two operands that were *not* refused before, so the
  // array refusal cannot have been bought by refusing the singular form too.
  ["a single create on a to-one", "update", {
    where: { id: 2 }, data: { profile: { create: { bio: "made" } } },
  }, ["User", "Profile"]],
  // `loose` belongs to nobody, so this attaches rather than repointing.
  ["a single connect on a to-one", "update", {
    where: { id: 2 }, data: { profile: { connect: { id: 2 } } },
  }, ["User", "Profile"]],
  // And the one whose answer is not guessable: connecting a child that is
  // already somebody else's **repoints** it, leaving the first parent with no
  // profile — measured, because the alternative (a unique violation) is just as
  // plausible a thing for a one-to-one to do.
  ["a single connect that steals another parent's child", "update", {
    where: { id: 2 }, data: { profile: { connect: { id: 1 } } },
  }, ["User", "Profile"]],

  // M14 — a nested `create` onto a to-one that **already has a child** (#360),
  // which was a `UniqueConstraintError` here and an answer there until this
  // graduated out of the "still disagree" describe below.
  //
  // **Numbered from M14 rather than M11**, which is where these first landed:
  // `M11` through `M12d` were already taken further down this file, and a
  // duplicate id makes `-t "M12b"` select two unrelated tests. #361's
  // acceptance criteria name `M11c` / `M11d` as the pins that have to stay
  // green — they are `M14c` / `M14d` below, renamed for that reason and for no
  // other.
  //
  // The incumbent is **orphaned, not deleted**: three rows afterwards, the old
  // one holding a null foreign key. That is the half worth reading the table
  // for — a fix that deleted the displaced row instead would be silent data
  // loss wearing this same green test, which is why `tables` names `Profile`.
  ["M14 to-one create displaces the incumbent, orphaning it", "update", {
    where: { id: 1 }, data: { profile: { create: { bio: "second" } } },
  }, ["User", "Profile"]],
  // The control on the other statement: a *new* parent can have nothing linked
  // to displace, so the same operand costs the same as it always did.
  ["M14b to-one create under a create has nothing to displace", "create", {
    data: { email: "fresh@example.dev", profile: { create: { bio: "first" } } },
  }, ["User", "Profile"]],
  // And the neighbours that do **not** displace. Measured rather than assumed
  // symmetric, and the asymmetry is worth stating because it is not derivable:
  // the *create branch* of `connectOrCreate` and of `upsert` collides on the
  // child's unique foreign key, where the bare `create` above detaches. So what
  // displaces is the bare `create` and anything that **links an existing row**
  // (M15 below) — not "every operand that ends with a child pointing here".
  ["M14c to-one connectOrCreate whose where misses collides", "update", {
    where: { id: 1 },
    data: {
      profile: {
        connectOrCreate: { where: { id: 99 }, create: { bio: "coc" } },
      },
    },
  }, ["User", "Profile"]],
  ["M14d to-one upsert whose where misses collides", "update", {
    where: { id: 1 },
    data: {
      profile: {
        upsert: { where: { id: 99 }, create: { bio: "up" }, update: { bio: "x" } },
      },
    },
  }, ["User", "Profile"]],

  // M15 — `connect` onto a to-one that **already has a child** (#361), the
  // neighbour of M14 and the same displacement. Four shapes, and only this one
  // ever diverged: the three above it — an empty to-one, a steal from another
  // parent, and the row already linked here — agreed before the fix and are
  // what kept it hidden.
  ["M15 to-one connect displaces the incumbent, orphaning it", "update", {
    where: { id: 1 }, data: { profile: { connect: { id: 2 } } },
  }, ["User", "Profile"]],
  // The clear and the link cross on this one: `clearLinks` nulls the very row
  // the caller named and the repoint puts the key straight back. Net nothing,
  // which is Prisma's answer, and the case that would catch a clear scoped to
  // the wrong rows.
  ["M15b to-one connect of the row already linked changes nothing", "update", {
    where: { id: 1 }, data: { profile: { connect: { id: 1 } } },
  }, ["User", "Profile"]],
  // A miss detaches nothing — the repoint raises and takes the clear down with
  // it. `notFound` on both sides, so a gemi refusal could not pass for it.
  ["M15c to-one connect naming no row raises and displaces nothing", "update", {
    where: { id: 1 }, data: { profile: { connect: { id: 99 } } },
  }, ["User", "Profile"]],
  // ...and `connectOrCreate`'s *hit* branch is a connect, so it displaces where
  // its miss branch (M14c) collides. Both branches of one operand, answering
  // differently, which is why `displaces` is consulted per branch rather than
  // per operand.
  ["M15d to-one connectOrCreate hitting a row displaces the incumbent", "update", {
    where: { id: 1 },
    data: {
      profile: {
        connectOrCreate: { where: { id: 2 }, create: { bio: "unused" } },
      },
    },
  }, ["User", "Profile"]],

  // M16 — the boundary on the other side of `displaces`, from the **owning**
  // end of a key (#363): a *many*-to-one connect has no incumbent, so nothing
  // is detached and both rows end up on the same parent. Measured, and the
  // logged statements are the operand lookup and the `update` — Prisma does not
  // even read the sibling.
  //
  // Here rather than left implied, because the two relations are one operand
  // spelled identically and the discriminator between them is a schema property
  // the caller cannot see. Without this, a `displaces` that widened from "the
  // foreign key is unique" to "the relation points at one row" would detach
  // user 1 from Acme on a call about user 2, and every existing case would stay
  // green — `User.organization` is the ordinary many-to-one that a nested
  // `connect` is nearly always written against.
  ["M16 a many-to-one connect leaves the parent's other rows alone", "update", {
    where: { id: 2 }, data: { organization: { connect: { id: 1 } } },
  }, ["User", "Organization"]],
];

/**
 * The **owning** side of the same to-one: `Profile.update`, where the foreign
 * key is on the row being written (#359).
 *
 * A table of its own rather than rows in `CASES`, for one mechanical reason:
 * every `CASES` entry runs against `User`, and this side is only reachable from
 * the model that holds the key. Same harness, same comparison, same rule that
 * a case belongs here exactly when the two clients agree.
 *
 * `O5` and `O6` are the ones that decide what the filter arm *means*: a filter
 * matching nothing is **silent**, not P2025, so this is a conditional detach
 * rather than a guarded one. Measured on Prisma 6.19.2 before it was written.
 */
const OWNING_CASES: [string, string, unknown, string[]?][] = [
  // User 1 is Ada and holds profile 1; profile 2 (`loose`) is linked to nobody.
  ["O1 owning disconnect true clears the link", "update", {
    where: { id: 1 }, data: { user: { disconnect: true } },
  }, ["Profile", "User"]],
  // The headline of #359: the branch that asked for *nothing*. A caller writes
  // `disconnect: shouldDetach`, and this is the value that used to be refused —
  // after a spell in which a warm `true` plan served it and nulled the key.
  ["O2 owning disconnect false is a strict no-op", "update", {
    where: { id: 1 }, data: { user: { disconnect: false } },
  }, ["Profile", "User"]],
  ["O3 owning disconnect {} clears the link", "update", {
    where: { id: 1 }, data: { user: { disconnect: {} } },
  }, ["Profile", "User"]],
  ["O4 owning disconnect with a matching filter clears the link", "update", {
    where: { id: 1 }, data: { user: { disconnect: { name: "Ada" } } },
  }, ["Profile", "User"]],
  ["O5 owning disconnect with a non-matching filter is silent", "update", {
    where: { id: 1 }, data: { user: { disconnect: { name: "Grace" } } },
  }, ["Profile", "User"]],
  ["O6 owning disconnect with a filter and nothing linked is silent", "update", {
    where: { id: 2 }, data: { user: { disconnect: { name: "Ada" } } },
  }, ["Profile", "User"]],
  ["O7 owning disconnect true with nothing linked is silent", "update", {
    where: { id: 2 }, data: { user: { disconnect: true } },
  }, ["Profile", "User"]],
  // Beside a real column write, because `false` contributes no assignment at
  // all: without something else in `data` the statement degenerates to a read,
  // and this is what shows the two are independent rather than one hiding the
  // other.
  ["O8 owning disconnect false beside a column write", "update", {
    where: { id: 1 }, data: { bio: "changed", user: { disconnect: false } },
  }, ["Profile", "User"]],
  ["O9 owning disconnect with a matching filter beside a column write", "update", {
    where: { id: 1 },
    data: { bio: "changed", user: { disconnect: { name: "Ada" } } },
  }, ["Profile", "User"]],
  // An operator filter, not just an equality: the operand is a `WhereInput`,
  // and nothing about the implementation narrows it to scalars.
  ["O10 owning disconnect takes an operator filter", "update", {
    where: { id: 1 },
    data: { user: { disconnect: { name: { contains: "Ad" } } } },
  }, ["Profile", "User"]],
  // O11 — the value the grammar does **not** have an arm for, which is a case
  // in this table rather than a divergence below because both clients refuse
  // it: `PrismaClientValidationError` there (no `P` code, so `other` on both
  // sides, which is all the harness can claim for an argument refusal) and
  // `InvalidArgumentError` here.
  //
  // It is here at all because widening this side's grammar to Prisma's (#359)
  // could have made it *silent*. `null` is what `toOneOperand` translates
  // `false` into, so a shape check downstream of that translation sees one
  // value for two calls — and the earlier refusal-of-everything-but-`true` had
  // been covering the difference. A refusal quietly becoming a no-op is the
  // failure class this suite exists to catch; that it would have been a
  // harmless no-op is not the point, since nothing here would have said so.
  ["O11 owning disconnect null is refused by both", "update", {
    where: { id: 1 }, data: { user: { disconnect: null } },
  }, ["Profile", "User"]],

  // O12 — `connect` into a to-one that is **already taken** (#363), the mirror
  // of M15 across the key. gemi raised `UniqueConstraintError` on this and
  // Prisma detaches the incumbent and takes the link, which is what the pin in
  // the "still disagree" describe recorded until this graduated.
  //
  // **It reads left-to-right as the opposite of the pin it replaces, and that
  // is the whole reason it can live in this table.** The pin moves profile 1
  // into an occupied user 2, which the seed does not have and which every to-one
  // case in `CASES` wants the opposite of — user 2's to-one being *empty* is
  // what makes `M1`, `M3`, `M6` and `M8` reach their miss branches at all. Read
  // the other way round the seed already carries the state: profile 2 (`loose`)
  // holds nobody, and user 1 is occupied by profile 1. So `loose` moving into
  // user 1 is the same collision with no arrangement at all, and #363's
  // acceptance — "the case moves into `OWNING_CASES`" — costs nothing.
  //
  // The incumbent is **orphaned, not deleted**, which is why `tables` names
  // `Profile`: a fix that deleted the displaced row would be silent data loss
  // wearing this same green test.
  ["O12 owning connect into an occupied to-one displaces the incumbent", "update", {
    where: { id: 2 }, data: { user: { connect: { id: 1 } } },
  }, ["Profile", "User"]],
  // The control on the empty far row — the shape that always worked, and the
  // one that keeps O12 about the *incumbent* rather than about owning-side
  // `connect` in general. User 2 holds no profile.
  ["O12b owning connect into an empty to-one attaches", "update", {
    where: { id: 2 }, data: { user: { connect: { id: 2 } } },
  }, ["Profile", "User"]],
  // The row being written *is* the incumbent. Prisma nulls it and writes the
  // same value straight back for a net nothing; gemi skips the clear and
  // reaches the same table. The case that would catch a clear which fired on
  // the row the repoint was about to restore.
  ["O12c owning connect of the user already linked here changes nothing", "update", {
    where: { id: 1 }, data: { user: { connect: { id: 1 } } },
  }, ["Profile", "User"]],
  // Beside a real column write, for the reason O8 gives: without something else
  // in `data` a step and an assignment are hard to tell apart.
  ["O12d owning connect into an occupied to-one beside a column write", "update", {
    where: { id: 2 }, data: { bio: "changed", user: { connect: { id: 1 } } },
  }, ["Profile", "User"]],
  // The **other** `connect` form, and it is a second code path rather than a
  // second spelling: naming a unique key the relation does not reference costs
  // a lookup, so the value the clear needs does not exist until that lookup has
  // run. Without this case the whole displacing branch of the resolved form is
  // unexercised — every case above takes the direct one, where the value is
  // read straight out of the argument tree. `p1` is user 1, seeded by name.
  ["O12e owning connect by a non-referenced unique displaces too", "update", {
    where: { id: 2 }, data: { user: { connect: { publicId: "p1" } } },
  }, ["Profile", "User"]],
  // A `connect` naming no row detaches nothing: the resolve raises first, and
  // the clear sits behind it in the same step. `notFound` on both sides.
  ["O12f owning connect naming no row raises and displaces nothing", "update", {
    where: { id: 2 }, data: { user: { connect: { publicId: "nobody" } } },
  }, ["Profile", "User"]],
  // And a statement with no row to write leaves the incumbent alone. Both
  // clients get there through the transaction rather than through a guard:
  // Prisma issues the detach and rolls it back — the logged statements are the
  // clear, then `ROLLBACK`, then P2025 — and gemi's `update` raises
  // `RecordNotFoundError`, which takes its own `before` step down with it. The
  // committed state is the thing either client promises, and this pins it.
  ["O12g owning connect whose own where matches nothing displaces nothing", "update", {
    where: { id: 99 }, data: { user: { connect: { id: 1 } } },
  }, ["Profile", "User"]],

  // O13 — the same displacement under a `create`, which is a different statement
  // and not a different rule. There is no row yet, so nothing this one holds can
  // be the incumbent and the step reads nothing before clearing. Measured:
  // Prisma logs the operand lookup, the incumbent clear and the `INSERT`, in
  // that order, inside one transaction.
  ["O13 owning connect into an occupied to-one under a create", "create", {
    data: { bio: "fresh", user: { connect: { id: 1 } } },
  }, ["Profile", "User"]],
  ["O13b owning connect into an empty to-one under a create", "create", {
    data: { bio: "fresh", user: { connect: { id: 2 } } },
  }, ["Profile", "User"]],

  // O14 — `connectOrCreate`, whose two branches answer differently for the same
  // reason they do on the foreign side (M14c / M15d): a **hit** is a connect, so
  // it displaces; a **miss** mints the far row, which nothing can already be
  // pointing at.
  ["O14 owning connectOrCreate hitting an occupied to-one displaces", "update", {
    where: { id: 2 },
    data: {
      user: { connectOrCreate: { where: { id: 1 }, create: { email: "unused@example.dev" } } },
    },
  }, ["Profile", "User"]],
  ["O14b owning connectOrCreate missing creates the far row and displaces nothing", "update", {
    where: { id: 2 },
    data: {
      user: { connectOrCreate: { where: { id: 99 }, create: { email: "coc@example.dev" } } },
    },
  }, ["Profile", "User"]],

  // O15 — the owning-side `create`, which has no incumbent by construction: the
  // far row is minted by this very operand. Here so that "what displaces" is
  // pinned as a *list* rather than as a rule that could quietly widen to
  // "anything that ends with this row pointing somewhere".
  ["O15 owning create mints the far row and displaces nothing", "update", {
    where: { id: 2 }, data: { user: { create: { email: "minted@example.dev" } } },
  }, ["Profile", "User"]],
];

function suite(label: string, url?: string) {
  describe(label, () => {
    let differential: Differential;

    beforeAll(async () => {
      differential = await createDifferential({
        models: {
          User: UserModel as never,
          Post: PostModel as never,
          Tag: TagModel as never,
          Membership: MembershipModel as never,
          SocialAccount: SocialAccountModel as never,
          Account: AccountModel as never,
          Organization: OrganizationModel as never,
          // `readTables` reads `$schema.primaryKey` off the registered class to
          // order its comparison read, so a model that is compared but not
          // listed here is not a missing convenience — it throws.
          Profile: ProfileModel as never,
          PasswordResetToken: PasswordResetTokenModel as never,
        },
        seed,
        url,
      });
    }, 120_000);

    afterAll(async () => {
      await differential?.dispose();
    });

    test.each(CASES)("%s", async (_name, operation, args, tables) => {
      await differential.expectSameWrite("User", operation, args, { tables });
    });

    test.each(OWNING_CASES)("%s", async (_name, operation, args, tables) => {
      await differential.expectSameWrite("Profile", operation, args, { tables });
    });

    // Writing through a model whose `@@unique` is composite, which is the only
    // way to reach the compound conflict target.
    test("upsert on a model with a composite unique", async () => {
      await differential.expectSameWrite(
        "Organization",
        "upsert",
        {
          where: { publicId: "o1" },
          create: { publicId: "o1", name: "Created" },
          update: { name: "Updated" },
        },
        { tables: ["Organization"] },
      );
    });

    /**
     * Implicit many-to-many writes (#66), against a **real Prisma client**.
     *
     * The existing m-n coverage builds its own tables and asserts Prisma's
     * *documented* shape — adequate for reads and thin for writes, where the
     * failure is a value landing in the wrong column of a join table nobody
     * looks at, and a fixture asserting its own expectations agrees with it.
     * Comparing the table contents afterwards is what catches that.
     */
    describe("an implicit many-to-many", () => {
      test("connect attaches existing rows", async () => {
        await differential.expectSameWrite(
          "Post",
          "create",
          {
            data: {
              title: "first",
              tags: { connect: [{ label: "red" }, { label: "blue" }] },
            },
            include: { tags: { orderBy: { id: "asc" } } },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      test("create writes the child and the pair", async () => {
        await differential.expectSameWrite(
          "Post",
          "create",
          {
            data: { title: "second", tags: { create: [{ label: "fresh" }] } },
            include: { tags: { orderBy: { id: "asc" } } },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      test("connect and create together", async () => {
        await differential.expectSameWrite(
          "Post",
          "create",
          {
            data: {
              title: "third",
              tags: { connect: [{ label: "red" }], create: [{ label: "novel" }] },
            },
            include: { tags: { orderBy: { id: "asc" } } },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      test("disconnect removes one pair and leaves the row", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          {
            where: { id: 1 },
            data: { tags: { disconnect: [{ label: "red" }] } },
            include: { tags: { orderBy: { id: "asc" } } },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      /** Two statements — delete then insert — inside the step's transaction. */
      test("set replaces the whole set", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          {
            where: { id: 1 },
            data: { tags: { set: [{ label: "blue" }, { label: "green" }] } },
            include: { tags: { orderBy: { id: "asc" } } },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      test("set to nothing clears them", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          {
            where: { id: 1 },
            data: { tags: { set: [] } },
            include: { tags: true },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      /**
       * Prisma treats a repeated `connect` as a no-op. Without
       * `on conflict do nothing` the pair's primary key makes it a raw driver
       * unique violation — neither Prisma's behaviour nor a useful one.
       */
      test("connecting the same pair twice is a no-op", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          {
            where: { id: 1 },
            data: { tags: { connect: [{ label: "red" }] } },
            include: { tags: true },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      /**
       * The far direction: the same relation written from `Tag`. `green` is
       * the seeded tag with no posts, so the connect has something to change.
       */
      test("the relation writes from the other side too", async () => {
        await differential.expectSameWrite(
          "Tag",
          "update",
          {
            where: { label: "green" },
            data: { posts: { connect: [{ title: "existing" }] } },
            include: { posts: true },
          },
          { tables: ["Post", "Tag"] },
        );
      });
    });

    /**
     * A compound `@@id`, which was unreachable by key at all (#80): the
     * compound form was rejected as an unknown field and the field-by-field
     * form for not naming a unique key, each error pointing at the other.
     *
     * Against Prisma, so the *shape* of the compound argument is its answer
     * rather than mine — including `upsert`, which compiles the key into an
     * `on conflict` target and would resolve against the wrong constraint if it
     * named the wrong columns.
     */
    describe("a compound @@id", () => {
      const key = { organizationId_userId: { organizationId: 1, userId: 7 } };

      test("findUnique by the compound key", async () => {
        await differential.reset();
        await differential.prisma.membership.create({
          data: { organizationId: 1, userId: 7, role: 0 },
        });

        await differential.expectSame("Membership", "findUnique", { where: key });
        await differential.expectSame("Membership", "findUnique", {
          where: { organizationId_userId: { organizationId: 9, userId: 9 } },
        });
      });

      test.each([
        ["update", { where: key, data: { role: 1 } }],
        ["delete", { where: key }],
        [
          "upsert inserting",
          {
            where: { organizationId_userId: { organizationId: 2, userId: 8 } },
            create: { organizationId: 2, userId: 8, role: 1 },
            update: { role: 2 },
          },
        ],
        [
          "upsert updating",
          { where: key, create: { organizationId: 1, userId: 7 }, update: { role: 2 } },
        ],
      ])("%s by the compound key", async (_label, args) => {
        await differential.reset();
        await differential.prisma.membership.create({
          data: { organizationId: 1, userId: 7, role: 0 },
        });

        await differential.expectSameWrite(
          "Membership",
          _label.startsWith("upsert") ? "upsert" : (_label as string),
          args,
          { tables: ["Membership"] },
        );
      });
    });

    /**
     * `skipDuplicates` — Postgres only, and that is Prisma's line rather than
     * SQL's: SQLite can express `on conflict do nothing`, and Prisma rejects
     * the *argument* there for `false` as well as `true`. So these are guarded
     * rather than listed in `CASES`, and the SQLite refusal is asserted in
     * `write.test.ts` where it needs no database.
     */
    describe("skipDuplicates", () => {
      test("skips the rows that exist and counts only the new ones", async () => {
        if (!url) return;

        await differential.expectSameWrite(
          "User",
          "createMany",
          {
            // `p1` is seeded, so it conflicts on `publicId`; the other two are
            // new. A count of 3 would mean the conflict clause did nothing, and
            // a count of 0 would mean the whole statement was skipped.
            data: [
              { publicId: "p1", email: "dup@example.dev" },
              { publicId: "new-1", email: "new1@example.dev" },
              { publicId: "new-2", email: "new2@example.dev" },
            ],
            skipDuplicates: true,
          },
          { tables: ["User"] },
        );
      });

      test("without it, the same batch raises", async () => {
        if (!url) return;
        await differential.reset();

        await expect(
          UserModel.createMany({
            data: [
              { publicId: "p1", email: "dup@example.dev" },
              { publicId: "new-3", email: "new3@example.dev" },
            ],
          }),
        ).rejects.toThrow();
      });

      /**
       * A conflict against a row **this same statement is inserting**, rather
       * than one already committed — which is a different thing for
       * `on conflict do nothing` to resolve, and the shape a caller hits when
       * their input list is simply not deduplicated.
       *
       * Measured before it was pinned: `values ('x','1'),('x','1'),('y','2')
       * on conflict do nothing` inserts two rows, not three and not one.
       */
      test("two identical rows in one call insert once", async () => {
        if (!url) return;

        await differential.expectSameWrite(
          "User",
          "createMany",
          {
            data: [
              { publicId: "dup-1", email: "dup1@example.dev" },
              { publicId: "dup-1", email: "dup2@example.dev" },
              { publicId: "dup-2", email: "dup3@example.dev" },
            ],
            skipDuplicates: true,
          },
          { tables: ["User"] },
        );
      });

      test("every row conflicting is a count of zero, not an error", async () => {
        if (!url) return;

        await differential.expectSameWrite(
          "User",
          "createMany",
          {
            data: [{ publicId: "p1", email: "a@example.dev" }],
            skipDuplicates: true,
          },
          { tables: ["User"] },
        );
      });

      test("false behaves as though it were absent", async () => {
        if (!url) return;

        await differential.expectSameWrite(
          "User",
          "createMany",
          {
            data: [{ publicId: "new-4", email: "new4@example.dev" }],
            skipDuplicates: false,
          },
          { tables: ["User"] },
        );
      });

      /**
       * A conflict on a **composite** unique, not only a single column.
       * `SocialAccount` carries `@@unique([username, provider])` and is the
       * only model in the template that can reach one.
       *
       * The untargeted `on conflict do nothing` is what makes this work: it
       * covers every constraint at once, where a targeted `on conflict (col)`
       * would skip collisions on the named column and still raise here.
       *
       * Self-contained — the two conflicting rows are in the *same* call, which
       * `do nothing` also deduplicates. Measured rather than assumed:
       * `values ('x','1'),('x','1'),('y','2') on conflict do nothing` inserts
       * two rows, not three and not one.
       */
      test("a conflict on a composite unique is skipped too", async () => {
        if (!url) return;

        const base = {
          userId: 1,
          accessToken: "t",
          refreshToken: "r",
          expiresAt: new Date(EPOCH),
        };

        await differential.expectSameWrite(
          "SocialAccount",
          "createMany",
          {
            data: [
              { ...base, provider: "github", providerId: "gh-1", username: "ada" },
              // Same (username, provider) as the row above, different
              // providerId — so only the composite constraint catches it.
              { ...base, provider: "github", providerId: "gh-2", username: "ada" },
              { ...base, provider: "gitlab", providerId: "gl-1", username: "ada" },
            ],
            skipDuplicates: true,
          },
          { tables: ["SocialAccount"] },
        );
      });

      /**
       * The interaction the issue calls out: `createMany` splits itself across
       * statements past the parameter ceiling, inside one transaction, and
       * `skipDuplicates` has to survive that split — the counts sum, and a
       * conflict in a later chunk must not roll back an earlier one, since
       * `do nothing` is not an error.
       *
       * Postgres binds 65 535 parameters and `User` writes 6 columns per row,
       * so ~11 000 rows is two statements. Not compared against Prisma: it
       * chunks differently, and what is under test is *our* split.
       */
      test("a batch that splits across statements returns the total", async () => {
        if (!url) return;
        await differential.reset();

        const rows = Array.from({ length: 11_000 }, (_, i) => ({
          publicId: `bulk-${i}`,
          email: `bulk-${i}@example.dev`,
        }));
        // One row in the *second* chunk collides with one in the first, so the
        // conflict lands after a chunk has already been written.
        rows[10_500] = { ...rows[0] };

        // **Succeeding at all is the proof that it split.** `User` binds 6
        // client-side columns per row, so this is 66 000 parameters against
        // Postgres's 65 535 ceiling: unsplit, `render` raises
        // `ParameterLimitError` rather than quietly running one statement.
        //
        // Asserted rather than left in prose, because the margin is thin — if
        // the row count, the column count or the ceiling ever moved, the case
        // would keep passing while silently no longer exercising the split.
        // (`differential.queries()` cannot see it: the chunks run on a
        // transaction handle, and the counting stand-in wraps the pool.)
        expect(rows.length * 6).toBeGreaterThan(65_535);

        const written = await UserModel.createMany({
          data: rows,
          skipDuplicates: true,
        });

        expect(written.count).toBe(10_999);

        const stored = await UserModel.count({
          where: { publicId: { startsWith: "bulk-" } },
        });
        expect(stored).toBe(10_999);
      }, 120_000);
    });

    test("create on a model with no @updatedAt", async () => {
      await differential.expectSameWrite(
        "Organization",
        "create",
        { data: { name: "No timestamps here" } },
        { tables: ["Organization"] },
      );
    });

    // --- nested writes --------------------------------------------------
    //
    // NOT ATOMIC in this iteration: each of these is more than one statement
    // with no transaction around it. Iteration 5 closes that at the `$exec`
    // choke point; the results are already correct, only the failure mode is
    // not. Recorded here as well as in the code so it is visible from the test.

    test("nested connect on the owning side sets the foreign key", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "connected@example.dev",
            organization: { connect: { id: 1 } },
          },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("nested connect by a non-referenced unique resolves first", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "connected2@example.dev",
            organization: { connect: { publicId: "o2" } },
          },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("nested create on the owning side writes the parent first", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "nested@example.dev",
            organization: { create: { name: "Created by nesting" } },
          },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("nested create on the foreign side writes the children after", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "parent@example.dev",
            accounts: { create: [{ organizationRole: 1 }, { organizationRole: 2 }] },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested create on the foreign side, read back through include", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "parent2@example.dev",
            accounts: { create: { organizationRole: 1 } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * A `_count` beside the `include` that produced the children.
     *
     * The count is a correlated subquery inside the write's own `RETURNING`, so
     * it is evaluated before any `after` step has run — while `include` is
     * attached after them. Unfixed, the two keys describe the same relation on
     * the same row and disagree:
     *
     *     accounts.length  2
     *     _count           { accounts: 0 }
     *
     * Asserting both in one comparison is the point: a test that checked only
     * `_count` would pass against a version that also lost the children, and one
     * that checked only `accounts` never saw the bug at all.
     */
    test("a _count beside a nested create counts what the steps wrote", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "counted-nested@example.dev",
            accounts: {
              create: [{ organizationRole: 1 }, { organizationRole: 2 }],
            },
          },
          include: {
            accounts: true,
            _count: { select: { accounts: true } },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    /** The same, through `select`, where `_count` is the only key asked for. */
    test("a _count in a select sees the nested create too", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "counted-select@example.dev",
            accounts: { create: { organizationRole: 1 } },
          },
          select: { email: true, _count: { select: { accounts: true } } },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * `createMany` — the shape #65 calls the biggest single item: parent and
     * children in one call, and one statement for the children rather than one
     * per row.
     */
    test("nested createMany writes every child in one statement", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many@example.dev",
            accounts: {
              createMany: {
                data: [
                  { organizationRole: 0 },
                  { organizationRole: 1 },
                  { organizationRole: 2 },
                ],
              },
            },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany, read back through include", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many2@example.dev",
            accounts: { createMany: { data: [{ organizationRole: 1 }] } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    // Prisma accepts a bare object where the rows go, not only an array.
    test("nested createMany accepts a single object as its data", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many3@example.dev",
            accounts: { createMany: { data: { organizationRole: 1 } } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    // Verified against Prisma: an empty list writes nothing and does not error,
    // and the parent still comes back with `accounts: []`.
    /**
     * `connectOrCreate` — and the case that decides whether it is implemented
     * or merely spelled: **a hit must ignore `create` entirely.** The seeded
     * organisation is named "Acme"; the payload below names something else, and
     * the row has to come back unchanged. An implementation that upserted would
     * pass a test that only checked "one organisation exists".
     */
    test("connectOrCreate on the owning side connects, leaving the row alone", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "coc1@example.dev",
            organization: {
              connectOrCreate: {
                where: { publicId: "o1" },
                create: { publicId: "o1", name: "SHOULD-NOT-APPEAR" },
              },
            },
          },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("connectOrCreate on the owning side creates when it misses", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "coc2@example.dev",
            organization: {
              connectOrCreate: {
                where: { publicId: "brand-new" },
                create: { publicId: "brand-new", name: "Made" },
              },
            },
          },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    /**
     * On this side a hit **repoints** the existing child at the new parent,
     * which is what `connect` means here — so the assertion is on the `Account`
     * table, not only on what came back.
     */
    test("connectOrCreate on the foreign side repoints an existing child", async () => {
      await differential.reset();
      await differential.prisma.account.create({
        data: { publicId: "loose-coc", organizationRole: 1 },
      });

      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "coc3@example.dev",
            accounts: {
              connectOrCreate: {
                where: { publicId: "loose-coc" },
                create: { publicId: "loose-coc", organizationRole: 9 },
              },
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("connectOrCreate on the foreign side creates when it misses", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "coc4@example.dev",
            accounts: {
              connectOrCreate: {
                where: { publicId: "no-such-account" },
                create: { publicId: "no-such-account", organizationRole: 2 },
              },
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /** A list where one entry hits and the other does not — both branches, one call. */
    test("connectOrCreate takes a list, hitting and missing in one call", async () => {
      await differential.reset();
      await differential.prisma.account.create({
        data: { publicId: "mixed-hit", organizationRole: 1 },
      });

      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "coc5@example.dev",
            accounts: {
              connectOrCreate: [
                {
                  where: { publicId: "mixed-hit" },
                  create: { publicId: "mixed-hit", organizationRole: 9 },
                },
                {
                  where: { publicId: "mixed-miss" },
                  create: { publicId: "mixed-miss", organizationRole: 3 },
                },
              ],
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany with no rows writes the parent alone", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many4@example.dev",
            accounts: { createMany: { data: [] } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany alongside a create on the same relation", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many5@example.dev",
            accounts: {
              create: [{ organizationRole: 0 }],
              createMany: { data: [{ organizationRole: 1 }] },
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * The other pair on one relation, and the one whose order is *not*
     * observable: repointing an existing child and inserting new ones do not
     * interact, so both apply and the result is the same either way.
     *
     * Pinned anyway. The step order falls out of `Object.keys(node).sort()`,
     * which is sorted for plan-cache determinism rather than for this — so
     * "both happen" is a property worth holding rather than a coincidence
     * nobody would notice breaking.
     */
    test("nested createMany alongside a connect on the same relation", async () => {
      await differential.reset();

      // The connect target has to pre-exist, and the harness seeds no accounts
      // — so this is asserted directly rather than through `expectSameWrite`,
      // the same way the connect-repoints-a-child case beside it is. Prisma's
      // answer was measured separately: both apply, giving the loose account
      // and the new one.
      await differential.prisma.account.create({
        data: { publicId: "loose-1", organizationRole: 9 },
      });

      await UserModel.create({
        data: {
          email: "many7@example.dev",
          accounts: {
            connect: { publicId: "loose-1" },
            createMany: { data: [{ organizationRole: 1 }] },
          },
        },
      });

      const attached = await differential.prisma.account.findMany({
        where: { user: { email: "many7@example.dev" } },
        orderBy: { id: "asc" },
      });

      expect(attached.map((row) => row.organizationRole)).toEqual([9, 1]);
    });

    test("nested createMany under update", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { createMany: { data: [{ organizationRole: 1 }] } } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany with a select on the parent", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many6@example.dev",
            accounts: { createMany: { data: [{ organizationRole: 1 }] } },
          },
          select: { email: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * #65's third acceptance criterion: a failure anywhere in the tree rolls the
     * whole write back. Verified against Prisma's own behaviour — a duplicate
     * mid-array leaves *no* parent row either.
     *
     * Not `expectSameWrite`, because the two clients cannot both run a failing
     * write against one database and see the same state; this asserts the
     * rollback directly, which is the half that matters.
     */
    test("a child that violates a constraint rolls the parent back too", async () => {
      await differential.reset();

      await expect(
        UserModel.create({
          data: {
            email: "rollback@example.dev",
            accounts: {
              createMany: {
                data: [
                  { publicId: "keep-1", organizationRole: 0 },
                  // The same publicId twice: the second row of the same
                  // statement violates the unique index.
                  { publicId: "keep-1", organizationRole: 1 },
                ],
              },
            },
          },
        }),
      ).rejects.toThrow();

      const parent = await differential.prisma.user.findFirst({
        where: { email: "rollback@example.dev" },
      });
      expect(parent).toBeNull();

      const children = await differential.prisma.account.findMany({
        where: { publicId: "keep-1" },
      });
      expect(children).toHaveLength(0);
    });

    /**
     * `disconnect` and `delete` — the operands that act on rows already linked
     * to this one, and the pair that shows why the boundary is "which rows can
     * be named": both take a unique key, so the child's own operations decide
     * reachability.
     *
     * They differ on a row that is *not* linked, and the difference is Prisma's
     * rather than a choice — measured before implementing:
     *
     *     disconnect a row linked elsewhere  ->  succeeds, changes nothing
     *     delete     a row linked elsewhere  ->  raises "are not connected"
     *
     * The rows come from the seed, not from the test body: `expectSameWrite`
     * resets to the seeded state before each client runs, so a case that set
     * itself up would compare two runs against an empty table and pass whatever
     * the code did.
     */
    test("disconnect clears the link and leaves the row", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { disconnect: { publicId: "acc-mine-1" } } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("disconnect takes a list", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              disconnect: [
                { publicId: "acc-mine-1" },
                { publicId: "acc-mine-2" },
              ],
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * A row linked to a *different* user. Prisma succeeds and changes nothing —
     * and without the parent key in the `where`, this would clear somebody
     * else's foreign key and still return a plausible payload.
     */
    test("disconnecting a row that is not linked is a no-op", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { disconnect: { publicId: "acc-theirs" } } },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("delete removes the row, not just the link", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { delete: { publicId: "acc-mine-1" } } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * The asymmetry, and the case that decides whether this is implemented or
     * merely spelled: `delete` on a row belonging to a different parent
     * **raises** where `disconnect` shrugs. Without the parent key in the
     * `where` this deletes somebody else's row and reports success.
     */
    test("deleting a row that is not linked raises, as Prisma does", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { delete: { publicId: "acc-theirs" } } },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("disconnect on a to-one clears the foreign key", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { organization: { disconnect: true } },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    /**
     * `update` — caller columns, written to a row they named by unique key.
     *
     * The seeded accounts make the "not linked" case mean something: two
     * belong to user 1 and one to user 2, so an `update` naming the third has
     * to raise rather than reach across.
     */
    test("update writes the named child", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              update: {
                where: { publicId: "acc-mine-1" },
                data: { organizationRole: 9 },
              },
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("update takes a list", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              update: [
                { where: { publicId: "acc-mine-1" }, data: { organizationRole: 8 } },
                { where: { publicId: "acc-mine-2" }, data: { organizationRole: 7 } },
              ],
            },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("updating a row that is not linked raises, as Prisma does", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              update: {
                where: { publicId: "acc-theirs" },
                data: { organizationRole: 9 },
              },
            },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    /** Prisma accepts both spellings on a to-one; so does this. */
    test("update through a to-one, bare data", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { organization: { update: { name: "Renamed" } } },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("update through a to-one, wrapped in data", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { organization: { update: { data: { name: "Wrapped" } } } },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    /**
     * **The owning side honours its `where`**, which for a while it accepted and
     * ignored — writing the linked row whether or not the filter matched, while
     * the foreign side conjoined the same filter and raised. One spelling, two
     * answers, and the owning one was the silent wrong write.
     *
     * Both directions are pinned, because only the pair distinguishes "the
     * filter is applied" from "the filter is dropped": with the filter dropped
     * the matching case still passes.
     */
    test("a to-one update with a matching where writes", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            organization: {
              update: { where: { name: "Acme" }, data: { name: "Filtered" } },
            },
          },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("a to-one update whose where matches nothing raises rather than writing", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            organization: {
              update: {
                where: { name: "NotTheOrganisation" },
                data: { name: "MustNotLand" },
              },
            },
          },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    /**
     * `data: undefined` — the ordinary spelling of a conditional write, and the
     * reason `suppliedFields` skips `undefined` everywhere else.
     *
     * `canonicalShape` drops an `undefined`-valued key, so this and `update: {}`
     * are one plan entry; the owning side used to branch on the key's
     * *presence*, pass `data: undefined` down to `updateMany`, and answer a
     * no-op call with `updateMany requires 'data'`. Both sides now read the
     * value, which is what Prisma does — it treats an explicit `undefined` as
     * absent.
     */
    test("a to-one update with data: undefined is a no-op, on both sides", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { organization: { update: { data: undefined } } },
          include: { organization: true },
        },
        { tables: ["User", "Organization"] },
      );
    });

    /**
     * The owning-side miss — the case that was missing, and the reason its
     * twin's fix did not carry over.
     *
     * The third seeded user has no organisation, so the foreign key is null and
     * there is nothing to update. Prisma answers P2025 (`notFound`); the
     * harness compares the failure *kind*, so an `UnsupportedQueryError` here
     * reads as `other` and disagrees. The connected to-one cases above never
     * touch this branch.
     */
    test("updating a to-one that is not there raises, as Prisma does", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { publicId: "p3" },
          data: { organization: { update: { name: "Nowhere" } } },
        },
        { tables: ["User", "Organization"] },
      );
    });

    /**
     * `set` — replace the whole set. The one supported operand that acts on
     * rows the *call* did not name, which #83 showed how to scope: read the
     * linked rows through the child's own `findMany` and clear only those.
     *
     * Four cases, and three of them are behaviours the name does not suggest —
     * measured against Prisma before implementing.
     */
    test("set keeps the named row and detaches the rest", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { set: [{ publicId: "acc-mine-1" }] } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("set to empty detaches every linked row", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { set: [] } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /** It repoints a row belonging to somebody else, exactly as `connect` does. */
    test("set takes a row from another parent", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { set: [{ publicId: "acc-theirs" }] } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * And a named row that does not exist is **silently ignored** — no error,
     * which is why the connect half is an `updateMany` rather than the `update`
     * a nested `connect` uses.
     */
    test("set ignores a named row that does not exist", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { set: [{ publicId: "no-such-account" }] } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * `updateMany` and `deleteMany` — a filter, applied to **this parent's**
     * rows. The seeded `acc-theirs` belongs to another user and must survive
     * both, which is what the parent-key filter is for.
     *
     * Their operands are shaped differently and it is easy to get backwards:
     * `updateMany` wraps its filter in `where`, `deleteMany` *is* the filter.
     */
    test("updateMany writes this parent's matching rows", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              updateMany: {
                where: { organizationRole: 1 },
                data: { organizationRole: 9 },
              },
            },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("updateMany with an empty where takes every row of this parent", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: { updateMany: { where: {}, data: { organizationRole: 8 } } },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("deleteMany takes the filter directly", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { deleteMany: { organizationRole: 1 } } },
        },
        { tables: ["User", "Account"] },
      );
    });

    /** The one that would empty the table without the parent-key filter. */
    test("deleteMany with an empty filter stops at this parent", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { deleteMany: {} } },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * The case the parent restriction has to survive: a caller filter that
     * names the **foreign key column itself**, pointing at a different parent.
     *
     * Merging by key let the restriction overwrite it, so "this parent's
     * children belonging to user 2" — which is nothing — became "all of this
     * parent's children". Prisma conjoins and deletes nothing; measured before
     * fixing, because the question is what it does rather than what is tidy.
     */
    test("deleteMany with a filter on the foreign key deletes nothing", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { deleteMany: { userId: 2 } } },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("updateMany with a filter on the foreign key writes nothing", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              updateMany: { where: { userId: 2 }, data: { organizationRole: 7 } },
            },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * `upsert` — the lookup decides the branch, and it looks only among **this
     * parent's** rows. The third case is the one that shows the difference:
     * `acc-theirs` exists globally but not here, so Prisma takes the *create*
     * branch and collides on the unique key rather than updating somebody
     * else's row.
     */
    test("upsert updates the row when it is this parent's", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              upsert: {
                where: { publicId: "acc-mine-1" },
                create: { publicId: "acc-mine-1", organizationRole: 5 },
                update: { organizationRole: 9 },
              },
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("upsert creates when there is no such row", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              upsert: {
                where: { publicId: "brand-new" },
                create: { publicId: "brand-new", organizationRole: 3 },
                update: { organizationRole: 9 },
              },
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("upsert on another parent's row collides rather than updating it", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: {
            accounts: {
              upsert: {
                where: { publicId: "acc-theirs" },
                create: { publicId: "acc-theirs", organizationRole: 4 },
                update: { organizationRole: 7 },
              },
            },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested connect on the foreign side repoints the child", async () => {
      await differential.reset();
      await differential.prisma.account.create({
        data: { publicId: "loose", organizationRole: 2 },
      });

      const account = await differential.prisma.account.findFirstOrThrow({
        where: { publicId: "loose" },
      });
      expect(account.userId).toBeNull();

      await UserModel.update({
        where: { id: 1 },
        data: { accounts: { connect: { publicId: "loose" } } },
      });

      const after = await differential.prisma.account.findFirstOrThrow({
        where: { publicId: "loose" },
      });
      expect(after.userId).toBe(1);
    });

    test("a select that omits the stitch key does not leak it", async () => {
      await differential.reset();
      const created = await UserModel.create({
        data: {
          email: "hidden@example.dev",
          accounts: { create: { organizationRole: 1 } },
        },
        select: { email: true },
      });
      expect(Object.keys(created)).toEqual(["email"]);
    });

    /**
     * The same relation, written from the **child** — the owning side of the
     * very to-one the `M…` cases above write from the parent.
     *
     * `write.test.ts` has a describe titled "a to-one answers the same on both
     * sides", and an unasserted symmetry claim in a suite with that title is
     * how #116 happened. It asserts the claim against the *compiler*; these
     * assert it against a real client, which is the half that can tell a
     * matching pair of statements from a matching pair of answers.
     */
    describe("the same to-one, written from the owning side", () => {
      test("update reaches the parent through the child's relation", async () => {
        await differential.expectSameWrite(
          "Profile",
          "update",
          {
            where: { id: 1 },
            data: { user: { update: { name: "From the child" } } },
          },
          { tables: ["User", "Profile"] },
        );
      });

      /**
       * The owning side of the same operand as M8b, and the reason
       * `Profile.userId` is nullable on purpose: Prisma omits `disconnect` from
       * the input type entirely when the foreign key is required, so a required
       * one would leave this unreachable rather than refused.
       */
      test("disconnect clears this row's own foreign key", async () => {
        await differential.expectSameWrite(
          "Profile",
          "update",
          { where: { id: 1 }, data: { user: { disconnect: true } } },
          { tables: ["User", "Profile"] },
        );
      });

      /**
       * **#363, on the arrangement `OWNING_CASES` cannot express: both rows
       * already linked.**
       *
       * This test *was* the pin in the "still disagree" describe, and it is
       * rewritten rather than deleted. Its Prisma half is unchanged and was
       * always the measurement; only gemi's half moved, from
       * `UniqueConstraintError` with nothing written to the same three-row
       * answer. Keeping it is what makes "the divergence closed" a thing the
       * suite says rather than a thing a diff implies, and the shape is not a
       * duplicate of `O12`: there both the mover (`loose`) and its destination
       * are what the seed happens to hold, so the row being written starts
       * *unlinked*. Here it starts linked to somebody else, which is the only
       * arrangement in which one call detaches two rows — the incumbent, and
       * the far row this one is leaving.
       *
       * It stays out of `OWNING_CASES` for the mechanical reason it always
       * did: `expectSameWrite` resets to the seeded state before each client
       * runs, so a table-driven case has nowhere to put the `occupy()` below.
       * That is a property of the harness, not of the divergence, and it is why
       * #363's acceptance is satisfied by `O12` rather than by this.
       */
      test("connect into an occupied to-one displaces the incumbent on both", async () => {
        const args = { where: { id: 1 }, data: { user: { connect: { id: 2 } } } };
        const occupy = () =>
          differential.prisma.profile.update({
            where: { id: 2 },
            data: { userId: 2 },
          });
        const profiles = async () =>
          (
            await differential.prisma.profile.findMany({ orderBy: { id: "asc" } })
          ).map((row) => [row.bio, row.userId]);

        await differential.reset();
        await occupy();
        await differential.prisma.profile.update(args as never);
        expect(await profiles()).toEqual([
          ["seed", 2],
          // Detached, not deleted — the half a fix here had to get right.
          ["loose", null],
        ]);

        await differential.reset();
        await occupy();
        const fromGemi: any = await ProfileModel.update(args as never);
        expect(fromGemi.userId).toBe(2);
        expect(await profiles()).toEqual([
          ["seed", 2],
          ["loose", null],
        ]);
      });

    });

    /**
     * M11 — `disconnect` on a **required** foreign key, which is the case that
     * keeps `assertDisconnectable` as it is.
     *
     * Prisma does not refuse a value here; it does not have the key at all.
     * `PasswordResetTokenUpdateInput`'s `user` operand lists only
     * create / connectOrCreate / upsert / connect / update, and the error is
     * "Unknown argument `disconnect`. Did you mean `connect`?". So `false` is
     * refused exactly as `true` is — the refusal is on the **key**, not on the
     * value, which is why it has to fire ahead of any boolean normalisation.
     * That is the assertion below that is easy to lose.
     *
     * Not in the seed and not through `expectSameWrite`: a `PasswordResetToken`
     * row would make `deleteMany empty where` — which deletes every user — fail
     * a foreign key on both clients, silently turning an existing case from a
     * successful delete into a mutual error. The row is written here instead,
     * after the reset that the case needs anyway.
     */
    test("M11 disconnect on a required foreign key is refused by both", async () => {
      await differential.reset();
      await differential.prisma.passwordResetToken.create({
        data: { token: "reset-1", userId: 1 },
      });

      for (const operand of [true, false]) {
        const args = { where: { token: "reset-1" }, data: { user: { disconnect: operand } } };

        await expect(
          differential.prisma.passwordResetToken.update(args as never),
        ).rejects.toThrow(/Unknown argument `disconnect`/);

        await expect(
          PasswordResetTokenModel.update(args as never),
        ).rejects.toThrow();
      }

      // Neither client got as far as the database.
      const row = await differential.prisma.passwordResetToken.findFirstOrThrow({
        where: { token: "reset-1" },
      });
      expect(row.userId).toBe(1);
    });

    /**
     * #355 — an `update` whose `data` sets no column.
     *
     * Every case here uses a model with **no `@updatedAt`**, and that is not a
     * detail: `updateAssignments` stamps one unconditionally, so on `User` there
     * is always an assignment and this branch is unreachable. A version of these
     * written against `User` would pass without ever running the code they are
     * for.
     *
     * `Post` has neither timestamp; `Organization` has none either and has two
     * seeded rows, which is what M13 needs.
     */
    describe("an empty data", () => {
      // M12 — it is a **read**. Prisma returns the row, unchanged, rather than
      // refusing or emitting an `UPDATE` with nothing to set.
      test("M12 update with an empty data returns the row", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          { where: { id: 1 }, data: {} },
          { tables: ["Post"] },
        );
      });

      // M12b — and it is a read through the *same* projection machinery: the
      // `include` is honoured in full, which a bare row fetch would drop.
      test("M12b the include is honoured", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          {
            where: { id: 1 },
            data: {},
            include: { tags: { orderBy: { id: "asc" } } },
          },
          { tables: ["Post", "Tag"] },
        );
      });

      // M12c — a miss still raises P2025, so `update` staying in `ORTHROW` is
      // both required and sufficient. `notFound` on both sides.
      test("M12c a miss still raises", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          { where: { id: 99999 }, data: {} },
          { tables: ["Post"] },
        );
      });

      // M12d — `select` narrows it exactly as it narrows a normal update.
      test("M12d select narrows the read", async () => {
        await differential.expectSameWrite(
          "Post",
          "update",
          { where: { id: 1 }, data: {}, select: { title: true } },
          { tables: ["Post"] },
        );
      });

      /**
       * M13 — the half that decided whether #355 implements or documents.
       *
       * `updateMany` answers `{ count: 0 }`, and the count is a **constant**
       * rather than a row count: "Acme" matches one of the two seeded
       * organisations and the answer is still 0. That is what makes it cheap to
       * match — skip the statement, return the constant, never evaluate the
       * filter — and it is surprising enough that it has to be pinned rather
       * than remembered.
       */
      test("M13 updateMany counts zero even when rows match", async () => {
        await differential.expectSameWrite(
          "Organization",
          "updateMany",
          { where: { name: "Acme" }, data: {} },
          { tables: ["Organization"] },
        );
      });

      test("M13b a filter that matches nothing is indistinguishable", async () => {
        await differential.expectSameWrite(
          "Organization",
          "updateMany",
          { where: { name: "no such organisation" }, data: {} },
          { tables: ["Organization"] },
        );
      });

      test("M13c and no filter at all is still zero", async () => {
        await differential.expectSameWrite(
          "Organization",
          "updateMany",
          { data: {} },
          { tables: ["Organization"] },
        );
      });
    });

    /**
     * **The `@updatedAt` stamp follows the column, and both clients agree.**
     *
     * These two were bugs 1 and 2 in the describe below — gemi stamped where
     * Prisma did not — and they are kept here, by value, rather than graduated
     * into `CASES`, because `CASES` cannot see them: `updatedAt` is in
     * `VOLATILE`, so `expectSameWrite` compares both sides as the descriptor
     * `"date"` and two different instants match. That blindness is why the
     * divergence survived the first pass; asserting the epoch by hand is what
     * caught it and is what keeps it caught.
     *
     * The rule both clients follow: a statement that sets at least one column
     * stamps, one that sets none does not. Measured on rows whose `updatedAt`
     * was seeded to the epoch, so this is the stamp and not two clocks.
     */
    describe("the @updatedAt stamp follows the column, as Prisma's does", () => {
      test("update with an empty data leaves the stamp alone on both", async () => {
        const args = { where: { id: 1 }, data: {} };

        await differential.reset();
        const fromPrisma: any = await differential.prisma.user.update(args);

        await differential.reset();
        const fromGemi: any = await UserModel.update(args);
        const storedByGemi = await differential.prisma.user.findFirstOrThrow({
          where: { id: 1 },
        });

        expect(fromPrisma.updatedAt.getTime()).toBe(EPOCH);
        expect(fromGemi.updatedAt.getTime()).toBe(EPOCH);
        // And nothing was written, not merely nothing returned.
        expect(storedByGemi.updatedAt.getTime()).toBe(EPOCH);
      });

      test("updateMany with an empty data counts zero and writes nothing on both", async () => {
        const args = { where: { globalRole: { gte: 0 } }, data: {} };
        const seeded = [EPOCH, EPOCH + 1000, EPOCH + 2000];

        await differential.reset();
        const fromPrisma = await differential.prisma.user.updateMany(args);
        const afterPrisma = await differential.prisma.user.findMany({
          orderBy: { id: "asc" },
        });

        await differential.reset();
        const fromGemi = await UserModel.updateMany(args);
        const afterGemi = await differential.prisma.user.findMany({
          orderBy: { id: "asc" },
        });

        expect(fromPrisma).toEqual({ count: 0 });
        expect(fromGemi).toEqual({ count: 0 });
        expect(afterPrisma.map((row) => row.updatedAt.getTime())).toEqual(seeded);
        expect(afterGemi.map((row) => row.updatedAt.getTime())).toEqual(seeded);
      });

      /**
       * The half that keeps the fix from being read as "never stamp", and the
       * one a regression would most likely break: a real column brings it back.
       */
      test("a supplied column still stamps on both", async () => {
        const args = { where: { id: 1 }, data: { name: "written" } };

        await differential.reset();
        const fromPrisma: any = await differential.prisma.user.update(args);

        await differential.reset();
        const fromGemi: any = await UserModel.update(args);

        expect(fromPrisma.updatedAt.getTime()).toBeGreaterThan(EPOCH);
        expect(fromGemi.updatedAt.getTime()).toBeGreaterThan(EPOCH);
      });

      /**
       * The shape #354 ships, and the reason this describe is not only about
       * #355: a nested write whose child holds the foreign key sets no column
       * of *this* row, so it must not stamp either. Measured — Prisma leaves it
       * at the epoch for a nested `create`, `update` and `upsert` alike.
       */
      test("a relation-only nested write leaves the stamp alone on both", async () => {
        const args = {
          where: { id: 2 },
          data: { profile: { create: { bio: "nested" } } },
        };

        await differential.reset();
        const fromPrisma: any = await differential.prisma.user.update(args as never);

        await differential.reset();
        const fromGemi: any = await UserModel.update(args as never);
        const storedByGemi = await differential.prisma.user.findFirstOrThrow({
          where: { id: 2 },
        });

        expect(fromPrisma.updatedAt.getTime()).toBe(EPOCH + 1000);
        expect(fromGemi.updatedAt.getTime()).toBe(EPOCH + 1000);
        expect(storedByGemi.updatedAt.getTime()).toBe(EPOCH + 1000);
        // The child still landed — the parent reading rather than writing must
        // not cost the nested step.
        expect(
          await differential.prisma.profile.findFirst({ where: { userId: 2 } }),
        ).toMatchObject({ bio: "nested" });
      });
    });

    /**
     * Where gemi and Prisma **still disagree**. Every one of these is a bug,
     * found by running the measurements above through both clients, and none of
     * them is a decision anybody made.
     *
     * They are not in `CASES`, because `expectSameWrite` asserts agreement: a
     * case put there to disagree is a red suite carrying no information. Each
     * one instead pins **both** answers — Prisma's *and* gemi's — so the day
     * either side moves, this fails and says which one moved. That is the only
     * form in which a known divergence is worth committing; a `test.skip` would
     * record nothing and a comment would record it where nothing checks it.
     *
     * Fixing any of them is a compiler change, in files this suite does not own.
     * Deleting the case is what closing the bug looks like: it graduates into
     * `CASES` and the harness takes over from the prose.
     *
     * Each carries its issue number, and that is the half a test cannot do for
     * itself. The three this describe has held — #359, #360 and #363 — are all
     * gone from it and into `CASES` / `OWNING_CASES` above, which is what
     * closing one looks like. #363's went last, and where it went is worth
     * knowing: `O12` is the same collision spelled from the other end, so the
     * seeded state expresses it and no arrangement is needed; the arranged
     * shape it used to pin survives as a positive test beside the other
     * owning-side to-one cases.
     *
     * **What is left is not gemi's bug**, which changes what the describe is
     * for. The rule stays "pin both answers"; what it cannot stay is "every one
     * of these is ours to fix" — the entry below is a divergence this ORM
     * declines to reproduce, and the file has been down to one before.
     */
    describe("where the two clients still disagree", () => {
      /**
       * **A deliberate divergence, and the only one in this file: Prisma's
       * owning-side `disconnect` ignores its operand on a many-to-one.**
       *
       * `OWNING_CASES` above pins the whole grammar against `Profile.user` — a
       * one-to-one — where Prisma honours it: `false` and a non-matching filter
       * both leave the link alone. The *same operand type* on a many-to-one is
       * answered differently by the engine, measured on three relations
       * (`User.organization`, `Account.user`, `Account.organization`):
       *
       *     disconnect: false               ->  the foreign key is nulled
       *     disconnect: { name: "Nobody" }  ->  the foreign key is nulled
       *
       * The generated input type is identical on both — `XWhereInput | boolean`
       * — so this is the engine dropping the value, not a narrower grammar.
       * `delete: false` on the same relation is a correct no-op, which is what
       * rules out "booleans are ignored here" as the explanation. Logging the
       * engine's own SQL shows the drop directly, quoting normalised: the
       * lookup it issues for the operand is
       * `select id from Organization where (1=1 and id in (?))` — the caller's
       * `name = 'Nobody'` is simply not in it — and the `update` that follows
       * carries `and 1=1` where the *one-to-one*'s carries an `exists`
       * subquery over the filter. So the operand is discarded before a
       * statement is built, rather than evaluated and found to match.
       *
       * **gemi does not reproduce it.** Matching Prisma is this suite's whole
       * point and it is overruled exactly here, because the behaviour to match
       * is a silent destructive write on the call that asked for nothing —
       * which is, word for word, the defect #358 removed from this ORM's own
       * plan cache. Reproducing it deliberately would be re-introducing it. So
       * gemi answers one grammar one way on both shapes, and this pins the
       * difference rather than hiding it.
       *
       * **Both halves the docs claim, not just the boolean.** `docs/orm.md`
       * says Prisma ignores `disconnect: false` *and* a filter matching
       * nothing; a pin that asserted only the first would let the second move
       * without a word, which is exactly the gap a pin is for.
       */
      test.each([
        ["disconnect: false", false],
        ["a filter matching nothing", { name: "Nobody" }],
      ])(
        "Prisma ignores a many-to-one disconnect operand where gemi honours it: %s",
        async (_label, operand) => {
          const args = {
            where: { id: 1 },
            data: { organization: { disconnect: operand } },
          };

          await differential.reset();
          const fromPrisma = await differential.prisma.user.update(args as never);
          // Prisma detached anyway. User 1 is seeded into Acme.
          expect(fromPrisma.organizationId).toBe(null);

          await differential.reset();
          const fromGemi: any = await UserModel.update(args as never);
          expect(fromGemi.organizationId).toBe(1);
          expect(
            await differential.prisma.user.findFirstOrThrow({ where: { id: 1 } }),
          ).toMatchObject({ organizationId: 1 });
        },
      );

      /**
       * The control that keeps the case above about the *operand* rather than
       * about many-to-one `disconnect` in general: a filter that **does** match
       * nulls the key on both clients. Without it, "Prisma ignores the operand"
       * and "gemi never detaches on a many-to-one" produce the same green test.
       *
       * In `CASES` it would have to be `Organization`-scoped to read the table
       * back, and it belongs beside its sibling, so it is asserted here.
       */
      test("a matching many-to-one disconnect filter nulls the key on both", async () => {
        const args = {
          where: { id: 1 },
          data: { organization: { disconnect: { name: "Acme" } } },
        };

        await differential.reset();
        const fromPrisma = await differential.prisma.user.update(args as never);
        expect(fromPrisma.organizationId).toBe(null);

        await differential.reset();
        const fromGemi: any = await UserModel.update(args as never);
        expect(fromGemi.organizationId).toBe(null);
        expect(
          await differential.prisma.user.findFirstOrThrow({ where: { id: 1 } }),
        ).toMatchObject({ organizationId: null });
      });

    });

    // --- typed errors ---------------------------------------------------

    test("a unique violation is typed, catchable, and names the field", async () => {
      await differential.reset();
      await expect(
        UserModel.create({ data: { email: "ada@example.dev" } }),
      ).rejects.toThrow(UniqueConstraintError);

      try {
        await UserModel.create({ data: { email: "ada@example.dev" } });
        expect.unreachable("expected a unique violation");
      } catch (error) {
        expect(error).toBeInstanceOf(UniqueConstraintError);
        // Field names, the way Prisma's `meta.target` reports them — not the
        // database's column names, which the caller has never seen.
        expect((error as UniqueConstraintError).fields).toEqual(["email"]);
        expect((error as UniqueConstraintError).model).toBe("User");
      }
    });

    test("a composite unique violation names every field", async () => {
      await differential.reset();
      const base = {
        userId: 1,
        provider: "github",
        providerId: "gh-1",
        username: "ada",
        accessToken: "t",
        refreshToken: "r",
        expiresAt: new Date(EPOCH),
      };
      await SocialAccountModel.create({ data: base });

      try {
        await SocialAccountModel.create({
          data: { ...base, providerId: "gh-2" },
        });
        expect.unreachable("expected a unique violation");
      } catch (error) {
        expect(error).toBeInstanceOf(UniqueConstraintError);
        expect((error as UniqueConstraintError).fields.sort()).toEqual([
          "provider",
          "username",
        ]);
      }
    });

    // A NOT NULL failure travels the same driver path as a unique one — same
    // exception type on SQLite, same SQLSTATE class on Postgres — and must not
    // be reported as a duplicate key.
    test("a not-null violation is not reported as a unique violation", async () => {
      await differential.reset();
      await expect(
        // `publicId` is NOT NULL in the DDL. Supplied explicitly, so the
        // compiler passes it through and the database is what rejects it.
        UserModel.create({ data: { email: "nn@example.dev", publicId: null } }),
      ).rejects.not.toBeInstanceOf(UniqueConstraintError);
    });

    /**
     * Used to be refused; now runs as a read and a write inside one
     * transaction, which is what Prisma means by it. The differential cases
     * above compare the *result*; this one pins the part they cannot see —
     * that the row is created rather than the call raising, and that the
     * `where`'s key is not what lands in it.
     */
    test("upsert whose create omits the conflict key creates a row", async () => {
      await differential.reset();

      const before = await UserModel.count({});
      const created: any = await UserModel.upsert({
        where: { id: 987_654 },
        create: { email: "omitted@example.dev" },
        update: { name: "N" },
      });

      expect(await UserModel.count({})).toBe(before + 1);
      // The `where` selects; it does not contribute to the insert. Prisma does
      // the same, which the matrix above is what actually establishes.
      expect(created.id).not.toBe(987_654);
      expect(created.email).toBe("omitted@example.dev");
    });

    /** And the other branch: a hit updates rather than inserting. */
    test("upsert whose create omits the key updates when the row exists", async () => {
      await differential.reset();

      const ada: any = await UserModel.findFirstOrThrow({
        where: { email: "ada@example.dev" },
      });
      const before = await UserModel.count({});

      const updated: any = await UserModel.upsert({
        where: { publicId: ada.publicId },
        create: { email: "unused@example.dev" },
        update: { name: "Renamed" },
      });

      expect(await UserModel.count({})).toBe(before);
      expect(updated.id).toBe(ada.id);
      expect(updated.name).toBe("Renamed");
    });

    /**
     * Still refused, and deliberately. Prisma ignores the `where` and inserts
     * the `create`'s value; a caller who wrote two different keys in one call
     * almost certainly meant one of them, and a loud error beats silently
     * picking the second. Unlike the omitted-key case, nothing about iteration 5
     * changes this — it is a divergence we are choosing.
     */
    test("upsert whose create disagrees with the where key is refused", async () => {
      await differential.reset();
      await expect(
        UserModel.upsert({
          where: { email: "ada@example.dev" },
          create: { email: "different@example.dev" },
          update: { name: "N" },
        }),
      ).rejects.toThrow(/must agree on the key/);
    });

    // --- the plan cache -------------------------------------------------

    test("a create is one plan whatever the values are", async () => {
      await differential.reset();
      const { clearPlanCache, planCacheStats } = await import("gemi/orm");

      clearPlanCache();
      await UserModel.create({ data: { email: "c1@example.dev" } });
      await UserModel.create({ data: { email: "c2@example.dev" } });
      await UserModel.create({ data: { email: "c3@example.dev" } });
      expect(planCacheStats().compiles).toBe(1);
      expect(planCacheStats().hits).toBe(2);

      // A different field set is a different statement, so it must not reuse it.
      await UserModel.create({ data: { email: "c4@example.dev", name: "N" } });
      expect(planCacheStats().compiles).toBe(2);
    });

    // The harness itself: if `expectSameWrite` compared nothing, every case
    // above would pass vacuously.
    test("the harness actually catches a divergent write", async () => {
      await differential.reset();
      const before = await differential.prisma.user.count();
      await UserModel.create({ data: { email: "guard@example.dev" } });
      expect(await differential.prisma.user.count()).toBe(before + 1);
    });
  });
}

suite("writes vs prisma — sqlite");

if (POSTGRES_URL) {
  suite("writes vs prisma — postgres", POSTGRES_URL);
} else {
  describe("writes vs prisma — postgres", () => {
    // Deliberately loud rather than `test.skip`: a silently skipped dialect
    // reads as a passing one in CI output.
    test("SKIPPED — set TEST_POSTGRES_URL to run the Postgres dialect", () => {
      console.warn(
        "\n  ⚠  Postgres write differential tests did NOT run.\n" +
          "     Set TEST_POSTGRES_URL to a scratch database to cover the " +
          "postgres dialect.\n",
      );
      expect(POSTGRES_URL).toBeUndefined();
    });
  });
}

/**
 * The harness's own relation-order stabilisation, tested directly because the
 * thing it fixes cannot be reproduced on demand.
 *
 * `expectSameWrite` compares what the call returned, and an `include` is
 * unordered in *both* clients — measured, by logging what Prisma 6.19.2 sends:
 * `SELECT … FROM "public"."Account" WHERE … IN ($1) OFFSET $2`, with no
 * `ORDER BY`. On Postgres an `UPDATE` relocates the row within the heap, so the
 * child that was written comes back last, or first again once the page has been
 * pruned. The two clients run one after the other and meet the heap in
 * different states, so the same passing case fails perhaps one run in three —
 * always as a plausible-looking divergence in which every field of every row is
 * identical and only the array order differs.
 *
 * That is unreproducible by construction, which is why the guard is asserted
 * here rather than left to the Postgres run to notice. Deleting the sort in
 * `differential.ts` fails the first two cases below.
 *
 * Dialect-independent — it is a pure function — so it sits outside `suite`.
 */
describe("the harness compares relations as a set, not in storage order", () => {
  const registry = { User: UserModel, Account: AccountModel } as any;

  test("a relation array is reordered and a Json column is not", () => {
    const out: any = stabilizeRelations(
      {
        id: 1,
        // A `Json` column whose value *is* the order. The reason the walk is
        // guided by the schema instead of sorting every array of objects.
        metadata: [{ z: 1 }, { a: 2 }],
        accounts: [
          { id: 4, organizationRole: 2 },
          { id: 3, organizationRole: 9 },
        ],
      },
      "User",
      registry,
    );

    expect(out.accounts.map((account: any) => account.id)).toEqual([3, 4]);
    expect(out.metadata).toEqual([{ z: 1 }, { a: 2 }]);
  });

  test("the two orders a write can return collapse to one value", () => {
    expect(
      stabilizeRelations({ accounts: [{ id: 4 }, { id: 3 }] }, "User", registry),
    ).toEqual(
      stabilizeRelations({ accounts: [{ id: 3 }, { id: 4 }] }, "User", registry),
    );
  });

  // The half that keeps the case above from being a way to pass anything: it is
  // a multiset comparison, so a different *set* of children still fails.
  test("a genuinely different set of children still differs", () => {
    expect(
      stabilizeRelations({ accounts: [{ id: 4 }, { id: 3 }] }, "User", registry),
    ).not.toEqual(
      stabilizeRelations({ accounts: [{ id: 4 }, { id: 5 }] }, "User", registry),
    );
  });

  /**
   * **An include that named an `orderBy` keeps its order.**
   *
   * Without this the relaxation would reach past the flake it was for: the
   * flake is a property of an *unordered* include, where neither client emits
   * an `ORDER BY` and the heap decides. When the caller asked for a sort, the
   * order is the answer — so a relation strategy that stopped honouring a
   * nested `orderBy` has to still fail here, and several existing cases in this
   * file pass exactly that argument.
   */
  test("a node that asked for an orderBy is compared positionally", () => {
    const ordered = { include: { accounts: { orderBy: { id: "asc" } } } };

    expect(
      stabilizeRelations(
        { accounts: [{ id: 4 }, { id: 3 }] },
        "User",
        registry,
        ordered,
      ),
    ).not.toEqual(
      stabilizeRelations(
        { accounts: [{ id: 3 }, { id: 4 }] },
        "User",
        registry,
        ordered,
      ),
    );
  });

  // ...and the exception is the `orderBy`, not the presence of a selection: an
  // include with no sort is still the unordered case the sort exists for.
  test("an include with no orderBy is still sorted", () => {
    const plain = { include: { accounts: true } };

    expect(
      stabilizeRelations({ accounts: [{ id: 4 }, { id: 3 }] }, "User", registry, plain),
    ).toEqual(
      stabilizeRelations({ accounts: [{ id: 3 }, { id: 4 }] }, "User", registry, plain),
    );
  });

  // A relation reached through `select` is as ordered as one through `include`.
  test("select carries the orderBy too", () => {
    const viaSelect = {
      select: { id: true, accounts: { orderBy: { id: "asc" } } },
    };

    expect(
      stabilizeRelations(
        { accounts: [{ id: 4 }, { id: 3 }] },
        "User",
        registry,
        viaSelect,
      ),
    ).not.toEqual(
      stabilizeRelations(
        { accounts: [{ id: 3 }, { id: 4 }] },
        "User",
        registry,
        viaSelect,
      ),
    );
  });
});
