import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";
import { prisma } from "../database/prisma";

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);
  verifyEmail = false;

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
}
