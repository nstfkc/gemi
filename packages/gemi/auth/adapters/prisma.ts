import type {
  User,
  CreateSessionArgs,
  DeleteSessionArgs,
  SessionWithUser,
  CreateUserArgs,
  FindSessionArgs,
  UpdateSessionArgs,
  IAuthenticationAdapter,
  CreatePasswordResetTokenArgs,
  PasswordResetToken,
  FindPasswordResetTokenArgs,
  DeletePasswordResetTokenArgs,
  CreateAccountArgs,
} from "./types";

export class PrismaAuthenticationAdapter implements IAuthenticationAdapter {
  constructor(private prisma: any) {}

  async findUserByVerificationToken(token: string): Promise<User | null> {
    return await this.prisma.user.findFirst({
      where: { verificationToken: token },
    });
  }

  async verifyUser(userId: number): Promise<User> {
    return await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
  }

  async createSession(args: CreateSessionArgs): Promise<SessionWithUser> {
    return await this.prisma.session.create({
      data: args,
      include: { user: true },
    });
  }

  async createUser(args: CreateUserArgs): Promise<User> {
    return await this.prisma.user.create({ data: args });
  }

  async deleteSession(args: DeleteSessionArgs): Promise<void> {
    return await this.prisma.session.deleteMany({
      where: { token: args.token },
    });
  }

  async findUserByEmailAddress(email: string, verify: boolean): Promise<User> {
    if (verify) {
      return await this.prisma.user.findUnique({
        where: { email, emailVerifiedAt: { not: null } },
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    return user;
  }

  // TODO: extend the session until absolute expiration
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    if (!args.token) return null;
    try {
      const session = await this.prisma.session.findUnique({
        where: {
          token: args.token,
          userAgent:
            process.env.NODE_ENV === "development" ? "local" : args.userAgent,
        },
        include: {
          user: {
            select: {
              password: false,
              id: true,
              email: true,
              globalRole: true,
              name: true,
              publicId: true,
              accounts: {
                select: {
                  id: true,
                  publicId: true,
                  organization: true,
                  organizationRole: true,
                },
              },
            },
          },
        },
      });

      return session;
    } catch (err) {
      console.log(err);
      return null;
    }
  }

  async updateSession(
    args: UpdateSessionArgs,
  ): Promise<SessionWithUser | null> {
    return await this.prisma.session.update({
      where: { token: args.token },
      data: { expiresAt: args.expiresAt },
      include: {
        user: {
          select: {
            password: false,
            email: true,
            globalRole: true,
            name: true,
            publicId: true,
            accounts: {
              select: {
                id: true,
                publicId: true,
                organization: true,
                organizationRole: true,
              },
            },
            organization: true,
          },
        },
      },
    });
  }

  async updateUserPassword(args: {
    id: number;
    password: string;
  }): Promise<User> {
    return await this.prisma.user.update({
      where: { id: args.id },
      data: { password: args.password },
    });
  }

  async createPasswordResetToken(args: CreatePasswordResetTokenArgs) {
    return await this.prisma.passwordResetToken.create({
      data: {
        user: { connect: { id: args.user.id } },
        token: args.token,
      },
    });
  }

  async findPasswordResetToken(
    args: FindPasswordResetTokenArgs,
  ): Promise<PasswordResetToken | null> {
    const { token } = args;
    return await this.prisma.passwordResetToken.findUnique({
      where: { token },
      include: { user: true },
    });
  }

  async deleteAllUserSessions(userId: number) {
    return await this.prisma.session.deleteMany({ where: { userId } });
  }

  async deletePasswordResetToken(args: DeletePasswordResetTokenArgs) {
    const { token } = args;
    return await this.prisma.passwordResetToken.delete({ where: { token } });
  }

  async createAccount(args: CreateAccountArgs) {
    return await this.prisma.account.create({
      data: {
        organizationId: args.organizationId,
        organizationRole: args.organizationRole,
        userId: args.userId,
      },
    });
  }

  async deleteInvitationById(invitationId: string) {
    return await this.prisma.organizationInvitation.delete({
      where: { publicId: invitationId },
    });
  }

  async findInvitation(invitationId: string, email: string) {
    return await this.prisma.organizationInvitation.findFirst({
      where: { publicId: invitationId, email },
    });
  }

  async createMagicLinkToken(args: {
    email: string;
    token: string;
    pin: string;
  }) {
    return await this.prisma.magicLinkToken.create({
      data: {
        email: args.email,
        token: args.token,
        pin: args.pin,
      },
    });
  }

  async findUserByMagicLinkToken(args: {
    token?: string;
    pin?: string;
    email: string;
  }) {
    const { token, pin, email } = args;

    if (token) {
      return this.prisma.magicLinkToken.findUnique({
        where: {
          token_email: {
            email,
            token,
          },
        },
      });
    } else {
      return await this.prisma.magicLinkToken.findUnique({
        where: {
          pin_email: {
            email,
            pin,
          },
        },
      });
    }
  }

  async deleteMagicLinkToken(email: string) {
    return await this.prisma.magicLinkToken.deleteMany({
      where: { email },
    });
  }
}
