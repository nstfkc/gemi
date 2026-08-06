import * as registry from "../orm/registry";
import type {
  Account,
  AuthModels,
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
  Invitation,
  PasswordResetToken,
  SessionWithUser,
  UpdateSessionArgs,
  UpdateUserPasswordArgs,
  User,
} from "./types";

/**
 * Everything `auth/` reads and writes — users, sessions, tokens — on the gemi
 * ORM. Named after `Illuminate\Contracts\Auth\UserProvider`, which is also where
 * the `AuthManager.userProvider` accessor gets its name.
 *
 * ## Why this is a class and not an interface
 *
 * It used to be one of three interchangeable `IAuthenticationAdapter`
 * implementations — blank, Prisma, and this. That seam is gone. The framework
 * ships an ORM, and auth persistence on it is not a choice an application should
 * have to make before it can log anybody in; the pluggable version meant a
 * default that threw `AdapterNotFound` and a starter template that reached for
 * Prisma to get past it.
 *
 * What the seam actually bought was reachable more cheaply. An application that
 * needs different behaviour subclasses this and overrides the methods it cares
 * about — the queries are twenty-two small independent methods, all funnelled
 * through `run`, precisely the shape that subclasses well. What it no longer
 * buys is a *different database*, and that is deliberate: an app on the ORM has
 * one.
 *
 * Note what was **not** done here. Writing these methods against `DB`/raw SQL
 * would mean twenty-two methods of per-dialect SQL across SQLite and Postgres —
 * the hand-written `SqlUserProvider` PR #33 proposed, dropped in favour of
 * building the ORM first. That reasoning did not stop applying when the adapter
 * seam went away. Twenty-two methods of per-dialect SQL is exactly what a
 * compiler is for.
 *
 * ## Why the models are injected rather than imported
 *
 * The ORM resolves models by *name* through a registry, and the generated classes
 * live in the application (`app/models/generated`), not in the framework. So this
 * cannot import `User` — there is no such module here. It takes the model
 * classes it needs, defaulting to the registry, which also makes it testable
 * against fixtures and lets an application point it at its own subclasses (the
 * ones carrying policies, which matters: see the note on `asSystem` below).
 *
 * ## Two behaviours worth knowing
 *
 * **Policies are suspended.** Every query here runs inside `Model.asSystem`.
 * Authentication happens *before* there is an authenticated user, so a policy
 * that scopes by `ctx.user` cannot be satisfied — and under deny-by-default it
 * would raise rather than return null, turning "wrong password" into a 500. This
 * is the one place in an application where acting without a user is correct
 * rather than a mistake, so it says so explicitly at the call site, which is what
 * `asSystem` is for.
 *
 * **`password` is stripped from returned users.** The ORM does not implement
 * `omit`, so it is deleted from the returned object rather than excluded by the
 * query — see `createUser` for why that is the right shape and why it matters:
 * `POST /sign-up` returns this object as its response body.
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

/**
 * The models, resolved from the ORM registry by name.
 *
 * Lazily, through a Proxy, so the order of module evaluation does not matter —
 * the same property `registry.get` provides everywhere else. Constructing a
 * `UserProvider` therefore does not require the application's models to have
 * been imported yet; only *calling* one of its methods does.
 *
 * When they never are, `registry.get` throws `ModelNotRegisteredError`, which
 * names the model and lists what is registered. That is the replacement for the
 * old `BlankAdapter`, and a better one: it says which model is missing instead
 * of `AdapterNotFound`.
 */
function registryModels(): AuthModels {
  return new Proxy({} as AuthModels, {
    get: (_target, name: string) => registry.get(name),
  });
}

/**
 * The user shape the rest of `auth/` expects on a session.
 *
 * Spelled out rather than `include: { user: true }` because `User` in
 * `./types.ts` carries `accounts[].organization`, which is a relation two levels
 * down — and because naming the columns is what keeps the *session* queries from
 * selecting `password` into something that is handed to a client.
 *
 * **Organizations come from the accounts, not from a column on `User`.** A user
 * belongs to an organization by having an `Account` in it, which is the shape
 * the rest of `auth/` already writes: `AuthController`'s invited sign-up creates
 * the membership with `createAccount`, and nothing in this file has ever set an
 * organization on the user row.
 *
 * This used to also select `User.organizationId`. Nothing in the framework read
 * it — it was selected here and nowhere else — and selecting it made every
 * application's `User` table have to carry the starter template's column: a
 * schema without it fails `UnknownFieldError` inside `findSession`, which
 * catches, logs, and returns null, so every request looks like an expired
 * session rather than a misconfiguration.
 *
 * Note for a policy that scopes by tenant: `ctx.user.organizationId` is
 * therefore no longer a thing to read. Scope through the membership —
 * `{ accounts: { some: { organizationId: … } } }` — and take the organization
 * from `user.accounts`. A scope naming a key the session user does not carry
 * evaluates to `undefined`, which is an *absent* filter rather than an error.
 */
const SESSION_USER = {
  select: {
    id: true,
    publicId: true,
    email: true,
    name: true,
    locale: true,
    globalRole: true,
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

export class UserProvider {
  /**
   * Defaults to the ORM registry, so an application needs no configuration to
   * get working authentication. Pass models explicitly to test against fixtures
   * or to point at subclasses carrying policies.
   */
  constructor(protected models: AuthModels = registryModels()) {}

  /**
   * Every query in this class goes through here.
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

