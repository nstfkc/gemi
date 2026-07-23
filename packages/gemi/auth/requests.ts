import { HttpRequest } from "../http/HttpRequest";

export class SignUpRequest extends HttpRequest<
  {
    name: string;
    email: string;
    password: string;
    invitationId?: string;
  },
  Record<string, string>
> {
  schema = {
    name: {
      string: "Invalid name",
      required: "Name is required",
      "min:2": "Name must be at least 3 characters",
    },
    email: {
      string: "Invalid email",
      required: "Email is required",
      email: "Invalid email",
    },
    password: {
      // required: "Password is required",
      "min:8": "Password must be at least 9 characters",
    },
  };
}
