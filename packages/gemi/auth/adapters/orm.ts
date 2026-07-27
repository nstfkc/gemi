import type * as registry from "../../orm/registry";
import type {
  Account,
  CreateAccountArgs,
  CreateMagicLinkTokenArgs,
  CreatePasswordResetTokenArgs,
  CreateSessionArgs,
  CreateSocialAccountArgs,
  CreateUserArgs,
  DeletePasswordResetTokenArgs,
  DeleteSessionArgs,
  FindPasswordResetTokenArgs,
  FindSessionArgs,
  IAuthenticationAdapter,
  Invitation,
  PasswordResetToken,
  SessionWithUser,
  UpdateSessionArgs,
  UpdateUserPasswordArgs,
  User,
} from "./types";

/**
 * The authentication adapter, on the gemi ORM.
 *
 * This is the piece `plans/orm/README.md` schedules for "once iteration 4 lands
 * writes", and it is the thing that lets `auth/adapters/prisma.ts` eventually be
 * deprecated — which was PR #33's stated goal, and the reason its proposed
 * hand-written `SqlUserProvider` was dropped in favour of building the ORM first.
 * Twenty-two methods of per-dialect SQL is exactly what a compiler is for.
 *
 * **It ships alongside the Prisma adapter, not instead of it.** An application
 * selects one; both satisfy `IAuthenticationAdapter`, so nothing else in `auth/`
 * knows which is in use. That is what lets an app migrate when it chooses rather
 * than when the framework chooses.
 *
 * ## Why the models are injected rather than imported
 *
 * The ORM resolves models by *name* through a registry, and the generated classes
 * live in the application (`app/models/generated`), not in the framework. So this
 * adapter cannot import `User` — there is no such module here. It takes the model
 * classes it needs, which also makes it testable against fixtures and lets an
 * application point it at its own subclasses (the ones carrying policies, which
 * matters: see the note on `asSystem` below).
 *
 * ## Two behaviours worth knowing before switching
 *
 * **Policies are suspended.** Every query here runs inside `Model.asSystem`.
 * Authentication happens *before* there is an authenticated user, so a policy
 * that scopes by `ctx.user` cannot be satisfied — and under deny-by-default it
 * would raise rather than return null, turning "wrong password" into a 500. The
 * adapter is the one place in an application where acting without a user is
 * correct rather than a mistake, so it says so explicitly at the call site,
 * which is what `asSystem` is for.
 *
 * **`password` is stripped from returned users**, matching Prisma's adapter. The
 * ORM does not implement `omit`, so it is deleted from the returned object rather
 * than excluded by the query — see `createUser` for why that is the right shape
 * and why it matters: `POST /sign-up` returns this object as its response body.
 */

/**
 * Drops the password from a user object.
 *
 * By deletion rather than by a `select` naming every other column, which would
 * have to be maintained against the schema and would silently start returning a
 * new sensitive column the day one is added. Mutates and returns the same object
 * because it is the freshly-created row and nothing else holds a reference to it.
 */
function withoutPassword<T>(user: T): T {
  if (user && typeof user === "object") {
    delete (user as { password?: unknown }).password;
  }
  return user;
}

/** The generated model classes this adapter needs, by their Prisma names. */
export interface AuthModels {
  User: any;
  Session: any;
  Account: any;
  PasswordResetToken: any;
  MagicLinkToken: any;
  OrganizationInvitation: any;
  SocialAccount: any;
}

/**
 * The user shape the rest of `auth/` expects on a session.
 *
 * Spelled out rather than `include: { user: true }` because the interface's `User`
 * carries `accounts[].organization`, which is a relation two levels down — and
 * because naming the columns is what keeps the *session* queries from selecting
 * `password` into something that is handed to a client.
 */
const SESSION_USER = {
  select: {
    id: true,
    publicId: true,
    email: true,
    name: true,
    locale: true,
    globalRole: true,
    organizationId: true,
    accounts: {
      select: {
        id: true,
        publicId: true,
        organizationRole: true,
        organization: true,
      },
    },
  },
} as const;

export class OrmAuthenticationAdapter implements IAuthenticationAdapter {
  constructor(protected models: AuthModels) {}

  /**
   * Every query in this adapter goes through here.
   *
   * `asSystem` rather than a user scope, for the reason in the class comment:
   * authentication runs before there is a user, so a policy that scopes by one
   * cannot be satisfied and deny-by-default would turn a failed sign-in into a
   * server error. One wrapper, applied uniformly, so no method can forget.
   */
  protected run<T>(fn: () => Promise<T>): Promise<T> {
    return this.models.User.asSystem(fn);
  }

  /**
   * Note the password is **removed from the returned object**, matching Prisma's
   * adapter, which uses `omit: { password: true }`.
   *
   * This is not defensive tidying. `auth/routes.ts` maps `POST /sign-up` to
   * `AuthController.signUp`, and that handler ends `return newUser` — so whatever
   * `createUser` returns *is the response body of an unauthenticated endpoint*.
   * The same object reaches `config.onSignUp`, so an application hook that logs
   * its argument would log a credential hash.
   *
   * An earlier version returned the row whole and documented the difference on
   * the class, on the grounds that emulating `omit` with a `select` naming every
   * other column would drift as the schema grows. That objection is fair and this
   * avoids it entirely: deleting the key needs no column list and cannot drift.
   * It also brings `createUser` in line with `SESSION_USER` above, which already
   * names its columns explicitly for exactly this reason.
   */
  async createUser(args: CreateUserArgs): Promise<User> {
    const user: User = await this.run(() =>
      this.models.User.create({ data: args }),
    );
    return withoutPassword(user);
  }

  async updateUserPassword(args: UpdateUserPasswordArgs): Promise<User> {
    // Same treatment. No path was found that serialises this one, but a method
    // whose entire purpose is to set a password should not hand it back — and
    // "no path today" is not a property that stays true.
    const user: User = await this.run(() =>
      this.models.User.update({
        where: { id: args.id },
        data: { password: args.password },
      }),
    );
    return withoutPassword(user);
  }

  async findUserByEmailAddress(
    email: string,
    verifyEmail: boolean,
  ): Promise<User> {
    return await this.run(() =>
      // A `WhereUniqueInput` carrying an extra non-unique filter, which Prisma 5
      // allows and the ORM honours for `findUnique` — the key is present, and
      // `emailVerifiedAt` narrows further. See `compile/unique.ts`.
      this.models.User.findUnique({
        where: verifyEmail
          ? { email, emailVerifiedAt: { not: null } }
          : { email },
      }),
    );
  }

  async findUserByVerificationToken(token: string): Promise<User | null> {
    return await this.run(() =>
      this.models.User.findFirst({ where: { verificationToken: token } }),
    );
  }

  async verifyUser(email: string): Promise<User> {
    return await this.run(() =>
      this.models.User.update({
        where: { email },
        data: { emailVerifiedAt: new Date() },
      }),
    );
  }

  async createSession(args: CreateSessionArgs): Promise<SessionWithUser> {
    return await this.run(() =>
      this.models.Session.create({ data: args, include: { user: true } }),
    );
  }

  async createSessionV2(args: CreateSessionArgs): Promise<SessionWithUser> {
    return await this.run(() =>
      this.models.Session.create({
        data: args,
        select: { token: true, expiresAt: true, absoluteExpiresAt: true, updatedAt: true, location: true, userAgent: true, user: SESSION_USER },
      }),
    );
  }

  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    if (!args.token) return null;

    // `findUnique` returns null on no match rather than raising, so the
    // try/catch Prisma's adapter wraps this in is not needed for the
    // not-found case. It is kept for the *connection* case — a sign-in path
    // that throws on a database blip becomes a 500 where returning null is a
    // redirect to the login page. The error is logged rather than swallowed
    // silently.
    try {
      return await this.run(() =>
        this.models.Session.findUnique({
          where: { token: args.token },
          select: {
            token: true,
            expiresAt: true,
            absoluteExpiresAt: true,
            updatedAt: true,
            location: true,
            userAgent: true,
            user: SESSION_USER,
          },
        }),
      );
    } catch (error) {
      console.error("findSession failed:", error);
      return null;
    }
  }

  async updateSession(
    args: UpdateSessionArgs,
  ): Promise<SessionWithUser | null> {
    return await this.run(() =>
      this.models.Session.update({
        where: { token: args.token },
        data: { expiresAt: args.expiresAt },
        select: {
          token: true,
          expiresAt: true,
          absoluteExpiresAt: true,
          updatedAt: true,
          location: true,
          userAgent: true,
          user: SESSION_USER,
        },
      }),
    );
  }

  async deleteSession(args: DeleteSessionArgs): Promise<void> {
    // `deleteMany`, not `delete`: signing out twice must not raise, and `delete`
    // raises when nothing matched.
    await this.run(() =>
      this.models.Session.deleteMany({ where: { token: args.token } }),
    );
  }

  async deleteAllUserSessions(userId: number): Promise<void> {
    await this.run(() =>
      this.models.Session.deleteMany({ where: { userId } }),
    );
  }

  async createPasswordResetToken(
    args: CreatePasswordResetTokenArgs,
  ): Promise<string> {
    // A nested `connect`, which iteration 4 supports on the owning side — the
    // foreign key is on this row, so it becomes a bound column with no extra
    // query when the connect names the referenced field.
    return await this.run(() =>
      this.models.PasswordResetToken.create({
        data: { token: args.token, user: { connect: { id: args.user.id } } },
      }),
    );
  }

  async findPasswordResetToken(
    args: FindPasswordResetTokenArgs,
  ): Promise<PasswordResetToken | null> {
    return await this.run(() =>
      this.models.PasswordResetToken.findUnique({
        where: { token: args.token },
        include: { user: true },
      }),
    );
  }

  async deletePasswordResetToken(
    args: DeletePasswordResetTokenArgs,
  ): Promise<string> {
    return await this.run(() =>
      this.models.PasswordResetToken.delete({ where: { token: args.token } }),
    );
  }

  async findInvitation(
    invitationId: string,
    email: string,
  ): Promise<Invitation> {
    return await this.run(() =>
      this.models.OrganizationInvitation.findFirst({
        where: { publicId: invitationId, email },
      }),
    );
  }

  async deleteInvitationById(invitationId: string): Promise<void> {
    await this.run(() =>
      this.models.OrganizationInvitation.delete({
        where: { publicId: invitationId },
      }),
    );
  }

  async createAccount(args: CreateAccountArgs): Promise<Account | null> {
    return await this.run(() =>
      this.models.Account.create({
        data: {
          userId: args.userId,
          organizationId: args.organizationId,
          organizationRole: args.organizationRole,
        },
      }),
    );
  }

  async createMagicLinkToken(
    args: CreateMagicLinkTokenArgs,
  ): Promise<{ token: string; pin: string }> {
    return await this.run(() =>
      this.models.MagicLinkToken.create({
        data: { email: args.email, token: args.token, pin: args.pin },
      }),
    );
  }

  async findUserMagicLinkToken(args: {
    token?: string;
    pin?: string;
    email: string;
  }): Promise<User | null> {
    // Prisma's compound-unique form: one key named after the fields joined by
    // `_`. The schema declares `@@unique([token, email])` and
    // `@@unique([pin, email])`, so which one is used depends on what the caller
    // has — a link click carries the token, a typed code carries the pin.
    return await this.run(() =>
      args.token
        ? this.models.MagicLinkToken.findUnique({
            where: { token_email: { token: args.token, email: args.email } },
          })
        : this.models.MagicLinkToken.findUnique({
            where: { pin_email: { pin: args.pin, email: args.email } },
          }),
    );
  }

  async deleteMagicLinkToken(email: string): Promise<void> {
    await this.run(() =>
      this.models.MagicLinkToken.deleteMany({ where: { email } }),
    );
  }

  async createSocialAccount(args: CreateSocialAccountArgs): Promise<any> {
    return await this.run(() =>
      this.models.SocialAccount.create({ data: args }),
    );
  }
}

/**
 * Builds the adapter from the ORM's registry, for an application that has
 * imported `app/models/generated`.
 *
 * By name rather than by import, for the reason the registry exists at all: the
 * generated classes live in the application and the framework cannot import
 * them. Resolved lazily, at first use, so the order of module evaluation does
 * not matter — the same property `registry.get` provides everywhere else.
 */
export function ormAuthenticationAdapter(
  models: typeof registry,
): OrmAuthenticationAdapter {
  return new OrmAuthenticationAdapter(
    new Proxy({} as AuthModels, {
      get: (_target, name: string) => models.get(name),
    }),
  );
}
