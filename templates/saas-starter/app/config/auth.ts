import { defineAuthConfig, GoogleOAuthProvider } from "gemi/services";
import { PrismaAuthenticationAdapter } from "gemi/kernel";
import { Auth } from "gemi/facades";

import { prisma } from "@/app/database/prisma";
import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { SignUpRequest } from "@/app/http/requests/SignUpRequest";

export default defineAuthConfig({
  userProvider: new PrismaAuthenticationAdapter(prisma),

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
