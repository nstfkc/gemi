import type { HttpRequest } from "../http/HttpRequest";
import type { IAuthenticationAdapter, User } from "./adapters/types";
import { BlankAdapter } from "./adapters/blank";
import type { OAuthProvider } from "./oauth/OAuthProvider";
import { SignUpRequest } from "./requests";

// Config key: `auth`.
export interface AuthConfig {
  basePath?: string;
  verifyEmail?: boolean;
  redirectPath?: string;

  sessionExpiresInHours?: number;
  sessionAbsoluteExpiresInHours?: number;

  signUpRequest?: new () => HttpRequest<any, any>;
  // The user provider: everything that reads and writes users, sessions and
  // tokens. Named after `Illuminate\Contracts\Auth\UserProvider`.
  userProvider?: IAuthenticationAdapter;
  oauthProviders?: Record<string, OAuthProvider>;

  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
  hashPassword?: (password: string) => Promise<string>;
  generateForgotPasswordToken?: (user: User) => Promise<string>;
  generateEmailVerificationToken?: (
    email: string,
  ) => Promise<string> | string;
  generateMagicLinkToken?: (email: string) => Promise<string> | string;

  // Extra claims merged into the session payload.
  extendSession?: <T extends User>(user: T) => Promise<any> | any;

  onSignUp?: (
    user: User,
    verificationToken: string,
    search: Record<string, string>,
  ) => Promise<void> | void;
  onSignIn?: (
    session: any,
    search: Record<string, string>,
  ) => Promise<void> | void;
  onSignOut?: (session: any) => Promise<void> | void;
  onForgotPassword?: (
    user: any,
    verificationToken: string,
  ) => Promise<void> | void;
  onResetPassword?: (session: any) => Promise<void> | void;
  onMagicLinkCreated?: (
    session: any,
    args: { email: string; token: string; pin: string },
  ) => Promise<void> | void;
}

export function defineAuthConfig(config: AuthConfig): AuthConfig {
  return config;
}

// `generateEmailVerificationToken`'s default short-circuits on `verifyEmail`,
// so the already-merged config is threaded in to keep that behaviour intact.
export function authConfigDefaults(
  config: AuthConfig = {},
): Required<AuthConfig> {
  return {
    basePath: "/auth",
    verifyEmail: true,
    redirectPath: "/dashboard",

    sessionExpiresInHours: 24,
    sessionAbsoluteExpiresInHours: 24 * 7 * 4,

    signUpRequest: SignUpRequest as any,
    // @ts-ignore
    userProvider: new BlankAdapter(),
    oauthProviders: {},

    verifyPassword: async (password, hash) =>
      await Bun.password.verify(password, hash),
    hashPassword: async (password) => await Bun.password.hash(password),
    generateForgotPasswordToken: async (user) => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(`${user.email}${Date.now()}`);
      return hasher.digest("hex");
    },
    generateEmailVerificationToken: (email) => {
      if (!(config.verifyEmail ?? true)) {
        return "";
      }
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(`${email}${Date.now()}`);
      return hasher.digest("hex");
    },
    generateMagicLinkToken: (email) => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(`${email}${Date.now()}`);
      return hasher.digest("hex");
    },

    extendSession: () => ({}),

    onSignUp: () => {},
    onSignIn: () => {},
    onSignOut: () => {},
    onForgotPassword: () => {},
    onResetPassword: () => {},
    onMagicLinkCreated: () => {},
  };
}
