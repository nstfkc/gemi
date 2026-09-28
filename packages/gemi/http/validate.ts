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
