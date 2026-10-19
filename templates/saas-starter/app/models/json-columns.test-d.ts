import { describe, expectTypeOf, test } from "vitest";

import { s } from "gemi/ai";
import type {
  CreateInput,
  JsonColumnInput,
  JsonColumnTypes,
  JsonInput,
  JsonValue,
  ModelTypeInfo,
  Payload,
  UpdateInput,
  WhereInput,
} from "gemi/orm";
import { type DbNull, JsonNull } from "gemi/orm";

import type { UserTypes } from "./generated";

/**
 * Typed `Json` columns (#995), at the type level: a column declared in
 * `static $json` reads as its schema's output and writes as its input, in
 * the default selection, a `select` and an `omit`, while filters keep the
 * raw `Json` filter. A column without a schema keeps `JsonValue`.
 *
 * `gemi.d.ts` fills `JsonColumns` from the app's `app/models` barrel. This
 * augments it by hand under a model name nothing else uses, with the
 * descriptor the generator emits for
 *
 *     model TypedDoc { id Int @id  body Json  meta Json?  loose Json?  raw Json }
 */

const Body = s.object({ title: s.string(), tags: s.array(s.string()) });
const Meta = s.object({ views: s.number() });
const DocJson = {
  body: Body,
  meta: Meta,
  loose: { schema: Meta, invalid: "null" as const },
};

declare module "gemi/orm" {
  interface JsonColumns {
    TypedDoc: typeof DocJson;
  }
}

type Scalars = { id: number; body: JsonValue; meta: JsonValue | null; loose: JsonValue | null; raw: JsonValue };

interface DocTypes extends ModelTypeInfo {
  scalars: Scalars;
  relations: {};
  unique: { id: number };
  create: {
    id: number;
    body: JsonColumnInput<"TypedDoc", "body", false>;
    meta?: JsonColumnInput<"TypedDoc", "meta", true>;
    loose?: JsonColumnInput<"TypedDoc", "loose", true>;
    raw: JsonColumnInput<"TypedDoc", "raw", false>;
  };
  json: {
    body: JsonColumnTypes<"TypedDoc", "body", false>;
    meta: JsonColumnTypes<"TypedDoc", "meta", true>;
    loose: JsonColumnTypes<"TypedDoc", "loose", true>;
    raw: JsonColumnTypes<"TypedDoc", "raw", false>;
  };
}

type BodyOut = { title: string; tags: string[] };

describe("reads", () => {
  test("the default selection", () => {
    type Row = Payload<DocTypes, {}>;
    expectTypeOf<Row["body"]>().toEqualTypeOf<BodyOut>();
    expectTypeOf<Row["meta"]>().toEqualTypeOf<{ views: number } | null>();
    expectTypeOf<Row["raw"]>().toEqualTypeOf<JsonValue>();
  });

  test('invalid: "null" adds null even on a column that is not nullable', () => {
    expectTypeOf<JsonColumnTypes<"TypedDoc", "loose", false>["output"]>().toEqualTypeOf<{
      views: number;
    } | null>();
  });

  test("select and omit", () => {
    expectTypeOf<Payload<DocTypes, { select: { body: true } }>>().toEqualTypeOf<{ body: BodyOut }>();
    expectTypeOf<Payload<DocTypes, { omit: { raw: true; meta: true; loose: true } }>>().toEqualTypeOf<{
      id: number;
      body: BodyOut;
    }>();
  });
});

describe("writes", () => {
  test("create and update take the schema's type and the null sentinels", () => {
    // The null markers only on a nullable column.
    expectTypeOf<CreateInput<DocTypes>["body"]>().toEqualTypeOf<BodyOut>();
    expectTypeOf<NonNullable<UpdateInput<DocTypes>["body"]>>().toEqualTypeOf<BodyOut>();
    expectTypeOf<NonNullable<UpdateInput<DocTypes>["meta"]>>().toEqualTypeOf<
      { views: number } | typeof DbNull | typeof JsonNull
    >();
    expectTypeOf<CreateInput<DocTypes>["raw"]>().toEqualTypeOf<JsonInput>();

    const ok: UpdateInput<DocTypes> = { body: { title: "t", tags: [] } };
    // @ts-expect-error not the schema's shape
    const bad: UpdateInput<DocTypes> = { body: { title: 1 } };
    // @ts-expect-error JsonNull on a non-nullable typed column
    const nulled: UpdateInput<DocTypes> = { body: JsonNull };
    void ok;
    void bad;
    void nulled;
  });
});

describe("filters stay Json filters", () => {
  test("path and equals on a typed column", () => {
    const where: WhereInput<DocTypes> = { body: { path: ["title"], equals: "x" } };
    void where;
  });
});

describe("a generated model without a schema", () => {
  test("keeps JsonValue", () => {
    expectTypeOf<Payload<UserTypes, {}>["metadata"]>().toEqualTypeOf<JsonValue | null>();
  });
});
