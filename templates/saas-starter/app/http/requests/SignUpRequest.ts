import { HttpRequest } from "gemi/http";

export class SignUpRequest extends HttpRequest {
  schema = {
    name: {
      string: "Invalid name",
      "min:2": "Name must be at least 3 characters",
    },
    email: {
      string: "Invalid email",
      required: "Email is required",
      email: "Invalid email",
    },
    password: {
      // required: "Password is required",
      "min:8": "Password must be at least 8 characters",
    },
  };
}
