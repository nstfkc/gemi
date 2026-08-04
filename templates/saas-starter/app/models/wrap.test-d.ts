import { expectTypeOf, test, describe } from "vitest";

import type { Payload } from "gemi/orm";

import { UserModel, type UserScalars, type UserTypes } from "./generated";

/**
 * Iteration 8, acceptance criterion 6: **`wrap` rejects a partial row at compile
 * time** — "a type test, not a runtime test".
 *
 * A `.test-d.ts` file, run with `vitest --typecheck`. Nothing here executes; the
 * assertions are the type checker's, which is the only place this property can be
 * asserted. A runtime guard would be a different and weaker guarantee: it would
 * catch the mistake after the query had already run, and it could not stop the
 * code from being written.
 *
 * The property matters because it is the one thing keeping instances and `select`
 * from colliding. A method that reads `this.email` is safe exactly as long as
 * `wrap` cannot be handed a row that did not fetch `email`.
 */

/**
 * The model's full scalar payload.
 *
 * `UserScalars` rather than `Prisma.UserGetPayload<{}>`: the generated bases no
 * longer type-import `@prisma/client`, so an app installs `prisma` alone and
 * this file has nothing to import it for. The type it names is the same set of
 * columns, emitted by the gemi generator from the same DMMF.
 */
type FullUser = UserScalars;

describe("wrap requires a complete row", () => {
  test("a full payload is accepted, and carries both columns and the class", () => {
    const row = {} as FullUser;
    const wrapped = UserModel.wrap(row);

    // Columns are present and correctly typed...
    expectTypeOf(wrapped.email).toEqualTypeOf<string | null>();
    expectTypeOf(wrapped.id).toEqualTypeOf<number>();
    // ...and so is the instance surface, which is what `wrap` exists for.
    expectTypeOf(wrapped.save).toBeFunction();
  });

  test("a Pick is rejected", () => {
    const partial = {} as Pick<FullUser, "id" | "email">;

    // @ts-expect-error a partial row is missing columns a method could read
    UserModel.wrap(partial);
  });

  test("a single-column select result is rejected", () => {
    const narrowed = {} as { id: number };

    // @ts-expect-error the exact shape `select: { id: true }` returns
    UserModel.wrap(narrowed);
  });

  test("an empty object is rejected", () => {
    // @ts-expect-error nothing was fetched at all
    UserModel.wrap({});
  });

  /**
   * The subclass's own instance type, not the generated base's — otherwise `wrap`
   * would be useless for the thing it exists for, since the methods an
   * application adds live on the subclass.
   */
  test("wrap returns the subclass instance type", () => {
    class User extends UserModel {
      get displayName(): string {
        return this.name ?? this.email ?? "anonymous";
      }
    }

    const wrapped = User.wrap({} as FullUser);
    expectTypeOf(wrapped.displayName).toEqualTypeOf<string>();
    expectTypeOf(wrapped).toMatchTypeOf<User>();
  });

  /**
   * A row with an `include` is a superset of the scalar payload, so it is
   * accepted — excess properties are fine when the value is not a fresh object
   * literal, which is what a query result always is. Asserted so the constraint
   * is understood as "at least complete" rather than "exactly the scalars".
   */
  test("a row with relations attached is accepted", () => {
    const withRelations = {} as Payload<
      UserTypes,
      { include: { accounts: true } }
    >;

    expectTypeOf(UserModel.wrap(withRelations).accounts).toBeArray();
  });
});
