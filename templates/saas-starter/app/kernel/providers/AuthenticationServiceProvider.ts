import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";

import { prisma } from "@/app/database/prisma";

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);
  verifyEmail = false;

  async onSignUp(user: any, token: string) {
    // Send email verification
  }

  onForgotPassword(user: any, token: string) {
    // send forgot password email
  }

  onMagicLinkCreated(user: any, args: any) {
    // send magic link email
  }
}
