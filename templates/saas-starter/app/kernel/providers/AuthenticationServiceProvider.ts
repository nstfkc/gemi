import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";
import { WelcomeEmail } from "@/app/email/WelcomeEmail";

import { prisma } from "@/app/database/prisma";

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);

  // Adapt these options to your needs
  sessionExpiresInHours = 24 * 30; // 30 days
  // Sessions will be renewed if the user logs in within this time frame
  sessionAbsoluteExpiresInHours = 24 * 30 * 6; // 6 months

  // Change this true to only allow verified emails to login
  verifyEmail = false;

  async onSignUp(user: any, token: string) {
    // This hook will be called when a user signs up
    // You can send email verification here
    WelcomeEmail.send({ data: { name: user.name }, to: [user.email] });
  }

  async onForgotPassword(user: any, token: string) {
    // This hook will be called when a user requests a password reset
    // You can send password reset email here
  }

  async onMagicLinkCreated(user: any, args: any) {
    // This hook will be called when a magic link is created
    // You can send magic link email here
  }
}
