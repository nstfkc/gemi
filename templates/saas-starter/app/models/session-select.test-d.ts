import { describe, expectTypeOf, test } from "vitest";

import { SESSION_SELECT, UserProvider } from "gemi/kernel";
import { AuthManager } from "gemi/services";
import type { FindSessionArgs, SessionWithUser } from "gemi/kernel";
import type { Payload, SelectInput } from "gemi/orm";

import type { SessionTypes } from "./generated";

/**
 * **A session select and the session's type come from one literal** (#349).
 *
 * `UserProvider.sessionSelect()` is loose — the framework cannot name an
 * application's columns — so the typing lives in the application: the select
 * is checked against the generated `SessionTypes`, the session type is derived
 * from it with `Payload`, and the provider is parameterised with that. These
 * pin that the three session queries then carry the extra field in their
 * return types, and that a provider which changes nothing types as before.
 */

const ACCOUNTS = SESSION_SELECT.user.select.accounts;

const APP_SESSION_SELECT = {
  ...SESSION_SELECT,
  user: {
    select: {
      ...SESSION_SELECT.user.select,
      accounts: {
        ...ACCOUNTS,
        orderBy: { id: "asc" },
        select: { ...ACCOUNTS.select, deletedAt: true },
      },
    },
  },
} as const satisfies SelectInput<SessionTypes>;

type AppSession = Payload<SessionTypes, { select: typeof APP_SESSION_SELECT }>;

class AppUserProvider extends UserProvider<AppSession> {
  protected sessionSelect() {
    return APP_SESSION_SELECT;
  }

  // An override wrapping `super` gets the typed session back.
  async findSession(args: FindSessionArgs) {
    const session = await super.findSession(args);
    expectTypeOf(session).toEqualTypeOf<AppSession | null>();
    return session;
  }
}

type Account<S> = NonNullable<S> extends { user: infer U }
  ? NonNullable<U> extends { accounts: (infer A)[] }
    ? A
    : never
  : never;

describe("sessionSelect types the session end to end", () => {
  test("the extra column is on the accounts of every session query", () => {
    type Found = Awaited<ReturnType<AppUserProvider["findSession"]>>;
    type Updated = Awaited<ReturnType<AppUserProvider["updateSession"]>>;
    type Created = Awaited<ReturnType<AppUserProvider["createSessionV2"]>>;

    expectTypeOf<Account<Found>["deletedAt"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<Account<Updated>["deletedAt"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<Account<Created>["deletedAt"]>().toEqualTypeOf<Date | null>();
  });

  test("what the base selects keeps its column types", () => {
    type Found = NonNullable<Awaited<ReturnType<AppUserProvider["findSession"]>>>;

    expectTypeOf<Found["token"]>().toEqualTypeOf<string>();
    expectTypeOf<Found["expiresAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<Account<Found>["organizationRole"]>().toEqualTypeOf<number>();
  });

  test("a column the select does not name is not on the type", () => {
    type Found = Awaited<ReturnType<AppUserProvider["findSession"]>>;

    // @ts-expect-error `settings` is an Account column the select leaves out
    type _Settings = Account<Found>["settings"];
  });

  test("the select is checked against the schema", () => {
    const _bad = {
      ...SESSION_SELECT,
      // @ts-expect-error `archivedAt` is not a Session column
      archivedAt: true,
    } as const satisfies SelectInput<SessionTypes>;
  });

  test("AuthManager takes a provider typed with its own session", () => {
    // The documented binding: `new AuthManager(config, new AppUserProvider())`.
    // Its session need not be a `SessionWithUser` — `Payload` knows the
    // schema's nullable columns, `SessionWithUser` predates them.
    expectTypeOf(new AuthManager({}, new AppUserProvider())).toEqualTypeOf<AuthManager>();
  });

  test("a provider that changes nothing types as before", () => {
    type Found = Awaited<ReturnType<UserProvider["findSession"]>>;
    type Created = Awaited<ReturnType<UserProvider["createSessionV2"]>>;

    expectTypeOf<Found>().toEqualTypeOf<SessionWithUser | null>();
    expectTypeOf<Created>().toEqualTypeOf<SessionWithUser>();
  });
});
