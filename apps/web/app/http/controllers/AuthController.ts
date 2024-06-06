import { sign } from "jsonwebtoken";

import { prisma } from "@/app/database/prisma";
import { Controller } from "@/framework/Controller";
import { Auth } from "@/framework/facades/Auth";
import { HttpRequest } from "@/framework/http/HttpRequest";
import { ValidationError } from "@/framework/Router";
import { Redirect } from "@/framework/facades/Redirect";

type SignUpRequestInput = {
  email: string;
  name: string;
  password: string;
};

class SignUpRequest extends HttpRequest<SignUpRequestInput> {
  schema = {
    email: {
      required: "Email is required",
      email: "Email is invalid",
    },
    name: {
      required: "Name is required",
      "min:3": "Name must be at least 3 characters",
    },
    password: {
      required: "Password is required",
      password:
        "Password must be at least 8 characters, contain at least one uppercase letter, one lowercase letter, one number, and one special character",
    },
  };
}

type SignInRequestInput = {
  email: string;
  password: string;
};

class SignInRequest extends HttpRequest<SignInRequestInput> {
  schema = {
    email: {
      required: "Email is required",
      email: "Email is invalid",
    },
    password: {
      required: "Password is required",
      password:
        "Password must be at least 8 characters, contain at least one uppercase letter, one lowercase letter, one number, and one special character",
    },
  };
}

export class AuthController extends Controller {
  override requests = {
    signUp: SignUpRequest,
    signIn: SignInRequest,
  };

  public signInView() {
    const user = Auth.user();
    if (user) {
      Redirect.to(`/organisation/${user.accounts[0].organizationId}/dashboard`);
    }
    return {};
  }

  public signUpView() {
    const user = Auth.user();
    if (user) {
      Redirect.to(`/organisation/${user.accounts[0].organizationId}/dashboard`);
    }
    return {};
  }

  public async me() {
    return {
      data: {
        user: Auth.user(),
      },
    };
  }

  public async signIn(req: SignInRequest) {
    const input = await req.input();
    const { email, password } = input.toJSON();
    const user = await prisma.user.findFirst({
      where: { email },
      select: {
        accounts: { include: { organization: true } },
        password: true,
        globalRole: true,
        name: true,
        email: true,
        id: true,
      },
    });
    if (!user) {
      return {
        data: {
          error: {
            kind: "form_error",
            message: "Invalid credentials",
          },
        },
        status: 400,
      };
    }

    const passwordMatches = await Bun.password.verify(password, user.password!);

    if (passwordMatches) {
      const accessToken = sign({ userId: user.id }, "SECRET");
      const { password: _, ..._user } = user;
      return {
        data: {
          user: _user,
        },
        cookies: {
          accessToken: { value: accessToken, maxAge: 60 * 1000 * 60 },
        },
      };
    }

    return {
      data: {
        error: {
          kind: "form_error",
          message: "Invalid credentials",
        },
      },
      status: 400,
    };
  }

  public async signOut() {
    return {
      data: {
        success: true,
      },
      cookies: {
        accessToken: { value: "", maxAge: 0 },
      },
    };
  }

  public async signUp(req: SignUpRequest) {
    const input = await req.input();
    const { email, name, password } = input.toJSON();

    try {
      await prisma.user.create({
        data: {
          email,
          name,
          password: await Bun.password.hash(password),
        },
      });
    } catch (err) {
      throw new ValidationError({
        email: ["There is an account with this email address"],
      });
    }
    return {
      data: {
        success: true,
      },
    };
  }
}
