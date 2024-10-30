import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";
import { prisma } from "../database/prisma";
import type { User } from "@prisma/client";

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);

  extendSession(_user: any) {
    return {
      testId: "1234",
    };
  }

  onSignUp(user: User, token: string) {
    console.log("User sign up", user.email, user.locale, token);
  }

  onForgotPassword(user: User, token: string) {
    console.log("Forgot password email sent", user.email, token);
  }
}
