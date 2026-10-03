import { describe, expect, test } from "vitest";

import { s } from "../ai/Schema";
import { HttpRequest } from "./HttpRequest";
import { ValidationError } from "./Router";

/**
 * Nested and array validation (#711): dotted-path rules, and an `s` schema as
 * the body's validator. Both report a nested field under its path joined with
 * dots, which is `SchemaIssue["path"].join(".")` — the same key either way.
 */

function jsonRequest(body: unknown) {
  return new Request("http://gemi.dev/api/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function formRequest(fields: Record<string, string>) {
  return new Request("http://gemi.dev/api/x", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function errorsOf(req: HttpRequest<any, any>) {
  const { errors } = await req.safeInput();
  return errors;
}

class CreateAgentRequest extends HttpRequest<{
  name: string;
  rounds: { prompt: string; kind: string }[];
}> {
  schema = {
    name: { required: "Name is required", string: "Name must be text" },
    rounds: {
      required: "Add a round",
      array: "Rounds must be a list",
      "min:1": "Add a round",
      "max:10": "At most 10 rounds",
    },
    "rounds.*.prompt": { required: "Prompt is required", "max:20": "Prompt is too long" },
    "rounds.*.kind": { required: "Kind is required", "in:question,choice": "Unknown kind" },
  };
}

describe("dotted-path rules", () => {
  test("the issue's body passes", async () => {
    const req = new CreateAgentRequest(
      jsonRequest({
        name: "Interviewer",
        rounds: [
          { prompt: "Who?", kind: "question" },
          { prompt: "Pick", kind: "choice" },
        ],
      }),
    );
    expect(await errorsOf(req)).toEqual({});
  });

  test("each item is checked, and reported under its index", async () => {
    const req = new CreateAgentRequest(
      jsonRequest({
        name: "Interviewer",
        rounds: [
          { prompt: "Who?", kind: "question" },
          { kind: "poll" },
          { prompt: "x".repeat(21), kind: "choice" },
        ],
      }),
    );
    expect(await errorsOf(req)).toEqual({
      "rounds.1.prompt": ["Prompt is required"],
      "rounds.1.kind": ["Unknown kind"],
      "rounds.2.prompt": ["Prompt is too long"],
    });
  });

  test("an item that is not an object has none of its fields", async () => {
    const req = new CreateAgentRequest(jsonRequest({ name: "A", rounds: ["oops"] }));
    expect(await errorsOf(req)).toEqual({
      "rounds.0.prompt": ["Prompt is required"],
      "rounds.0.kind": ["Kind is required"],
    });
  });

  test("a missing or wrong-typed parent is left to the parent's own rules", async () => {
    expect(await errorsOf(new CreateAgentRequest(jsonRequest({ name: "A" })))).toEqual({
      rounds: ["Add a round"],
    });
    expect(
      await errorsOf(new CreateAgentRequest(jsonRequest({ name: "A", rounds: "many" }))),
    ).toEqual({ rounds: ["Rounds must be a list"] });
    expect(await errorsOf(new CreateAgentRequest(jsonRequest({ name: "A", rounds: [] })))).toEqual({
      rounds: ["Add a round"],
    });
  });

  test("a nested object path, absent parent included", async () => {
    class AddressRequest extends HttpRequest<{ address?: { city: string; zip?: string } }> {
      schema = {
        address: { object: "Address must be an object" },
        "address.city": { required: "City is required" },
        "address.zip": { "max:5": "Zip is too long" },
      };
    }
    expect(await errorsOf(new AddressRequest(jsonRequest({ address: { city: "Rome" } })))).toEqual(
      {},
    );
    expect(await errorsOf(new AddressRequest(jsonRequest({ address: { zip: "123456" } })))).toEqual(
      { "address.city": ["City is required"], "address.zip": ["Zip is too long"] },
    );
    // A non-wildcard path has one value, `undefined` when a parent is missing,
    // so `required` on it still fires.
    expect(await errorsOf(new AddressRequest(jsonRequest({})))).toEqual({
      "address.city": ["City is required"],
    });
    expect(await errorsOf(new AddressRequest(jsonRequest({ address: ["Rome"] })))).toEqual({
      address: ["Address must be an object"],
      "address.city": ["City is required"],
    });
  });

  test("numeric segments, nested wildcards and wildcards over objects", async () => {
    class Matrix extends HttpRequest<any> {
      schema = {
        "rows.0.label": { required: "First row needs a label" },
        "rows.*.cells.*": { "gte:0": "No negative cells" },
        "tags.*": { string: "Tags are text" },
      };
    }
    expect(
      await errorsOf(
        new Matrix(
          jsonRequest({
            rows: [{ cells: [1, -1] }, { label: "b", cells: [-2] }],
            tags: { a: "x", b: 2 },
          }),
        ),
      ),
    ).toEqual({
      "rows.0.label": ["First row needs a label"],
      "rows.0.cells.1": ["No negative cells"],
      "rows.1.cells.0": ["No negative cells"],
      "tags.b": ["Tags are text"],
    });
  });

  test("a body field whose name has a dot is still read as that field", async () => {
    class Legacy extends HttpRequest<any> {
      schema = { "user.name": { required: "Name is required", "min:2": "Too short" } };
    }
    expect(await errorsOf(new Legacy(formRequest({ "user.name": "A" })))).toEqual({
      "user.name": ["Too short"],
    });
    expect(await errorsOf(new Legacy(formRequest({ "user.name": "Al" })))).toEqual({});
  });

  test("a function rule gets the item's value", async () => {
    const seen: unknown[] = [];
    class Fn extends HttpRequest<any> {
      schema = {
        "items.*.qty": {
          positive: (value: unknown) => {
            seen.push(value);
            return typeof value === "number" && value > 0 ? undefined : "Must be positive";
          },
        },
      };
    }
    expect(await errorsOf(new Fn(jsonRequest({ items: [{ qty: 1 }, { qty: 0 }] })))).toEqual({
      "items.1.qty": ["Must be positive"],
    });
    expect(seen).toEqual([1, 0]);
  });
});

const AgentBody = s.object({
  name: s.string(),
  rounds: s.array(
    s.object({
      prompt: s.string(),
      kind: s.enum(["question", "choice"]),
      hint: s.string().optional(),
    }),
  ),
});

class SchemaAgentRequest extends HttpRequest<{
  name: string;
  rounds: { prompt: string; kind: "question" | "choice"; hint?: string }[];
}> {
  schema = AgentBody;
}

describe("an s schema as the body validator", () => {
  test("a valid body is the parsed value: unknown keys dropped, null optionals left out", async () => {
    const req = new SchemaAgentRequest(
      jsonRequest({
        name: "A",
        extra: true,
        rounds: [{ prompt: "Who?", kind: "question", hint: null, junk: 1 }],
      }),
    );
    const { isValid, input } = await req.safeInput();
    expect(isValid).toBe(true);
    expect(input.toJSON()).toEqual({ name: "A", rounds: [{ prompt: "Who?", kind: "question" }] });
    expect(
      (await new SchemaAgentRequest(jsonRequest({ name: "A", rounds: [] })).input()).get("rounds"),
    ).toEqual([]);
  });

  test("issues are reported under their path, joined with dots", async () => {
    const body = {
      rounds: [
        { prompt: "Who?", kind: "question" },
        { prompt: 3, kind: "poll" },
      ],
    };
    const errors = await errorsOf(new SchemaAgentRequest(jsonRequest(body)));
    const result = AgentBody.validate(body);
    if (result.ok) throw new Error("expected issues");
    // The same keys `schema.validate()` paths give (#722).
    expect(Object.keys(errors).sort()).toEqual(
      [...new Set(result.issues.map((issue) => issue.path.join(".")))].sort(),
    );
    expect(Object.keys(errors).sort()).toEqual(["name", "rounds.1.kind", "rounds.1.prompt"]);
    for (const issue of result.issues) {
      expect(errors[issue.path.join(".")]).toContain(issue.message);
    }
  });

  test("input() throws the ValidationError, with the usual response shape", async () => {
    const err = await new SchemaAgentRequest(jsonRequest({ name: 1, rounds: [] }))
      .input()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).payload.api.data.error.kind).toBe("validation_error");
    expect(Object.keys((err as ValidationError).errors)).toEqual(["name"]);
  });

  test("refine runs on the parsed value and adds to the issues", async () => {
    class Refined extends SchemaAgentRequest {
      override refine(input: any) {
        return input.rounds?.length > 1 ? {} : { rounds: "Add at least two rounds" };
      }
    }
    expect(await errorsOf(new Refined(jsonRequest({ name: "A", rounds: [] })))).toEqual({
      rounds: ["Add at least two rounds"],
    });
  });

  test("a body that is not an object is reported at the root", async () => {
    expect(await errorsOf(new SchemaAgentRequest(jsonRequest([1, 2])))).toHaveProperty("");
  });
});
