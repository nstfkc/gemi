export interface IAuthenticationAdapter {
  createUser: (args: CreateUserArgs) => Promise<User>;
  updateUserPassword: (args: UpdateUserPasswordArgs) => Promise<User>;
  createSession: (args: CreateSessionArgs) => Promise<SessionWithUser>;
  updateSession: (args: UpdateSessionArgs) => Promise<SessionWithUser>;
  findSession: (args: FindSessionArgs) => Promise<SessionWithUser>;
  deleteSession: (args: DeleteSessionArgs) => Promise<void>;
  findUserByEmailAddress: (email: string) => Promise<User>;
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
}

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

export interface User {
  id: number;
  publicId: string;
  name: string | null;
  email: string | null;
  emailVerifiedAt: Date | null;
  globalRole: number;
  password: string | null;
  organizationId: number | null;
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
  password: string;
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
