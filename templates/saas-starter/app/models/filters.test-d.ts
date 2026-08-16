import { describe, expectTypeOf, test } from "vitest";

import { AnyNull, DbNull, JsonNull } from "gemi/orm";
import type { FieldFilter } from "gemi/orm";

import {
  AccountModel,
  LedgerEntryModel,
  MembershipModel,
  OrganizationModel,
  SocialAccountModel,
  UserModel,
} from "./generated";

/**
 * **The argument grammar, at the type level.**
 *
 * This file exists because moving the whole grammar in-house — off
 * `@prisma/client` and onto `orm/types.ts` — moved a large, load-bearing body of
 * types into this repository with nothing checking them, and four defects went
 * out in the change that did it:
 *
 *   - `{ id: { gt: 5 } }` did not compile on any `Int`, `Float`, `BigInt`,
 *     `DateTime`, `Boolean` or `Bytes` column. `OrderingFilter`'s and
 *     `StringFilter`'s false branches were `Record<string, never>`, which is not
 *     an empty object but an index signature valued `never`, so every sibling
 *     property of the intersection had to satisfy `never` too.
 *   - `Membership`, having no relations, got the same `Record<string, never>`
 *     from the generator and could not be filtered, `findUnique`d, updated or
 *     deleted — by its own primary key included.
 *   - `metadata: null` compiled, while `docs/orm.md` said in the same change
 *     that it does not.
 *   - a required foreign key stayed required when the relation supplied it, so
 *     Prisma's canonical `user: { connect: … }` was a compile error.
 *
 * **None of it was visible to CI**, and that is the part worth keeping in mind
 * when adding to this file. The model suites drive `$exec` with hand-built
 * schemas and `any`; the other `.test-d.ts` files cover `wrap`, `select`,
 * aggregates and policies. Nothing typechecked an operator-object filter, a
 * relation-less model's `where`, or a nested `connect`. A green suite meant
 * nothing about the grammar.
 *
 * So the shape of this file is: one column of each storage class against the
 * operators the compiler accepts for it, and the negative cases that prove the
 * narrowing still bites. Nothing here runs — the assertions are the compiler's.
 */

describe("scalar filters, per storage class", () => {
  test("Int takes equality, ordering and set membership", async () => {
    await UserModel.findMany({ where: { id: 1 } });
    await UserModel.findMany({ where: { id: { equals: 1 } } });
    await UserModel.findMany({ where: { id: { not: 1 } } });
    await UserModel.findMany({ where: { id: { in: [1, 2] } } });
    await UserModel.findMany({ where: { id: { notIn: [1, 2] } } });
    await UserModel.findMany({ where: { id: { lt: 5, lte: 5, gt: 1, gte: 1 } } });
  });

  test("DateTime is ordered", async () => {
    await UserModel.findMany({ where: { createdAt: new Date() } });
    await UserModel.findMany({ where: { createdAt: { gte: new Date() } } });
    await UserModel.findMany({ where: { createdAt: { lt: new Date() } } });
    await UserModel.findMany({ where: { createdAt: { in: [new Date()] } } });
  });

  test("String takes the pattern operators as well", async () => {
    await UserModel.findMany({ where: { publicId: "x" } });
    await UserModel.findMany({ where: { publicId: { contains: "x" } } });
    await UserModel.findMany({ where: { publicId: { startsWith: "x" } } });
    await UserModel.findMany({ where: { publicId: { endsWith: "x" } } });
    await UserModel.findMany({
      where: { publicId: { contains: "x", mode: "insensitive" } },
    });
  });

  test("a nullable column takes null, and its operators", async () => {
    await UserModel.findMany({ where: { email: null } });
    await UserModel.findMany({ where: { email: { equals: null } } });
    await UserModel.findMany({ where: { email: { not: null } } });
    await UserModel.findMany({ where: { email: { contains: "@" } } });
  });

  /**
   * `Bytes` is the storage class with *neither* an ordering nor patterns, so it
   * exercises both false branches at once — which is exactly the pair that
   * `Record<string, never>` was poisoning.
   *
   * **`Boolean` would be the other such column and this schema has none.** Not
   * faked with a cast: a type test whose subject is invented proves the type
   * accepts the invention. `Boolean` reaches the same `NoKeys` branches through
   * the same code path as `Bytes`, so it is covered in mechanism if not by name.
   * `String[]` has no *column* here for the same reason — scalar lists are a
   * Postgres-only schema (`postgres-only.prisma`), whose artifacts are
   * uncommitted and so cannot be typechecked in the SQLite job. Its arm is
   * still asserted, one test down: the list grammar is a function of the
   * element type alone, so it does not need a model to reach.
   */
  test("Bytes takes equality but not ordering or patterns", async () => {
    await AccountModel.findMany({ where: { token: { equals: null } } });
    await AccountModel.findMany({
      where: { token: { equals: new Uint8Array([1]) } },
    });
    await AccountModel.findMany({ where: { token: { not: null } } });
  });

  /**
   * **The scalar-list arm, without a scalar-list column.**
   *
   * Every other grammar #369 derived from the compiler's own operator tuple has
   * something committed pinning it. `ListFilter` was the exception — a
   * `String[]` is a validation error on SQLite, so there is no column here to
   * ask through, and the write-up said the derivation therefore could not be
   * asserted in this repository at all.
   *
   * That was true of asking *through a model* and false of the type. `ListFilter`
   * is reached from `FieldFilter`'s array branch on the element type alone, and
   * `FieldFilter` is public, so a type argument is enough. No column, no
   * Postgres, no generated artifact.
   *
   * Two assertions rather than one, because they fail on different drift. The
   * key set is `LIST_FILTER_NAMES` in `compile/where.ts`; the operand of each
   * key is `ListFilterOperand`'s three-way split — `has` asks about one element,
   * `isEmpty` about the array's length, the other three take a whole array — and
   * that split is the part that still has to be stated per operator.
   */
  test("the scalar-list arm is the compiler's list, on its element type", () => {
    type ListArm = Exclude<FieldFilter<string[]>, string[]>;

    expectTypeOf<keyof ListArm>().toEqualTypeOf<
      "equals" | "has" | "hasEvery" | "hasSome" | "isEmpty"
    >();

    expectTypeOf<ListArm>().toEqualTypeOf<{
      equals?: string[];
      has?: string;
      hasEvery?: string[];
      hasSome?: string[];
      isEmpty?: boolean;
    }>();
  });

  test("an enum column is the union of its members", async () => {
    await OrganizationModel.findMany({ where: { plan: "pro" } });
    await OrganizationModel.findMany({ where: { plan: "enterprise" } });
    await OrganizationModel.findMany({ where: { plan: { in: ["free", "pro"] } } });
  });

  /**
   * The negatives. Each is an operator the *where compiler* refuses for that
   * column's type, so a type that accepted it would be the
   * type-checks-but-throws divergence this whole change exists to remove.
   */
  test("an operator the column's type does not have is refused", async () => {
    // @ts-expect-error `contains` is a substring question; an Int has none
    await UserModel.findMany({ where: { id: { contains: "x" } } });
    // @ts-expect-error `gt` needs an ordering, which Bytes has not
    await AccountModel.findMany({ where: { token: { gt: new Uint8Array([1]) } } });
    // @ts-expect-error nor has Bytes a substring
    await AccountModel.findMany({ where: { token: { contains: "x" } } });
    // @ts-expect-error a String column does not compare against a number
    await UserModel.findMany({ where: { publicId: 1 } });
    // @ts-expect-error nor does an enum accept a non-member
    await OrganizationModel.findMany({ where: { plan: "platinum" } });
    // @ts-expect-error a non-nullable column is not null
    await UserModel.findMany({ where: { id: null } });
    // @ts-expect-error and an unknown column is not a filter at all
    await UserModel.findMany({ where: { nope: 1 } });
  });

  test("combinators take the same grammar", async () => {
    await UserModel.findMany({
      where: {
        AND: [{ id: { gt: 1 } }, { email: { contains: "@" } }],
        OR: [{ publicId: "a" }, { publicId: "b" }],
        NOT: { id: 3 },
      },
    });
  });
});

/**
 * A model with **no relations at all**, which is the case that was entirely
 * broken and that no other test reaches. `Membership` has four columns and a
 * composite primary key.
 */
describe("a relation-less model is addressable", () => {
  test("by a plain where", async () => {
    await MembershipModel.findMany({ where: { organizationId: 1 } });
    await MembershipModel.findMany({ where: { userId: { in: [1, 2] } } });
  });

  test("by its compound primary key, on every operation that takes one", async () => {
    const where = { organizationId_userId: { organizationId: 1, userId: 2 } };

    await MembershipModel.findUnique({ where });
    await MembershipModel.findUniqueOrThrow({ where });
    await MembershipModel.delete({ where });
    await MembershipModel.update({ where, data: { role: 2 } });
  });

  test("and by the batch operations", async () => {
    await MembershipModel.deleteMany({ where: { organizationId: 1 } });
    await MembershipModel.updateMany({
      where: { organizationId: 1 },
      data: { role: 1 },
    });
  });
});

describe("relation filters", () => {
  test("a to-many takes some / every / none", async () => {
    await UserModel.findMany({ where: { accounts: { some: { id: 1 } } } });
    await UserModel.findMany({ where: { accounts: { every: { id: 1 } } } });
    await UserModel.findMany({ where: { accounts: { none: {} } } });
  });

  test("a to-one takes the nested where directly, and null", async () => {
    await AccountModel.findMany({ where: { user: { email: "a@b.c" } } });
    await AccountModel.findMany({ where: { user: { is: { id: 1 } } } });
    await AccountModel.findMany({ where: { user: { isNot: null } } });
    await AccountModel.findMany({ where: { user: null } });
  });

  test("a to-many does not take a bare object, as the compiler refuses it", async () => {
    // @ts-expect-error `{ some: … }` or `{ none: … }` — a bare filter has no
    // unambiguous reading over a collection, and `readOperators` raises.
    await UserModel.findMany({ where: { accounts: { id: 1 } } });
  });
});

describe("Json columns", () => {
  test("take values and the two null sentinels on write", async () => {
    await UserModel.create({ data: { metadata: { a: 1 } } });
    await UserModel.create({ data: { metadata: DbNull } });
    await UserModel.create({ data: { metadata: JsonNull } });
    // A *nested* null is an ordinary JSON value and stays legal.
    await UserModel.create({ data: { metadata: { a: [1, null] } } });
  });

  test("refuse a bare null, which is the choice the sentinels exist to force", async () => {
    // @ts-expect-error a Json column has two empty states; say which
    await UserModel.create({ data: { metadata: null } });
  });

  test("filter by sentinel", async () => {
    await UserModel.findMany({ where: { metadata: { equals: DbNull } } });
    await UserModel.findMany({ where: { metadata: { equals: JsonNull } } });
  });
});

/**
 * **The path filter, which the compiler has implemented since `cc22399` and the
 * type described not at all** — #336, and the fourth of the same kind after
 * #326, #333 and #337.
 *
 * It is the worst of the four because the type did not *refuse* the argument,
 * it **accepted anything**. `FieldFilter`'s `Json` arm unions in `JsonValue`,
 * whose `{ [key: string]: JsonValue }` member absorbs any object literal as an
 * `equals` shorthand; a union permits a property present in any member, so
 * excess-property checking never fired and `{ path: 123, notAFilter: true }`
 * compiled clean. Every refusal `orm.md` specifies was discoverable only by
 * running the query, and the feature worked by accident for anyone who spelled
 * it correctly.
 *
 * So the negatives below are the point of the file, not the trimmings — each
 * one compiled before this and the runtime threw. `path?: never` on the value
 * arm is what turns `path` into a discriminant and lets them be caught.
 */
describe("Json path filters", () => {
  /**
   * Both path grammars are offered, because the type has no dialect to consult
   * — `ModelTypeInfo` records none, and `DATABASE_URL` picks it at connect
   * time. `assertPathShape` refuses the other dialect's form with a message
   * naming this one, the way `mode: "insensitive"` and `ListFilter` already do.
   */
  test("take either dialect's path grammar", async () => {
    await UserModel.findMany({
      where: { metadata: { path: ["operation"], equals: "video" } },
    });
    await UserModel.findMany({ where: { metadata: { path: "$.operation", equals: "video" } } });
    // An array index is a key too, and it is spelled as one — `#>` takes a
    // `text[]`, so this reaches the same element a numeric segment used to.
    await UserModel.findMany({ where: { metadata: { path: ["items", "0", "id"], gt: 3 } } });
  });

  /**
   * **#371's third gap, closed on the narrow side.** This type read
   * `readonly (string | number)[]` because `assertPathShape` accepted a numeric
   * segment, and a type-only change (#368) could not remove a superset the
   * compiler had. `assertPathShape` refuses one now: Prisma's generated `path`
   * is `string[]` and its client answers *"Argument `path`: Invalid value
   * provided. Expected String, provided Int."* at run time, measured on 6.19.2.
   */
  test("a numeric path segment is refused, as Prisma refuses one", async () => {
    // @ts-expect-error write ["items", "0"]; it reaches the same element
    await UserModel.findMany({ where: { metadata: { path: ["items", 0], equals: "x" } } });
  });

  test("take the ten operators JSON_FILTERS accepts", async () => {
    await UserModel.findMany({ where: { metadata: { path: ["a"], not: "x" } } });
    await UserModel.findMany({ where: { metadata: { path: ["a"], string_contains: "x" } } });
    await UserModel.findMany({ where: { metadata: { path: ["a"], string_starts_with: "x" } } });
    await UserModel.findMany({ where: { metadata: { path: ["a"], string_ends_with: "x" } } });
    await UserModel.findMany({
      where: { metadata: { path: ["a"], lt: 1, lte: 2, gt: 3, gte: 4 } },
    });
    // The one operator whose operand is a document, because containment is the
    // operator that means one.
    await UserModel.findMany({ where: { metadata: { path: ["a"], array_contains: { b: 1 } } } });
  });

  test("a path that is not a path is refused", async () => {
    // @ts-expect-error a path is an array of keys or a JSONPath string
    await UserModel.findMany({ where: { metadata: { path: 123, notAFilter: true } } });
  });

  test("an operand the operator cannot compile is refused", async () => {
    // @ts-expect-error `string_contains` builds a `like` pattern; 4 becomes '%4%'
    await UserModel.findMany({ where: { metadata: { path: [], string_contains: 4 } } });
  });

  /**
   * The misspelling, which is the case a half-fix lets through: adding the
   * operators without excluding `path` from the value arm leaves the index
   * signature answering "yes, `equalz` is a known property" on the union's
   * behalf.
   */
  test("an operator that is not an operator is refused", async () => {
    // @ts-expect-error `equalz` is not in JSON_FILTERS
    await UserModel.findMany({ where: { metadata: { path: ["operation"], equalz: "video" } } });
  });

  /**
   * **The sentinels type-check under `equals` and `not`, and nowhere else at a
   * path — #407.** They used to be refused under all ten, because `#>>` yields
   * SQL NULL for an absent key and a JSON `null` alike and the distinction the
   * sentinels draw was gone before the comparison. `dialect.jsonValueAt` is the
   * extraction that keeps it — `#>` on Postgres, `->` on SQLite — so the
   * question is answerable, and the type has to admit it: folio's
   * `{ payload: { path: […], equals: AnyNull } }` is a read that could not
   * leave Prisma while this was a compile error.
   */
  test("a sentinel at a path type-checks under equals and not", async () => {
    await UserModel.findMany({ where: { metadata: { path: ["a"], equals: DbNull } } });
    await UserModel.findMany({ where: { metadata: { path: ["a"], not: JsonNull } } });
    await UserModel.findMany({ where: { metadata: { path: ["a"], equals: AnyNull } } });
    // The predicate #407 exists for: "the extracted value is not there".
    await UserModel.findMany({
      where: {
        OR: [
          { metadata: { path: ["operation"], equals: "video" } },
          { name: "video", metadata: { path: ["operation"], equals: AnyNull } },
        ],
      },
    });
  });

  /**
   * ...and under the other eight it is still a compile error, which is what the
   * compiler does and what Prisma does — *"Invalid value provided. … provided
   * Enum."*, measured on 6.19.2. A sentinel asks which kind of null a value is;
   * `gt` compares a number and `string_contains` builds a pattern.
   *
   * The nested shape goes with them: `{ equals: { not: DbNull } }` is an object
   * operand, and an object under `equals` is refused for its own reason.
   */
  test("a sentinel under the other operators is refused, and so is one a level down", async () => {
    // @ts-expect-error a sentinel is not a number
    await UserModel.findMany({ where: { metadata: { path: ["a"], gt: DbNull } } });
    // @ts-expect-error nor a string to build a pattern from
    await UserModel.findMany({ where: { metadata: { path: ["a"], string_contains: JsonNull } } });
    // @ts-expect-error nor a document to test containment against
    await UserModel.findMany({ where: { metadata: { path: ["a"], array_contains: AnyNull } } });
    // @ts-expect-error and the nested operator object is refused as an object
    await UserModel.findMany({ where: { metadata: { path: ["a"], equals: { not: AnyNull } } } });
  });

  /**
   * **A bare `null` is accepted under `equals` / `not` at a path, and it means
   * `JsonNull` there** — `{ path: […], equals: null }` and
   * `{ path: […], equals: JsonNull }` compile to byte-identical SQL and return
   * identical rows, measured on 6.19.2 against both dialects. There is nothing
   * to guess, so refusing it would be gemi diverging from the oracle. That was
   * #371's second item, and #407 closed it with the same change.
   *
   * On the *column* a bare `null` is accepted too and means the other thing —
   * `DbNull`, compiling to `is null`. Neither the type nor the compiler refuses
   * it there; `JsonFilter`'s docblock says why the type cannot.
   *
   * **And that one is a known divergence rather than a rule.** Prisma reads a
   * bare `null` as the JSON value on the column as well, so the two libraries
   * return disjoint row sets for the same filter — measured, and recorded in
   * `known-divergences.test.ts` and `docs/orm.md`. It is pre-existing and not
   * #407's to fix; what #407 changed is the *path*, where the two now agree.
   *
   * The lines below pin only that the column form compiles, which is all a type
   * test can see. Two earlier drafts of this comment got the surrounding claim
   * wrong in opposite directions — first that the column form was a type error,
   * then that Prisma agreed with it — and nothing here would have caught
   * either, so the sentence is kept short and the row-level claim is left to
   * the file that can measure it.
   */
  test("a bare null on the column is accepted, and diverges from Prisma", async () => {
    await UserModel.findMany({ where: { metadata: { equals: null } } });
    await UserModel.findMany({ where: { metadata: { not: null } } });
  });

  /**
   * ...and at a path it is the other empty — see the test above for the column.
   *
   * **`array_contains` still refuses a bare `null`**, and for a different
   * reason — it is the one path operator whose operand is a whole document, so
   * it does not come along with the scalar arm. A bare `null` there reaches
   * `dialect.jsonArrayContains` and binds as SQL NULL; `x @> NULL` is NULL, not
   * false, so the filter matches no row rather than asking anything. Only the
   * top-level operand goes — a `null` *inside* the document is an ordinary JSON
   * value, and the line below pins that it stays expressible. (The finding is
   * #380's, on the hand-written literal this branch replaced with a mapped
   * type; the narrowing lives on `JsonPathOperand`'s `array_contains` arm so
   * the two do not come down to which side of a merge is taken.)
   */
  test("null at a path reads as JsonNull, except under array_contains", async () => {
    await UserModel.findMany({ where: { metadata: { path: ["a"], equals: null } } });
    await UserModel.findMany({ where: { metadata: { path: ["a"], not: null } } });
    // @ts-expect-error `x @> NULL` is NULL, so containment against a bare null asks nothing
    await UserModel.findMany({ where: { metadata: { path: ["a"], array_contains: null } } });
    // ...and it is only the *top level* that goes: a null inside the document is a value.
    await UserModel.findMany({ where: { metadata: { path: ["a"], array_contains: [1, null] } } });
    // @ts-expect-error the numeric comparisons compare a number; Prisma's engine panics on this
    await UserModel.findMany({ where: { metadata: { path: ["a"], gt: null } } });
  });

  /**
   * The column filter must not have lost anything — but "anything" is what the
   * *compiler* accepts, and an object operand on a `Json` column is a filter to
   * it, never a document. `isFilterObject` sends every non-`Date`, non-array
   * object to the operator loop; only scalars and arrays reach `equals`. So the
   * document goes under `equals`, which is the only spelling `docs/orm.md` has
   * ever shown.
   */
  test("the column filter still takes every operand the compiler answers", async () => {
    await UserModel.findMany({ where: { metadata: [1, 2] } });
    await UserModel.findMany({ where: { metadata: "video" } });
    await UserModel.findMany({ where: { metadata: { equals: { a: 1 } } } });
    await UserModel.findMany({ where: { metadata: { not: AnyNull } } });
    await UserModel.findMany({ where: { metadata: { equals: DbNull } } });
  });

  /**
   * And refuses the ones it raises on. Both of these compiled before this
   * change and threw `InvalidArgumentError` naming the key — the same
   * type-checks-but-throws divergence #336 is about, reached from the value arm
   * instead of the path arm.
   */
  test("a bare document is refused, because the compiler raises on it", async () => {
    // @ts-expect-error InvalidArgumentError on `where.metadata.a` — write { equals: { a: 1 } }
    await UserModel.findMany({ where: { metadata: { a: 1 } } });
    // @ts-expect-error and `equalz` is not an operator either — same error, same fix
    await UserModel.findMany({ where: { metadata: { equalz: "video" } } });
  });

  /**
   * A document with a top-level `path` key is the same story with the key that
   * happens to be the discriminant: `compileFieldFilter` dispatches on
   * `filter.path !== undefined`, so the bare form reached `compileJsonFilter`
   * and raised. `{ equals: … }` is the spelling, as it is for every other
   * document.
   */
  test("a document with a `path` key is written as an explicit equals", async () => {
    await UserModel.findMany({ where: { metadata: { equals: { path: "/a", method: "GET" } } } });
    // @ts-expect-error the bare form is a path filter to the compiler, not a value
    await UserModel.findMany({ where: { metadata: { path: "/a", method: "GET" } } });
  });

  /**
   * **The discriminant must not leak downwards.** `path` is only special as the
   * *operand's* own key; one level into a document it is an ordinary string
   * key, and an index signature does not synthesise a property that would trip
   * the check. If it did, this change would have broken every payload that
   * stores a URL path.
   */
  test("a `path` key inside the document is an ordinary key", async () => {
    await UserModel.findMany({ where: { metadata: { equals: { config: { path: "/x" } } } } });
    await UserModel.findMany({ where: { metadata: { equals: { a: { b: { path: [1, 2] } } } } } });
    await UserModel.findMany({ where: { metadata: [{ path: "/x" }, { path: "/y" }] } });
  });

  /**
   * `not` is the asymmetric one, and the type now says so. `equals` binds its
   * operand as a value; `not` hands an object operand back to
   * `compileFieldFilter` as a nested filter, so a negated path filter is a real
   * query and a misspelled operator under `not` is a real error. Both measured.
   */
  test("`not` carries a whole filter, including a path one", async () => {
    await UserModel.findMany({ where: { metadata: { not: { path: ["a"], equals: 1 } } } });
    await UserModel.findMany({ where: { metadata: { not: { equals: { a: 1 } } } } });
    await UserModel.findMany({ where: { metadata: { not: [1, 2] } } });

    // @ts-expect-error the recursion reaches the same refusal
    await UserModel.findMany({ where: { metadata: { not: { path: ["a"], equalz: 1 } } } });
    // @ts-expect-error and `a` is not an operator here either
    await UserModel.findMany({ where: { metadata: { not: { a: 1 } } } });
  });

  /**
   * A path is the natural thing to hoist out of a query, and hoisting it makes
   * it `readonly`. `assertPathShape` uses `Array.isArray` and `.every`, which a
   * frozen array answers, and the path is bound rather than mutated — so the
   * type takes a `readonly` array. Without it, `as const` on the filter object
   * was a compile error against a query that runs.
   */
  test("a hoisted or `as const` path still compiles", async () => {
    const PATH = ["operation"] as const;
    await UserModel.findMany({ where: { metadata: { path: PATH, equals: "video" } } });

    const filter = { path: ["a"], equals: "x" } as const;
    await UserModel.findMany({ where: { metadata: filter } });
  });

  test("and it narrows the same one level down, inside a relation filter", async () => {
    await AccountModel.findMany({
      where: { user: { metadata: { path: ["a"], equals: 1 } } },
    });

    await AccountModel.findMany({
      // @ts-expect-error the same refusal reached through a to-one
      where: { user: { metadata: { path: ["a"], equalz: 1 } } },
    });
  });
});

describe("create accepts either spelling of a foreign key", () => {
  test("the raw column", async () => {
    await SocialAccountModel.create({
      data: {
        userId: 1,
        provider: "github",
        providerId: "1",
        accessToken: "a",
        refreshToken: "b",
        expiresAt: new Date(),
      },
    });
  });

  /**
   * Prisma's canonical form, which did not compile: `CreateInput` is the scalar
   * half intersected with the relation half, so a required FK was demanded even
   * when `connect` supplied it.
   */
  test("or a nested connect", async () => {
    await SocialAccountModel.create({
      data: {
        provider: "github",
        providerId: "1",
        accessToken: "a",
        refreshToken: "b",
        expiresAt: new Date(),
        user: { connect: { id: 1 } },
      },
    });
  });

  test("including a connect on a compound key", async () => {
    await LedgerEntryModel.create({
      data: {
        amount: 1,
        ledger: { connect: { tenantId_code: { tenantId: 1, code: "x" } } },
      },
    });
  });

  /**
   * The relaxation is scoped to foreign keys, not to required columns generally.
   * `accessToken` is not nullable, has no default and backs no relation, so
   * omitting it stays a *compile* error rather than becoming a runtime one.
   */
  test("a column no relation backs is still required", async () => {
    await SocialAccountModel.create({
      // @ts-expect-error accessToken, refreshToken and expiresAt are missing
      data: { provider: "github", providerId: "1", user: { connect: { id: 1 } } },
    });
  });
});

describe("the operations refused by design are refused by the types", () => {
  test("cursor and distinct are not in the grammar", async () => {
    // @ts-expect-error `cursor` is refused permanently — see compile/read.ts
    await UserModel.findMany({ cursor: { id: 1 } });
    // @ts-expect-error and so is `distinct`
    await UserModel.findMany({ distinct: ["email"] });
  });
});

describe("orderBy and pagination", () => {
  test("take columns and a direction", async () => {
    await UserModel.findMany({ orderBy: { createdAt: "desc" }, take: 10, skip: 5 });
    await UserModel.findMany({ orderBy: [{ id: "asc" }, { publicId: "desc" }] });
  });

  test("a direction that is not a direction is refused", async () => {
    // @ts-expect-error "ascending" is not a SortOrder
    await UserModel.findMany({ orderBy: { id: "ascending" } });
  });

  /**
   * **The long form says where nulls go** — #337.
   *
   * Parsed and compiled long before it could be written: `read.test.ts:186`
   * asserts `"name" asc nulls last` for a scalar, `order-relation.test.ts:55`
   * the same through a relation, and `refusals.test.ts:85` rejects a `nulls`
   * that is neither. The type was the only thing refusing the argument.
   *
   * Worth writing even where the dialect agrees. Postgres sorts nulls above
   * every non-null, so `asc` already means `nulls last` and the SQL is
   * equivalent — but then the query rests on that default instead of saying
   * what it means, and `desc` makes the same default mean the opposite.
   */
  test("the long form takes a nulls placement", async () => {
    await UserModel.findMany({
      orderBy: { email: { sort: "asc", nulls: "last" } },
    });

    await UserModel.findMany({
      orderBy: [{ id: "desc" }, { email: { sort: "asc", nulls: "first" } }],
    });
  });

  test("`sort` is required, and `nulls` is not", async () => {
    await UserModel.findMany({ orderBy: { email: { sort: "desc" } } });

    // @ts-expect-error the long form has no direction to sort by
    await UserModel.findMany({ orderBy: { email: { nulls: "last" } } });
  });

  test("a nulls placement that is neither is refused", async () => {
    await UserModel.findMany({
      // @ts-expect-error "sideways" is not a NullsOrder
      orderBy: { email: { sort: "asc", nulls: "sideways" } },
    });
  });

  test("ordering by a relation count takes it too", async () => {
    await UserModel.findMany({
      orderBy: { accounts: { _count: { sort: "desc", nulls: "last" } } },
    });
  });

  /**
   * `relationOrderExpression` throws for a to-one `_count` — ordering by a
   * count of 0 or 1 is ordering by the relation's own nullability — so the type
   * has no business offering it. Same hole `CountSelection` closed for `_count`
   * in a `select`, and it reuses that type so both say the same thing.
   */
  test("a to-one relation cannot be ordered by its count", async () => {
    // @ts-expect-error `organization` is to-one; its count is 0 or 1
    await UserModel.findMany({ orderBy: { organization: { _count: "desc" } } });
  });

  test("but ordering a to-one by one of its fields is fine", async () => {
    await UserModel.findMany({ orderBy: { organization: { name: "asc" } } });
  });

  /**
   * `groupBy` is the one operation whose `orderBy` does not go through
   * `parseOrderBy` — it has its own reader, because its ordering may name an
   * aggregate. So the long form had to be taught there separately; before that
   * this typechecked and threw.
   */
  test("groupBy takes the long form too, on a column and on an aggregate", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      orderBy: { globalRole: { sort: "asc", nulls: "last" } },
    });

    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      orderBy: { _count: { globalRole: { sort: "desc", nulls: "first" } } },
    });
  });
});

/**
 * `groupBy` orders by things `findMany` has no notion of, so it has its own
 * input type rather than borrowing `OrderByInput` (#340). Borrowing it made the
 * top-N-by-count query — the one `groupBy` mostly exists for, and the one the
 * docs lead with — a compile error, while offering relation orderings the
 * compiler refuses.
 */
describe("groupBy orders by an aggregate", () => {
  test("the top-N-by-count query", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      orderBy: { _count: { globalRole: "desc" } },
    });
  });

  test("`_all` names no column, because it compiles to count(*)", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      orderBy: { _count: { _all: "asc" } },
    });
  });

  test("and `_all` belongs to `_count` alone", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error only `count(*)` names no column; `sum()` needs one
      orderBy: { _sum: { _all: "desc" } },
    });
  });

  /**
   * The same key sets `AggregateArgs` uses, so the ordering cannot drift from
   * what `assertAggregable` allows: arithmetic for `_sum` / `_avg`, an ordering
   * both dialects have for `_min` / `_max`.
   */
  test("`_sum` needs arithmetic", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error `email` is a String, and sum needs a number
      orderBy: { _sum: { email: "desc" } },
    });
  });

  test("`_max` needs an ordering the two dialects agree on", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error `metadata` is Json, which has one on neither dialect
      orderBy: { _max: { metadata: "desc" } },
    });
  });

  test("but `_count` applies to any column", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      orderBy: { _count: { metadata: "desc" } },
    });
  });

  /**
   * `findMany` orders by a relation; `groupBy` looks its `orderBy` keys up in
   * `schema.fields`, where a relation is not, and throws. The shared type
   * offered this — which is the same divergence in the other direction.
   */
  test("a relation is not an ordering here, though it is on findMany", async () => {
    await UserModel.findMany({ orderBy: { accounts: { _count: "desc" } } });

    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error groupBy has no relation ordering — the compiler refuses it
      orderBy: { accounts: { _count: "desc" } },
    });
  });
});

/**
 * `having` was the same divergence as `orderBy`, one line above it in
 * `GroupByArgs`: it borrowed `WhereInput`, and `compileHaving` is a second
 * predicate compiler rather than `compileWhere` with a flag.
 */
describe("having filters an aggregate, or a grouped column", () => {
  test("the aggregate filter, which is what a having is for", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { email: { _count: { gt: 1 } } },
    });

    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { id: { _sum: { gt: 0 } } },
    });
  });

  test("a plain comparison on the grouped column still works", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { globalRole: { gt: 1 } },
    });
  });

  test("and the bare value is `equals`, as in a where", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { globalRole: 3 },
    });
  });

  /**
   * `count` and `avg` answer in their own type whatever the column was;
   * `_sum` / `_min` / `_max` keep the column's.
   */
  test("a count compares against a number, whatever the column is", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error `count(email)` is a number, not a string
      having: { email: { _count: { gt: "1" } } },
    });
  });

  test("a min keeps the column's type", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { createdAt: { _min: { gt: new Date() } } },
    });
  });

  test("`_sum` needs arithmetic here too", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error `email` is a String, and sum needs a number
      having: { email: { _sum: { gt: 1 } } },
    });
  });

  test("`_max` needs an ordering the two dialects agree on", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error `avatar` is Bytes, which has one on neither dialect
      having: { avatar: { _max: { gt: 1 } } },
    });
  });

  /**
   * Except on a `Json` column, where it cannot be — and this is deliberately
   * *not* a `@ts-expect-error`, because the directive would fail the run.
   *
   * A `Json` column's filter is a union with `JsonValue`, which contains
   * `{ [key: string]: JsonValue }`, so any JSON-shaped object literal is a
   * legal *value* for it — including one that happens to be spelled like an
   * aggregate filter. The same hole `FieldFilter` documents rather than papers
   * over, and Prisma has it too. `assertAggregable` refuses this at runtime,
   * naming the column and its type.
   */
  test("but a Json column takes any object, so nothing here can refuse it", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { metadata: { _max: { gt: 1 } } },
    });
  });

  /**
   * `having` has its own operand reader — six comparisons, and none of the
   * string or list operators a `where` offers. The type used to offer all of
   * them and the compiler threw.
   */
  test("the string operators a where has are not offered", async () => {
    await UserModel.findMany({ where: { name: { contains: "a" } } });

    await UserModel.groupBy({
      by: ["name"],
      _count: true,
      // @ts-expect-error a having takes equals, gt, gte, lt, lte, not
      having: { name: { contains: "a" } },
    });
  });

  test("a relation is not a having key, though it is a where key", async () => {
    await UserModel.findMany({ where: { accounts: { some: {} } } });

    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error a having key resolves against the columns
      having: { accounts: { some: {} } },
    });
  });

  test("AND, OR and NOT still nest", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: {
        AND: [{ globalRole: { gt: 7 } }, { globalRole: { _count: { lte: 9 } } }],
      },
    });
  });
});

describe("the payload still narrows, with the filters in place", () => {
  test("a filtered select is narrowed to the selection", async () => {
    const [row] = await UserModel.findMany({
      where: { id: { gt: 1 } },
      select: { id: true, email: true },
    });

    expectTypeOf(row.id).toEqualTypeOf<number>();
    expectTypeOf(row.email).toEqualTypeOf<string | null>();
  });
});
