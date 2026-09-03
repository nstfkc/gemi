import { defineAuthConfig } from "gemi/services";

export default defineAuthConfig({
  // Where a successful sign-in lands. The chat lives behind `auth`, so this is
  // also where a signed-out visitor is sent back to once they have signed in.
  redirectPath: "/chat",

  sessionExpiresInHours: 999,
  sessionAbsoluteExpiresInHours: 999,

  // Flip to true to require a verified email before sign-in.
  verifyEmail: false,

  // Both hooks are stubs, so their parameters are underscore-prefixed to keep
  // the linter quiet. Drop the underscore when you start using one — the names
  // are what the framework passes, not decoration.
  async onUserCreated(_user: any) {
    // Runs inside the transaction that creates the user, before it commits —
    // provision a workspace or a default settings row here and a throw rolls
    // the user back with them. Keep email and other I/O in `onSignUp`.
  },

  async onSignUp(_user: any, _token: string) {
    // Fires after the commit. Send the verification mail from here.
  },
});
