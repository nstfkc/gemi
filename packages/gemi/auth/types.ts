/**
 * The data `auth/` reads and writes. Types only — the queries live in
 * `UserProvider`.
 *
 * These sit here rather than beside it because `User` in particular travels well
 * past authentication: `facades/Auth.ts` returns it and
 * `client/ServerDataProvider.tsx` puts it on the page. A module that owns both
 * the shape and the SQL would make those importers depend on the ORM.
 */

/** The generated model classes `UserProvider` needs, by their Prisma names. */
export interface AuthModels {
  User: any;
  Session: any;
  Account: any;
  PasswordResetToken: any;
  MagicLinkToken: any;
  OrganizationInvitation: any;
  SocialAccount: any;
}

export type CreateSocialAccountArgs = {
  email?: string;
  provider: string;
  providerId: string;
  username?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  userId?: number;
};

export type Invitation = {
  organizationId: number;
  role: number;
};

export type CreateAccountArgs = {
  userId: number;
  organizationId: number;
  organizationRole: number;
};

export interface PasswordResetToken {
  token: string;
  userId: number;
  createdAt: Date;
  user: User;
}

export interface FindPasswordResetTokenArgs {
  token: string;
}

export interface DeletePasswordResetTokenArgs {
  token: string;
}

export interface CreatePasswordResetTokenArgs {
  user: User;
  token: string;
}

export type Organization = {
  id: number;
  publicId: string;
  name: string;
};

export type Account = {
  id: number;
  publicId: string;
  name: string;
  organizationRole: number;
  organization: Organization;
};

/**
 * A user's organizations are reached through `accounts`, each of which carries
 * the organization it is a membership in. There is deliberately no
 * `organizationId` here: a user may be in more than one organization, so a
 * single column could not answer the question, and `SESSION_USER` no longer
 * selects one — see the note there.
 */
export interface User {
  id: number;
  publicId: string;
  name: string | null;
  email: string | null;
  emailVerifiedAt: Date | null;
  globalRole: number;
  password: string | null;
  accounts: Account[];
  // TODO: Add type
  extension: Record<string, any>;
}

export interface CreateSessionArgs {
  token: string;
  userId: number;
  location?: string;
  userAgent: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface SessionWithUser {
  user: User;
  token: string;
  expiresAt: Date;
  updatedAt: Date;
  absoluteExpiresAt: Date;
  location: string;
  userAgent: string;
}

export interface CreateUserArgs {
  name: string;
  email: string;
  password?: string;
  verificationToken?: string;
  emailVerifiedAt?: Date;
  locale?: string;
}

export interface UpdateUserPasswordArgs {
  id: number;
  password: string;
}

export interface DeleteSessionArgs {
  token: string;
}

export interface FindSessionArgs {
  token: string;
  userAgent: string;
}

export interface UpdateSessionArgs {
  expiresAt: Date;
  token: string;
}

export interface CreateMagicLinkTokenArgs {
  email: string;
  token: string;
  pin: string;
}
