import { defineAuthConfig, GoogleOAuthProvider } from "gemi/services";
import { Auth } from "gemi/facades";

import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { SignUpRequest } from "@/app/http/requests/SignUpRequest";

export default defineAuthConfig({
  oauthProviders: {
    google: new GoogleOAuthProvider(),
  },

  // Path to redirect after successful login
  redirectPath: "/dashboard",
  signUpRequest: SignUpRequest,

  sessionExpiresInHours: 999,
  sessionAbsoluteExpiresInHours: 999,

  // Change this to true to only allow verified emails to login
  verifyEmail: false,

  async onUserCreated(user: any) {
    // This hook runs *inside* the transaction that creates the user, before it
    // commits — provision an organization, a workspace, a default settings row
    // here, and a throw rolls the user back with them. ORM queries join the
    // transaction automatically; raw ones do not. Keep email and other I/O in
    // `onSignUp` below, which fires after the commit.
    //
    // A sign-up has no authenticated user yet, so writes to a model carrying a
    // policy have to say so: `Model.asSystem(() => Organization.create(...))`.
    // Without it they raise `PolicyDeniedError` and the sign-up fails.
  },

  async onSignUp(user: any, token: string) {
    // This hook will be called when a user signs up
    // You can send email verification here
    const magicLink = await Auth.createMagicLink(user.email);
    if (magicLink) {
      WelcomeEmail.send({
        data: {
          name: user.name,
          magicLink: `${process.env.HOST_NAME}/auth/sign-in/magic-link?token=${magicLink.token}&email=${user.email}`,
          pin: magicLink.pin ?? "",
        },
        to: [user.email],
      });
    }
  },

  async onForgotPassword(user: any, token: string) {
    // This hook will be called when a user requests a password reset
    // You can send password reset email here
  },

  async onMagicLinkCreated(session: any, args: any) {
    // This hook will be called when a magic link is created
    // You can send magic link email here
  },
});
