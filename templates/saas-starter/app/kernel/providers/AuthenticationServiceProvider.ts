import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";
import { GoogleOAuthProvider, XOAuthProvider } from "gemi/services";

import { prisma } from "@/app/database/prisma";
import { Auth } from "gemi/facades";

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);

  oauthProviders = {
    google: new GoogleOAuthProvider(),
    x: new XOAuthProvider(),
  };

  async onSignUp(user: any, token: string) {
    const magicLink = await Auth.createMagicLink(user.email);
    if (magicLink) {
      console.log(magicLink);
      const { email, pin, token, user } = magicLink;
      const url = new URL(`${process.env.HOST_NAME}/auth/sign-in/magic-link`);
      url.searchParams.set("token", magicLink.token);
      url.searchParams.set("email", magicLink.email);
      console.log({ magicLink: url.toString() });
    }

    console.log("User sign up", user.email, user.locale, token);
  }

  onForgotPassword(user: any, token: string) {
    console.log("Forgot password email sent", user.email, token);
  }

  onMagicLinkCreated(user: any, args: any) {
    console.log("Magic link created", user.email, args);
  }
}
