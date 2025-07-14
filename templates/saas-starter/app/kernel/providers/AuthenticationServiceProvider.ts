import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";
import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { Auth } from "gemi/facades";
import { prisma } from "@/app/database/prisma";
import { HttpRequest } from "gemi/http";

class SignUpRequest extends HttpRequest {
  schema = {
    name: {
      string: "Invalid name",
      "min:2": "Name must be at least 3 characters",
    },
    email: {
      string: "Invalid email",
      required: "Email is required",
      "max:2": "Name must be at least 3 characters",
      email: "Invalid email",
    },
    password: {
      // required: "Password is required",
      "min:8": "Password must be at least 8 characters",
    },
  };
}

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);

  // Path to redirect after successful login
  redirectPath = "/app/dashboard";
  signUpRequest = SignUpRequest;

  // Adapt these options to your needs
  sessionExpiresInHours = 24 * 30; // 30 days
  // Sessions will be renewed if the user logs in within this time frame
  sessionAbsoluteExpiresInHours = 24 * 30 * 6; // 6 months

  // Change this true to only allow verified emails to login
  verifyEmail = false;

  async onSignUp(user: any, token: string) {
    // This hook will be called when a user signs up
    // You can send email verification here
    const magicLink = await Auth.createMagicLink(user.email);
    if (magicLink) {
      WelcomeEmail.send({
        data: {
          name: user.name,
          magicLink: `${process.env.HOST_NAME}/auth/sign-in/magic-link?token=${magicLink.token}&email=${user.email}`,
          pin: magicLink.pin,
        },
        to: [user.email],
      });
    }
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
