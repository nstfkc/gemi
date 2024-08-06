import { RequestBreakerError } from "./Error";
import { RequestContext } from "./requestContext";
import { ValidationError } from "./Router";

class Input<T extends Record<string, any>> {
  constructor(private data: T) {}

  public get(key: keyof T): T[keyof T] {
    return this.data[key];
  }

  public set(key: keyof T, value: T[keyof T]) {
    this.data[key] = value;
  }

  public has(key: keyof T) {
    return this.data[key] !== undefined;
  }

  public toJSON(): T {
    return this.data;
  }
}

function validate(ruleName: string) {
  const [rule, param] = ruleName.split(":");
  switch (rule) {
    case "required":
      return (value: any) => {
        return value !== null && value !== undefined && value?.length > 0;
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
        return value?.length >= parseInt(param);
      };
    case "max":
      return (value: any) => {
        return value?.length <= parseInt(param);
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

type StringType = "string";
type NumberType = "number";
type BooleanType = "boolean";
type MinLengthType = `min:${number}`;
type MaxLengthType = `max:${number}`;
type RequiredType = "required";
type SchemaKey =
  | StringType
  | NumberType
  | BooleanType
  | MinLengthType
  | MaxLengthType
  | RequiredType;

export type Schema<T extends Body> = Record<
  keyof T,
  Partial<Record<SchemaKey, string>>
>;

export type Body = Record<string, any>;

export class HttpRequest<
  T extends Body = Record<string, never>,
  Params = Record<string, never>,
> {
  public rawRequest: Request;
  public headers: Headers;
  public cookies: Map<string, string>;

  public schema: any = {};

  public params: Params;
  public ctx = RequestContext.getStore();

  constructor(req: Request, params: Params) {
    this.params = params;
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
    const inputMap = new Input<T>({} as T);
    if (this.rawRequest.headers.get("Content-Type") === "application/json") {
      const body = await this.rawRequest.json();
      for (const [key, value] of Object.entries(body)) {
        inputMap.set(key, value as T[keyof T]);
      }
    }
    if (
      this.rawRequest.headers.get("Content-Type") ===
      "application/x-www-form-urlencoded"
    ) {
      const body = (await this.rawRequest.formData()) as any; // TODO: fix type
      for (const [key, value] of body) {
        inputMap.set(key, value as T[keyof T]);
      }
    }
    if (
      this.rawRequest.headers
        .get("Content-Type")
        .startsWith("multipart/form-data")
    ) {
      const body = (await this.rawRequest.formData()) as any; // TODO: fix type
      for (const [key, value] of body) {
        if (inputMap.has(key)) {
          const currentValue = inputMap.get(key);
          if (Array.isArray(currentValue)) {
            currentValue.push(value);
            inputMap.set(key, currentValue);
          } else {
            inputMap.set(key, [currentValue, value] as any);
          }
        } else {
          inputMap.set(key, value as T[keyof T]);
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
          if (rule === "required") {
            errors[key] = [String(message)];
            break;
          } else {
            errors[key].push(String(message));
          }
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
    throw "not implemented";
  }
}

// class TerminateError extends RequestBreakerError {
//   constructor(
//     private requestKind: "api" | "view",
//     private payload: Record<string, any>,
//   ) {
//     super();
//     const api = requestKind === "view" ? {} : payload;
//     const view = requestKind === "api" ? {} : payload;

//     this.payload = { api, view };
//   }
// }

type TerminateParams = {
  message: string;
  status: number;
  headers?: Record<string, string>;
  payload?: Record<string, any>;
};
