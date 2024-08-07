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
} from "./types";

export class PrismaAuthenticationAdapter implements IAuthenticationAdapter {
  constructor(private prisma: any) {}

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

  async findUserByEmailAddress(email: string): Promise<User> {
    return await this.prisma.user.findUnique({ where: { email } });
  }

  // TODO: extend the session until absolute expiration
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    if (!args.token) return null;
    try {
      const session = await this.prisma.session.findUnique({
        where: { token: args.token, userAgent: args.userAgent },
        include: {
          user: {
            select: {
              email: true,
              globalRole: true,
              name: true,
              publicId: true,
              accounts: true,
              organization: true,
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
            email: true,
            globalRole: true,
            name: true,
            publicId: true,
            accounts: true,
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
}
