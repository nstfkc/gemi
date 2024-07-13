import { RequestBreakerError } from "./Error";
import { ValidationError } from "./Router";

class Input<T = Record<string, any>> extends Map {
  constructor() {
    super();
  }

  public toJSON(): T {
    return Object.fromEntries(this);
  }
}

function validate(ruleName: string) {
  const [rule, param] = ruleName.split(":");
  switch (rule) {
    case "required":
      return (value: any) => {
        return value !== null && value !== undefined;
      };
    case "password":
      return (value: any) => {
        // min 8 characters
        // at least one uppercase letter,
        // at least one lowercase letter and one number
        // at least one special character
        const passwordRegex =
          /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[^a-zA-Z0-9]).{8,}$/;
        return passwordRegex.test(value);
      };

    case "number":
      return (value: any) => {
        if (typeof value !== "number") return false;

        return !isNaN(value);
      };
    case "min":
      return (value: any) => {
        return value.length >= parseInt(param);
      };
    case "max":
      return (value: any) => {
        return value.length <= parseInt(param);
      };
    case "email":
      return (value: any) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(value);
      };
    default:
      return () => true;
  }
}

export class HttpRequest<T = {}> {
  public rawRequest: Request;
  public headers: Headers;
  public cookies: Map<string, string>;

  protected schema: Partial<Record<keyof T, Record<string, string>>> = {};

  constructor(req: Request) {
    this.rawRequest = req;
    this.headers = req.headers;
    const cookie = this.rawRequest.headers.get("Cookie");
    const cookies = new Map();
    if (cookie) {
      const cookieArray = cookie.split(";");
      for (const c of cookieArray) {
        const [key, value] = c.split("=");
        cookies.set(key.trim(), value.trim());
      }
    }
    this.cookies = cookies;
  }

  private async parseBody() {
    const inputMap = new Input<T>();
    if (this.rawRequest.headers.get("Content-Type") === "application/json") {
      const body = await this.rawRequest.json();
      for (const [key, value] of Object.entries(body)) {
        inputMap.set(key, value);
      }
    }
    if (
      this.rawRequest.headers.get("Content-Type") ===
      "application/x-www-form-urlencoded"
    ) {
      const body = await this.rawRequest.formData();
      for (const [key, value] of body) {
        console.log(key, value);
        inputMap.set(key, value);
      }
    }
    if (
      this.rawRequest.headers
        .get("Content-Type")
        .startsWith("multipart/form-data")
    ) {
      const body = await this.rawRequest.formData();
      for (const [key, value] of body) {
        if (inputMap.has(key)) {
          const currentValue = inputMap.get(key);
          if (Array.isArray(currentValue)) {
            currentValue.push(value);
            inputMap.set(key, currentValue);
          } else {
            inputMap.set(key, [currentValue, value]);
          }
        } else {
          inputMap.set(key, value);
        }
      }
    }
    return inputMap;
  }

  private validateInput(input: Input<T>) {
    const errors: Record<string, string[]> = {};
    for (const [key, rules] of Object.entries(this.schema)) {
      for (const [rule, message] of Object.entries(rules)) {
        const validator = validate(rule);

        if (!validator(input.get(key))) {
          if (!errors[key]) {
            errors[key] = [];
          }
          errors[key].push(String(message));
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new ValidationError(errors);
    } else {
      return input;
    }
  }

  public async input(): Promise<Input<T>> {
    return this.validateInput(await this.parseBody());
  }

  public async safeInput(): Promise<{
    isValid: boolean;
    errors: Record<string, string[]>;
    input: Input<T>;
  }> {
    const input = await this.parseBody();
    try {
      this.validateInput(input);
      return {
        isValid: true,
        errors: {},
        input,
      };
    } catch (err) {
      if (!(err instanceof ValidationError)) {
        throw err;
      }
      return {
        isValid: false,
        errors: err.errors,
        input,
      };
    }
  }

  // TODO implement this method
  public async terminate(params: TerminateParams) {
    const { message, status, headers, payload } = params;
    const error = new RequestBreakerError(message);

    throw "not implemented";
  }
}

type TerminateParams = {
  message: string;
  status: number;
  headers?: Record<string, string>;
  payload?: Record<string, any>;
};
