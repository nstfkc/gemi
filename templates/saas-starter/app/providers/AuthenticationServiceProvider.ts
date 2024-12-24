import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";
import { GoogleOAuthProvider } from "gemi/services";

import { prisma } from "../database/prisma";

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);
  verifyEmail = false;

  oauthProviders = {
    google: new GoogleOAuthProvider(),
  };

  extendSession(_user: any) {
    return {
      testId: "1234",
    };
  }

  onSignUp(user: any, token: string) {
    console.log("User sign up", user.email, user.locale, token);
  }

  onForgotPassword(user: any, token: string) {
    console.log("Forgot password email sent", user.email, token);
  }

  onMagicLinkCreated(user: any, args: any) {
    console.log("Magic link created", user.email, args);
  }
}
