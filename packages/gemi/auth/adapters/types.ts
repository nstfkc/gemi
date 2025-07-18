export interface IAuthenticationAdapter {
  createUser: (args: CreateUserArgs) => Promise<User>;
  updateUserPassword: (args: UpdateUserPasswordArgs) => Promise<User>;
  createSession: (args: CreateSessionArgs) => Promise<SessionWithUser>;
  createSessionV2: (args: CreateSessionArgs) => Promise<SessionWithUser>;
  updateSession: (args: UpdateSessionArgs) => Promise<SessionWithUser | null>;
  findSession: (args: FindSessionArgs) => Promise<SessionWithUser | null>;
  deleteSession: (args: DeleteSessionArgs) => Promise<void>;
  findUserByEmailAddress: (
    email: string,
    verifyEmail: boolean,
  ) => Promise<User>;
  createPasswordResetToken: (
    args: CreatePasswordResetTokenArgs,
  ) => Promise<string>;
  deletePasswordResetToken: (
    args: DeletePasswordResetTokenArgs,
  ) => Promise<string>;
  findPasswordResetToken: (
    args: FindPasswordResetTokenArgs,
  ) => Promise<PasswordResetToken | null>;
  deleteAllUserSessions: (userId: number) => Promise<void>;
  findUserByVerificationToken: (token: string) => Promise<User | null>;
  verifyUser: (email: string) => Promise<User>;
  findInvitation: (invitationId: string, email: string) => Promise<Invitation>;
  deleteInvitationById: (invitationId: string) => Promise<void>;
  createAccount: (args: CreateAccountArgs) => Promise<Account | null>;
  createMagicLinkToken: (
    args: CreateMagicLinkTokenArgs,
  ) => Promise<{ token: string; pin: string }>;
  findUserMagicLinkToken: (args: {
    token?: string;
    pin?: string;
    email: string;
  }) => Promise<User | null>;
  deleteMagicLinkToken: (email: string) => Promise<void>;
  createSocialAccount: (args: CreateSocialAccountArgs) => Promise<any>;
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

export interface User {
  id: number;
  publicId: string;
  name: string | null;
  email: string | null;
  emailVerifiedAt: Date | null;
  globalRole: number;
  password: string | null;
  organizationId: number | null;
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
