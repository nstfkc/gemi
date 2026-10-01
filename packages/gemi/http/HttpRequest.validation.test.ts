import { describe, expect, test } from "vitest";

import { HttpRequest } from "./HttpRequest";
import { ValidationError } from "./Router";
import { InvalidValidationRuleError } from "./validate";

/**
 * `validate` answers per rule; this is how `HttpRequest` puts the answers
 * together — which fields are skipped, which messages are reported, and what a
 * schema naming a rule that does not exist does.
 */

function jsonRequest(body: unknown) {
  return new Request("http://gemi.dev/api/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function errorsOf(req: HttpRequest<any, any>) {
  const { errors } = await req.safeInput();
  return errors;
}

class UpdateBriefRequest extends HttpRequest<{ hero: string; enabled: boolean }> {
  schema = {
    hero: { string: "Hero must be a string" },
    enabled: { boolean: "Must be true or false" },
  };
}

describe("string and boolean are enforced (#609)", () => {
  test("the issue's body is refused", async () => {
    expect(
      await errorsOf(new UpdateBriefRequest(jsonRequest({ hero: 42, enabled: "yes" }))),
    ).toEqual({
      hero: ["Hero must be a string"],
      enabled: ["Must be true or false"],
    });
  });

  test("the right types pass, false included", async () => {
    expect(
      await errorsOf(new UpdateBriefRequest(jsonRequest({ hero: "Hi", enabled: false }))),
    ).toEqual({});
  });

  test("an optional field that is absent is still skipped", async () => {
    expect(await errorsOf(new UpdateBriefRequest(jsonRequest({})))).toEqual({});
    expect(
      await errorsOf(new UpdateBriefRequest(jsonRequest({ hero: null, enabled: null }))),
    ).toEqual({});
    expect(await errorsOf(new UpdateBriefRequest(jsonRequest({ hero: "" })))).toEqual({});
  });

  test("but 0 and false are values, and are checked", async () => {
    // Skipping every falsy value let `0` through a `string` rule and `0`
    // through a `boolean` one.
    expect(await errorsOf(new UpdateBriefRequest(jsonRequest({ hero: 0, enabled: 0 })))).toEqual({
      hero: ["Hero must be a string"],
      enabled: ["Must be true or false"],
    });
    expect(await errorsOf(new UpdateBriefRequest(jsonRequest({ hero: false })))).toEqual({
      hero: ["Hero must be a string"],
    });
  });

  test("input() throws the ValidationError", async () => {
    await expect(new UpdateBriefRequest(jsonRequest({ hero: 42 })).input()).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("a field that fails required", () => {
  test("reports only the required message, wherever required sits", async () => {
    class Before extends HttpRequest<{ name: string }> {
      schema = {
        name: { string: "Not a string", required: "Name is required", "min:2": "Too short" },
      };
    }
    class After extends HttpRequest<{ name: string }> {
      schema = {
        name: { required: "Name is required", string: "Not a string", "min:2": "Too short" },
      };
    }
    for (const Req of [Before, After]) {
      expect(await errorsOf(new Req(jsonRequest({})))).toEqual({ name: ["Name is required"] });
      expect(await errorsOf(new Req(jsonRequest({ name: "" })))).toEqual({
        name: ["Name is required"],
      });
    }
  });

  test("a present value reports every rule it fails", async () => {
    class Req extends HttpRequest<{ name: string }> {
      schema = {
        name: { required: "Name is required", string: "Not a string", "min:2": "Too short" },
      };
    }
    expect(await errorsOf(new Req(jsonRequest({ name: 7 })))).toEqual({
      name: ["Not a string", "Too short"],
    });
  });
});

describe("a field that fails several rules with the same message (#675)", () => {
  class SignUp extends HttpRequest<{ email: string }> {
    schema = {
      email: { string: "Invalid email", required: "Email is required", email: "Invalid email" },
    };
  }

  test("reports that message once", async () => {
    // The issue's body: an array is neither a string nor an email.
    expect(await errorsOf(new SignUp(jsonRequest({ email: ["a@b.co"] })))).toEqual({
      email: ["Invalid email"],
    });
    expect(await errorsOf(new SignUp(jsonRequest({ email: "not-an-email" })))).toEqual({
      email: ["Invalid email"],
    });
  });

  test("different messages are all still reported, in rule order", async () => {
    class Req extends HttpRequest<{ name: string }> {
      schema = {
        name: { string: "Not a string", "min:2": "Too short", "max:1": "Not a string" },
      };
    }
    expect(await errorsOf(new Req(jsonRequest({ name: 7 })))).toEqual({
      name: ["Not a string", "Too short"],
    });
  });

  test("a refine message the rules already reported is not repeated", async () => {
    class Req extends SignUp {
      refine(_input: any) {
        return { email: "Invalid email" };
      }
    }
    expect(await errorsOf(new Req(jsonRequest({ email: 5 })))).toEqual({
      email: ["Invalid email"],
    });
  });
});

describe("a schema naming a rule that does not exist", () => {
  class TypoRequest extends HttpRequest<{ name: string; age: number }> {
    schema = {
      age: { number: "Age must be a number" },
      name: { requried: "Name is required" },
    };
  }

  test("throws on every request, naming the class, the field and the rule", async () => {
    // A valid body and an invalid one alike: it is the schema that is wrong.
    for (const body of [{ name: "Ada", age: 36 }, {}, { age: "x" }]) {
      const req = new TypoRequest(jsonRequest(body));
      await expect(req.input()).rejects.toThrow(InvalidValidationRuleError);
      await expect(new TypoRequest(jsonRequest(body)).input()).rejects.toThrow(
        /^TypoRequest\.schema\.name: Unknown validation rule "requried"/,
      );
    }
  });

  test("safeInput throws it too, rather than reporting it as a 400", async () => {
    await expect(new TypoRequest(jsonRequest({})).safeInput()).rejects.toThrow(
      InvalidValidationRuleError,
    );
  });

  test("a function is its own validator, so its key is only a label", async () => {
    class CustomRequest extends HttpRequest<{ name: string }> {
      schema = {
        name: {
          notAdmin: (value: string) => (value === "admin" ? "Reserved name" : undefined),
        },
      };
    }
    expect(await errorsOf(new CustomRequest(jsonRequest({ name: "ada" })))).toEqual({});
    expect(await errorsOf(new CustomRequest(jsonRequest({ name: "admin" })))).toEqual({
      name: ["Reserved name"],
    });
  });
});
