import { parseCookieHeader } from "./getCookies";
import { isModelOriginated } from "./modelOriginated";
import { parseRangeHeader } from "./range";
import { RequestContext } from "./requestContext";
import { requestDomain } from "./requestDomain";
import { ValidationError } from "./Router";
import { InvalidValidationRuleError, validate } from "./validate";
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
type EmailType = "email";
type PasswordType = "password";
/** One entry per rule in `validate`'s `RULES`; `validate.test-d.ts` holds them
 *  to each other, so an offered rule cannot go unimplemented again (#609). */
export type SchemaKey =
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
  | FileSizeType
  | EmailType
  | PasswordType;

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
    const fields = Object.entries(this.schema as Record<string, Record<string, unknown>>).map(
      ([key, rules]) => ({
        key,
        // Every rule is looked up before any value is checked, so a schema that
        // names an unknown rule throws on every request, whatever the body —
        // not only on the ones whose earlier rules happened to pass. A function
        // is its own validator: its key is a label, and is not looked up.
        rules: Object.entries(rules).map(([rule, message]) => ({
          rule,
          message,
          check: typeof message === "function" ? null : this.ruleFor(key, rule),
        })),
      }),
    );

    for (const { key, rules } of fields) {
      const value = input.get(key as keyof T);
      const isRequired = rules.some(({ rule }) => rule === "required");
      // Absent: skipped unless `required`. `0` and `false` are values, and are
      // checked like any other — skipping every falsy value let `0` and `false` through a
      // `string` rule and `0` through a `boolean` one.
      const isAbsent = value === undefined || value === null || (value as unknown) === "";
      const messages: string[] = [];

      for (const { rule, message, check } of rules) {
        let _message = message;
        let _isValid = false;
        if (typeof message === "function") {
          _message = message(value);
          _isValid = typeof _message === "undefined";
        } else {
          _isValid = check!(value);
        }

        if (_isValid) {
          continue;
        }

        if (isAbsent && !isRequired) {
          continue;
        }

        if (rule === "required") {
          // A missing field reports that it is missing, and only that — not
          // also that `undefined` is not a string. Wherever `required` sits
          // among the field's rules.
          messages.splice(0, messages.length, String(_message));
          break;
        }

        messages.push(String(_message));
      }

      if (messages.length > 0) {
        errors[key] = messages;
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

  private ruleFor(key: string, rule: string) {
    try {
      return validate(rule);
    } catch (err) {
      if (err instanceof InvalidValidationRuleError) {
        throw new InvalidValidationRuleError(
          `${this.constructor.name}.schema.${key}: ${err.message}`,
        );
      }
      throw err;
    }
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
