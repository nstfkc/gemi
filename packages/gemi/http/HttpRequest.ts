import { parseCookieHeader } from "./getCookies";
import { isModelOriginated } from "./modelOriginated";
import { parseRangeHeader } from "./range";
import { RequestContext } from "./requestContext";
import { requestDomain } from "./requestDomain";
import { ValidationError } from "./Router";
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

// Formats B KB MB GB TB
// e.g parseFileSizeString("1MB") => 1024 * 1024
function parseFileSizeString(size: string) {
  const [number, unit] = size.match(/\d+|\D+/g) ?? [];
  if (!number || !unit) {
    return 0;
  }
  const fileSize = Number.parseInt(number);
  switch (unit) {
    case "B":
      return fileSize;
    case "KB":
      return fileSize * 1024;
    case "MB":
      return fileSize * 1024 * 1024;
    case "GB":
      return fileSize * 1024 * 1024 * 1024;
    case "TB":
      return fileSize * 1024 * 1024 * 1024 * 1024;
    default:
      return 0;
  }
}

// Formats png, jpg, ttf, excel, csv, word, pdf, json
// Eg. png => image/png
function parseFileTypeString(type: string) {
  switch (type) {
    case "image":
      return "image";
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "jpeg":
      return "image/jpeg";
    case "ttf":
      return "font/ttf";
    case "excel":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv":
      return "text/csv";
    case "word":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pdf":
      return "application/pdf";
    case "json":
      return "application/json";
    default:
      return type;
  }
}

/** The length of the things that have one — `undefined` for everything else,
 *  rather than the `undefined` that arithmetic silently turns into `false`. */
function lengthOf(value: any): number | undefined {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  return undefined;
}

function isNumber(value: any): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

function validate(ruleName: string) {
  const [rule, param] = ruleName.split(":");
  switch (rule) {
    /**
     * Present. Not "non-empty for the two types that happen to have `.length`".
     *
     * This used to end in `value?.length > 0`, which is `undefined > 0` — so
     * `false` — for every value that is not a string, an array or a Blob. A
     * number failed it. A boolean failed it. A plain object failed it, which on
     * a typed `HttpRequest<{ theme: { … } }>` is the ordinary case, and the app
     * saw a 400 on a request that was correct.
     *
     * `0` and `false` PASS. They are values someone sent, and a rule called
     * `required` asks whether the field is there, not whether it is truthy —
     * conflating those is how a checkbox set to "no" and a quantity of zero get
     * rejected as missing. Emptiness is still emptiness where the concept
     * applies: `""` and `[]` fail, as they did before, and so does a zero-byte
     * upload.
     *
     * `{}` passes. It is an object that was sent; whether its contents are
     * adequate is a question for the rules on its fields, not for this one.
     */
    case "required":
      return (value: any) => {
        if (value instanceof Blob) {
          return value.size > 0;
        }
        if (value === null || value === undefined) {
          return false;
        }
        if (typeof value === "string" || Array.isArray(value)) {
          return value.length > 0;
        }
        return true;
      };
    case "password":
      return (value: any) => {
        // min 8 characters
        // at least one uppercase letter,
        // at least one lowercase letter and one number
        // at least one special character
        const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[^a-zA-Z0-9]).{8,}$/;
        return passwordRegex.test(value);
      };

    case "number":
      return (value: any) => {
        if (typeof value !== "number") return false;

        return !Number.isNaN(value);
      };
    /**
     * Length, and only length. `min:3` is "at least three characters", never
     * "at least three".
     *
     * ONE NAME, ONE COMPARISON, deliberately. The tempting fix was to overload
     * these by runtime type — length for a string, magnitude for a number — and
     * that is the shape `required` was already in: a rule whose meaning depends
     * on what it is handed, which reads fine until the value's type is not the
     * one the author pictured. `gte` / `lte` below say which comparison they
     * make in their names, so nothing has to be inferred.
     *
     * Written out rather than left as `value?.length >= n` so that a number
     * fails here for a stated reason instead of by arithmetic on `undefined`.
     */
    case "min":
      return (value: any) => {
        const length = lengthOf(value);
        return length !== undefined && length >= Number.parseInt(param);
      };
    case "max":
      return (value: any) => {
        const length = lengthOf(value);
        return length !== undefined && length <= Number.parseInt(param);
      };
    /** Magnitude, for numbers. The counterpart `min` / `max` deliberately are not. */
    case "gte":
      return (value: any) => isNumber(value) && value >= Number(param);
    case "lte":
      return (value: any) => isNumber(value) && value <= Number(param);
    case "email":
      return (value: any) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(value);
      };
    case "file":
      return (value: any) => {
        return value instanceof Blob;
      };
    case "fileType":
      return (value: Blob) => {
        if (value instanceof Blob) {
          const parsedType = parseFileTypeString(param);
          return value.type.startsWith(parsedType);
        }
      };

    case "fileSize":
      return (value: Blob) => {
        if (value instanceof Blob) {
          const absoluteSize = parseFileSizeString(param);
          return value.size <= absoluteSize;
        }
      };
    default:
      return () => true;
  }
}

/**
 * The rule table, for `http/validate.test.ts`.
 *
 * Exported under this name rather than as `validate` because it is not part of
 * the framework's surface — nothing outside this file should be building
 * predicates by hand — and because a rule table whose only test goes through a
 * constructed `HttpRequest` is one whose gaps are invisible. The bug this
 * guards against was a predicate that was wrong for every type but two.
 */
export const __validateForTests = validate;

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
