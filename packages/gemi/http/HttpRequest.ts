import { parseCookieHeader } from "./getCookies";
import { isModelOriginated } from "./modelOriginated";
import { parseRangeHeader } from "./range";
import { RequestContext } from "./requestContext";
import { requestDomain } from "./requestDomain";
import { ValidationError } from "./Router";
import { validate } from "./validate";
import type { ResolvedDomain } from "../services/router/DomainResolver";

class Input<T> {
  constructor(private data: T) {}

  public get<K extends keyof T>(key: K): T[K] {
    return this.data[key];
  }

  public has(key: keyof T) {
    return this.data[key] !== undefined;
  }

  public toJSON(): T {
    return this.data;
  }
}

type StringType = "string";
type NumberType = "number";
type BooleanType = "boolean";
type MinLengthType = `min:${number}`;
type MaxLengthType = `max:${number}`;
/** Magnitude, for numbers — see `validate`'s `min` case for why these are not
 *  the same rule wearing different names. */
type GreaterOrEqualType = `gte:${number}`;
type LessOrEqualType = `lte:${number}`;
type RequiredType = "required";
type FileType = "file";
// Backticks, not quotes. These two were written with double quotes, which makes
// them the *literal text* `fileType:${string}` rather than a template literal
// type — so `fileType:image/png`, the only way anyone would ever write the rule,
// did not typecheck, while the runtime handled it perfectly well.
type FileTypeType = `fileType:${string}`;
type FileSizeType = `fileSize:${string}`;
type SchemaKey =
  | StringType
  | NumberType
  | BooleanType
  | MinLengthType
  | MaxLengthType
  | GreaterOrEqualType
  | LessOrEqualType
  | RequiredType
  | FileType
  | FileTypeType
  | FileSizeType;

export type Schema<T extends Body> = Record<keyof T, Partial<Record<SchemaKey, string>>>;

export type Body = Record<string, any>;
export type HttpRequestKind = "view" | "api";

export class HttpRequest<T extends Body = Record<string, never>, Params = Record<string, never>> {
  kind: HttpRequestKind;
  rawRequest: Request;
  headers: Omit<Headers, "set" | "delete">;
  cookies: Omit<Map<string, string>, "set" | "delete">;
  search: Input<any>;
  schema: any = {};
  routePath: string;
  params: Params;
  /**
   * The `route.domains` group this request was routed by — `domain.params`
   * holds a `:param` subdomain's value, or what `custom.resolve` returned for
   * a custom domain. `null` when the app declares no `route.domains`.
   *
   * Kept apart from `params`, which are the path's alone.
   */
  domain: ResolvedDomain | null;

  constructor(req?: Request, params?: any, kind?: HttpRequestKind, routePath?: string) {
    if (!req) {
      const _req = RequestContext.getStore().req;
      this.params = _req.params as any;
      this.rawRequest = _req.rawRequest;
      this.kind = _req.kind;
      this.routePath = _req.routePath;
      this.domain = _req.domain ?? null;
    } else {
      this.params = params;
      this.rawRequest = req;
      this.routePath = routePath;
      this.kind = kind ?? "api";
      this.domain = requestDomain(req);
    }

    this.headers = this.rawRequest.headers;

    const cookies = parseCookieHeader(this.rawRequest.headers.get("Cookie"));
    const url = new URL(this.rawRequest.url);
    const map = new Map<string, string | string[]>();
    for (const [key, value] of url.searchParams) {
      if (map.has(key)) {
        const currentValue = map.get(key);
        if (Array.isArray(currentValue)) {
          currentValue.push(value);
          map.set(key, currentValue);
        } else {
          map.set(key, [currentValue, value]);
        }
      } else {
        map.set(key, value);
      }
    }
    const _params = Object.fromEntries(map.entries());
    this.search = new Input(_params);
    this.cookies = cookies;
  }

  locale() {
    return RequestContext.getStore().locale;
  }

  ctx() {
    return RequestContext.getStore();
  }

  /**
   * Whether the framework dispatched this request in-process for a model — a
   * tool call — rather than a client sending it. Readable in `onRequestStart`,
   * in middleware and in the handler alike.
   *
   * No header or cookie can make this true; see `http/modelOriginated.ts`.
   */
  isModelOriginated(): boolean {
    return isModelOriginated(this.rawRequest);
  }

  /**
   * The parsed `Range` header, or `null` when absent or unusable. Pass it to
   * `FileStorage.read(name, { range })` to range explicitly; inside a
   * `this.stream()` route `read()` already picks it up on its own.
   */
  range() {
    return parseRangeHeader(this.rawRequest.headers.get("Range"));
  }

  refine(_input: any): any {
    return {};
  }

  private async parseBody() {
    let inputMap = new Input<T>({} as T);
    if (this.rawRequest.headers.get("Content-Type") === "application/json") {
      const body = await this.rawRequest.json();
      inputMap = new Input<T>(body as T);
    }
    if (this.rawRequest.headers.get("Content-Type") === "application/x-www-form-urlencoded") {
      const body = (await this.rawRequest.formData()) as any; // TODO: fix type
      inputMap = new Input<T>(body as T);
    }

    if (this.rawRequest.headers.get("Content-Type")?.startsWith("multipart/form-data")) {
      const body = (await this.rawRequest.formData()) as any; // TODO: fix type
      const _inputMap = new Map<string, any>();
      for (const [key, value] of body.entries()) {
        if (_inputMap.has(key)) {
          const currentValue = _inputMap.get(key);
          if (Array.isArray(currentValue)) {
            currentValue.push(value);
            _inputMap.set(key, currentValue);
          } else {
            _inputMap.set(key, [currentValue, value] as any);
          }
        } else {
          _inputMap.set(key, value as T[keyof T]);
        }
      }
      inputMap = new Input<T>(Object.fromEntries(_inputMap.entries()) as T);
    }
    return inputMap;
  }

  private validateInput(input: Input<T>) {
    const errors: Record<string, string[]> = {};
    for (const [key, rules] of Object.entries(this.schema)) {
      for (const [rule, message] of Object.entries(rules)) {
        const validator = validate(rule);

        let _message = message;
        let _isValid = false;
        if (typeof message === "function") {
          _message = message(input.get(key));
          _isValid = typeof _message === "undefined";
        } else {
          _isValid = validator(input.get(key));
        }

        if (_isValid) {
          continue;
        }

        if (!input.get(key) && !Object.keys(rules).includes("required")) {
          continue;
        }

        if (!errors[key]) {
          errors[key] = [];
        }

        if (rule === "required") {
          errors[key] = [String(_message)];
          continue;
        }

        errors[key].push(String(_message));
      }
    }

    for (const [key, value] of Object.entries(this.refine(input.toJSON()) ?? {})) {
      if (!errors[key]) {
        errors[key] = [];
      }
      errors[key] = [...(errors[key] ?? []), value as string];
    }

    if (Object.keys(errors).length > 0) {
      throw new ValidationError(errors);
    }

    return input;
  }

  async input(): Promise<Input<T>> {
    return this.validateInput(await this.parseBody());
  }

  async safeInput(): Promise<{
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
}
