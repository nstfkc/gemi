/**
 * The validation rule table: a rule name in, a predicate out.
 *
 * ITS OWN MODULE SO THE TEST DOES NOT NEED A HOOK. This lived in
 * `HttpRequest.ts` and was reached from `validate.test.ts` through
 * `export const __validateForTests = validate`, which is a name that exists
 * only because the thing it aliases was in the wrong file. Two costs, and the
 * second is the one that bites:
 *
 *   - `tsc` emits a declaration per source file, so `dist/http/HttpRequest.d.ts`
 *     shipped `__validateForTests` to every installed copy of the framework. The
 *     JS build bundles, so there is no `dist/http/HttpRequest.js` behind it —
 *     the declaration announced an export the tarball could not produce.
 *   - A test-only alias is a second name for the same function, so the test
 *     reads as if it were poking at something private. It is not: this is the
 *     code path every request body goes through. Importing `validate` says so.
 *
 * Nothing outside `HttpRequest` should build predicates by hand — rules are
 * named in a route's schema — but "internal" is what an unexported name in an
 * unexported module already means, and it does not need a warning label.
 */

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

/** Every rule `validate` implements. `SchemaKey` in `HttpRequest.ts` offers
 *  these and only these: `validate.test-d.ts` checks the two lists agree, and
 *  `validate.test.ts` that each one has a case. */
export const RULES = [
  "required",
  "string",
  "boolean",
  "number",
  "email",
  "password",
  "min",
  "max",
  "gte",
  "lte",
  "file",
  "fileType",
  "fileSize",
] as const;

/**
 * A schema names a rule `validate` does not have, or gives one a parameter it
 * cannot use. Thrown when the request is validated, not when the body is bad:
 * it is a bug in the schema, so it is a 500 and not a 400.
 */
export class InvalidValidationRuleError extends Error {
  name = "InvalidValidationRuleError";
}

/** `min:3` → 3. A parameter that is not a number throws, instead of becoming
 *  `NaN` and quietly failing every value. */
function numericParam(rule: string, param: string | undefined): number {
  const n = param === undefined || param.trim() === "" ? Number.NaN : Number(param);
  if (Number.isNaN(n)) {
    throw new InvalidValidationRuleError(
      `Validation rule "${rule}:${param ?? ""}" needs a number, e.g. "${rule}:3"`,
    );
  }
  return n;
}

export function validate(ruleName: string) {
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
    /**
     * The JSON types, checked with `typeof` like `number`. No coercion: `"true"`
     * is not a boolean and `42` is not a string. A form-encoded or multipart
     * body only ever carries strings (and files), so `boolean` and `number` are
     * rules for JSON bodies.
     */
    case "string":
      return (value: any) => typeof value === "string";
    case "boolean":
      return (value: any) => typeof value === "boolean";
    case "number":
      return (value: any) => isNumber(value);
    /**
     * `RegExp.prototype.test` stringifies its argument, so without the `typeof`
     * check `["a@b.co"]` passed `email` and an array holding a strong password
     * passed `password`.
     */
    case "password":
      return (value: any) => {
        // min 8 characters
        // at least one uppercase letter,
        // at least one lowercase letter and one number
        // at least one special character
        const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[^a-zA-Z0-9]).{8,}$/;
        return typeof value === "string" && passwordRegex.test(value);
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
    case "min": {
      const min = numericParam(rule, param);
      return (value: any) => {
        const length = lengthOf(value);
        return length !== undefined && length >= min;
      };
    }
    case "max": {
      const max = numericParam(rule, param);
      return (value: any) => {
        const length = lengthOf(value);
        return length !== undefined && length <= max;
      };
    }
    /** Magnitude, for numbers. The counterpart `min` / `max` deliberately are not. */
    case "gte": {
      const bound = numericParam(rule, param);
      return (value: any) => isNumber(value) && value >= bound;
    }
    case "lte": {
      const bound = numericParam(rule, param);
      return (value: any) => isNumber(value) && value <= bound;
    }
    case "email":
      return (value: any) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return typeof value === "string" && emailRegex.test(value);
      };
    case "file":
      return (value: any) => {
        return value instanceof Blob;
      };
    case "fileType": {
      if (!param) {
        throw new InvalidValidationRuleError(
          `Validation rule "fileType" needs a type, e.g. "fileType:png" or "fileType:image"`,
        );
      }
      const parsedType = parseFileTypeString(param);
      return (value: any) => value instanceof Blob && value.type.startsWith(parsedType);
    }
    case "fileSize": {
      // `parseFileSizeString` answers 0 for anything it cannot read, and a
      // 0-byte ceiling rejects every upload — so `fileSize:5mb` or
      // `fileSize:1.5MB` looked like a limit and was a wall.
      const absoluteSize = parseFileSizeString(param ?? "");
      if (absoluteSize === 0 && !/^0+(B|KB|MB|GB|TB)$/.test(param ?? "")) {
        throw new InvalidValidationRuleError(
          `Validation rule "fileSize:${param ?? ""}" needs a whole size in B, KB, MB, GB or TB, e.g. "fileSize:5MB"`,
        );
      }
      return (value: any) => value instanceof Blob && value.size <= absoluteSize;
    }
    /**
     * Not `() => true`. That default is how `string` and `boolean` shipped in
     * `SchemaKey` checking nothing (#609): a rule the table does not
     * know looks, from the schema, exactly like one it does. A typo'd or
     * unimplemented rule is a bug in the schema, so it throws.
     */
    default:
      throw new InvalidValidationRuleError(
        `Unknown validation rule "${ruleName}". Known rules: ${RULES.join(", ")}`,
      );
  }
}
