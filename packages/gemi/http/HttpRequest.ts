import { RequestBreakerError } from "./Error";
import { parseCookieHeader } from "./getCookies";
import { isJsonMediaType, mediaType } from "./mediaType";
import { isModelOriginated } from "./modelOriginated";
import { parseRangeHeader } from "./range";
import { RequestContext } from "./requestContext";
import { requestDomain } from "./requestDomain";
import { ValidationError } from "./Router";
import { InvalidValidationRuleError, validate } from "./validate";
import type { ResolvedDomain } from "../services/router/DomainResolver";
import { isSchema, type SchemaIssue } from "../ai/Schema";

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
type ArrayType = "array";
type ObjectType = "object";
type InType = `in:${string}`;
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
  | PasswordType
  | ArrayType
  | ObjectType
  | InType;

type FieldRules = Partial<Record<SchemaKey, string>>;

/**
 * A field's rules by its key, plus nested ones by dotted path: `"address.city"`
 * for a nested object, `"rounds.*.prompt"` for every item of an array (#711).
 */
export type Schema<T extends Body> = Record<keyof T, FieldRules> & {
  [path: `${string}.${string}`]: FieldRules;
};

type PathSegment = string | number;

function isContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !(value instanceof Blob);
}

/**
 * The values a schema key names, each with its concrete path.
 *
 * A key without a dot, or one the body has as a key of its own (a form field
 * named `user.name`), is a plain field, as it always was. Otherwise it is a
 * path: `address.city` steps into an object, a number steps into an array, and
 * `*` stands for every item of an array (or every key of an object). A `*`
 * over anything else, a missing parent included, names nothing, so only the
 * parent's own rules decide whether it had to be there. The path is reported
 * as `SchemaIssue["path"]` is: keys as strings, array indices as numbers.
 */
function resolvePath(data: Body, key: string): { path: PathSegment[]; value: unknown }[] {
  if (!key.includes(".") || Object.hasOwn(data, key)) {
    return [{ path: [key], value: data[key] }];
  }
  let found: { path: PathSegment[]; value: unknown }[] = [{ path: [], value: data }];
  for (const segment of key.split(".")) {
    const next: typeof found = [];
    for (const { path, value } of found) {
      if (segment === "*") {
        if (Array.isArray(value)) {
          value.forEach((item, index) => next.push({ path: [...path, index], value: item }));
        } else if (isContainer(value)) {
          for (const [k, item] of Object.entries(value))
            next.push({ path: [...path, k], value: item });
        }
        continue;
      }
      if (Array.isArray(value) && /^\d+$/.test(segment)) {
        next.push({ path: [...path, Number(segment)], value: value[Number(segment)] });
        continue;
      }
      next.push({
        path: [...path, segment],
        value: isContainer(value) && Object.hasOwn(value, segment) ? value[segment] : undefined,
      });
    }
    found = next;
  }
  return found;
}

/** `["rounds", 2, "prompt"]` → `"rounds.2.prompt"`, the key a
 *  `ValidationError` reports a nested field under. The root is `""`. */
function errorKey(path: PathSegment[]): string {
  return path.join(".");
}

export type Body = Record<string, any>;
export type HttpRequestKind = "view" | "api";

export class HttpRequest<T extends Body = Record<string, never>, Params = Record<string, never>> {
  kind: HttpRequestKind;
  rawRequest: Request;
  headers: Omit<Headers, "set" | "delete">;
  cookies: Omit<Map<string, string>, "set" | "delete">;
  search: Input<any>;
  /**
   * What `input()` validates the body against: a map of field (or dotted
   * path, `"rounds.*.prompt"`) to `{ rule: message }`, or an `s` schema from
   * `gemi/ai` (#711). See `docs/controllers.md`.
   */
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
   * Aborts when the client goes away before the response is sent: the
   * browser closed the connection, or `useQuery` gave up on a request nobody
   * renders any more (#659). Hand it to slow work — a model call, an upstream
   * `fetch` — so it stops instead of running to completion for no one:
   *
   * ```ts
   * const reply = await fetch(upstream, { signal: req.signal });
   * if (req.signal.aborted) return null;
   * ```
   *
   * During a server render, an in-process query shares the page request's
   * signal.
   */
  get signal(): AbortSignal {
    return this.rawRequest.signal;
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

  /**
   * The body, by its media type: JSON (`application/json` or any `+json`
   * type), a urlencoded form, or a multipart form. The type is read without
   * its parameters and case-insensitively, so `application/json;
   * charset=utf-8` is JSON (#699). Any other type, or none, reads as `{}`.
   *
   * An empty JSON body is no body, and reads as `{}` like a request without
   * one. A body that is not JSON, or is JSON but not an object, is the
   * client's mistake: a 400 refusal (`form_error`), never a 500 (#700).
   */
  private async parseBody() {
    const type = mediaType(this.rawRequest.headers.get("Content-Type"));

    if (isJsonMediaType(type)) {
      return new Input<T>((await this.parseJsonBody()) as T);
    }

    if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
      let body: FormData;
      try {
        body = await this.rawRequest.formData();
      } catch (err) {
        // A `body-limit` refusal (413) is answered as itself.
        if (err instanceof RequestBreakerError) throw err;
        throw new RequestBreakerError("The request body could not be read as a form.");
      }
      const _inputMap = new Map<string, any>();
      for (const [key, value] of body.entries()) {
        if (_inputMap.has(key)) {
          const currentValue = _inputMap.get(key);
          if (Array.isArray(currentValue)) {
            currentValue.push(value);
          } else {
            _inputMap.set(key, [currentValue, value]);
          }
        } else {
          _inputMap.set(key, value);
        }
      }
      return new Input<T>(Object.fromEntries(_inputMap.entries()) as T);
    }

    return new Input<T>({} as T);
  }

  private async parseJsonBody(): Promise<Body> {
    if (!this.rawRequest.body) {
      return {};
    }
    let text: string;
    try {
      text = await this.rawRequest.text();
    } catch (err) {
      if (err instanceof RequestBreakerError) throw err;
      throw new RequestBreakerError("The request body could not be read.");
    }
    if (text.trim() === "") {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RequestBreakerError("The request body is not valid JSON.");
    }
    // `null`, a number, a string: nothing a field could be read from. An
    // array is left alone, as it was before.
    if (parsed === null || typeof parsed !== "object") {
      throw new RequestBreakerError("The request body must be a JSON object.");
    }
    return parsed as Body;
  }

  private validateInput(input: Input<T>): Input<T> {
    if (isSchema(this.schema)) {
      return this.validateWithSchema(input);
    }
    const data = (input.toJSON() ?? {}) as Body;
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
      for (const { path, value } of resolvePath(data, key)) {
        const messages = this.checkField(value, rules);
        if (messages.length > 0) {
          // `rounds.0.prompt` and `rounds.*.prompt` can name the same value;
          // its messages are merged, each once.
          const reported = (errors[errorKey(path)] ??= []);
          for (const message of messages) {
            if (!reported.includes(message)) reported.push(message);
          }
        }
      }
    }

    this.addRefinements(errors, data);
    if (Object.keys(errors).length > 0) {
      throw new ValidationError(errors);
    }

    return input;
  }

  private checkField(
    value: unknown,
    rules: { rule: string; message: unknown; check: ((value: unknown) => boolean) | null }[],
  ): string[] {
    const isRequired = rules.some(({ rule }) => rule === "required");
    // Absent: skipped unless `required`. `0` and `false` are values, and are
    // checked like any other — skipping every falsy value let `0` and `false` through a
    // `string` rule and `0` through a `boolean` one.
    const isAbsent = value === undefined || value === null || value === "";
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
        return [String(_message)];
      }

      // Two rules can share a message (`string` and `email` both saying
      // "Invalid email"); the field reports it once (#675).
      if (!messages.includes(String(_message))) {
        messages.push(String(_message));
      }
    }
    return messages;
  }

  /**
   * An `s` schema as the body's validator (#711). Each `SchemaIssue` is
   * reported under its path joined with dots, the same key a dotted rule uses,
   * and its `message`. A valid body is replaced by the parsed value, so what
   * the handler reads is what the schema's type says: unknown keys dropped, an
   * optional field sent as `null` left out.
   */
  private validateWithSchema(input: Input<T>): Input<T> {
    const result = this.schema.validate(input.toJSON()) as
      | { ok: true; value: unknown }
      | { ok: false; issues: SchemaIssue[] };
    const errors: Record<string, string[]> = {};
    // `in`, not `!result.ok`: without `strictNullChecks` the union does not
    // narrow on its boolean tag.
    if ("issues" in result) {
      for (const issue of result.issues) {
        const key = errorKey(issue.path);
        const messages = (errors[key] ??= []);
        if (!messages.includes(issue.message)) messages.push(issue.message);
      }
    }
    const parsed = "value" in result ? new Input<T>(result.value as T) : input;
    this.addRefinements(errors, parsed.toJSON());
    if (Object.keys(errors).length > 0) {
      throw new ValidationError(errors);
    }
    return parsed;
  }

  private addRefinements(errors: Record<string, string[]>, data: unknown) {
    for (const [key, value] of Object.entries(this.refine(data) ?? {})) {
      const messages = errors[key] ?? [];
      // A `refine` message the rules already reported is not repeated (#675).
      errors[key] = messages.includes(value as string) ? messages : [...messages, value as string];
    }
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
      return {
        isValid: true,
        errors: {},
        input: this.validateInput(input),
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
