import { describe, expectTypeOf, test } from "vitest";

import { s } from "gemi/ai";
import type {
  CreateInput,
  ModelTypeInfo,
  Payload,
  Row,
  UpdateInput,
  WhereInput,
} from "gemi/orm";

import type { UserTypes } from "./generated";

/**
 * Typed scalar columns (#1001), at the type level: a `String` column
 * declared in `static $columns` reads as its schema's output and writes as
 * its input, in the default selection, a `select`, an `omit` and an
 * `include`, while `where` keeps the raw `String` filter. A column without a
 * schema keeps `string`.
 *
 * `gemi.d.ts` fills `ScalarColumns` from the app's `app/models` barrel. This
 * augments it by hand under a model name nothing else uses, with the
 * descriptor the generator emits for
 *
 *     model ScDoc  { id Int @id  format String  style String?  mood String?  loose String  plain String  notes ScNote[] }
 *     model ScNote { id Int @id  docId Int  doc ScDoc @relation(...)  format String }
 */

const FORMATS = ["post", "story", "reel"] as const;
const DocColumns = {
  format: s.enum(FORMATS),
  style: s.enum(["minimal", "bold"]),
  mood: { schema: s.enum(["calm", "warm"]), invalid: "null" as const },
  loose: { schema: s.enum(["a", "b"]), invalid: (_value: unknown) => "a" as const },
};
const NoteColumns = { format: { schema: s.enum(FORMATS), invalid: "null" as const } };

declare module "gemi/orm" {
  interface ScalarColumns {
    ScDoc: typeof DocColumns;
    ScNote: typeof NoteColumns;
  }
}

interface NoteTypes extends ModelTypeInfo {
  name: "ScNote";
  scalars: { id: number; docId: number; format: string };
  relations: { doc: { kind: "one"; nullable: false; target: DocTypes } };
  unique: { id: number };
  create: { id?: number; docId: number; format: string };
}

interface DocTypes extends ModelTypeInfo {
  name: "ScDoc";
  scalars: {
    id: number;
    format: string;
    style: string | null;
    mood: string | null;
    loose: string;
    plain: string;
  };
  relations: { notes: { kind: "many"; nullable: false; target: NoteTypes } };
  unique: { id: number };
  create: {
    id?: number;
    format: string;
    style?: string | null;
    mood?: string | null;
    loose: string;
    plain: string;
  };
}

type Format = (typeof FORMATS)[number];

describe("reads", () => {
  test("the default selection", () => {
    type R = Payload<DocTypes, {}>;
    expectTypeOf<R["format"]>().toEqualTypeOf<Format>();
    expectTypeOf<R["style"]>().toEqualTypeOf<"minimal" | "bold" | null>();
    expectTypeOf<R["mood"]>().toEqualTypeOf<"calm" | "warm" | null>();
    expectTypeOf<R["loose"]>().toEqualTypeOf<"a" | "b">();
    expectTypeOf<R["plain"]>().toEqualTypeOf<string>();
    expectTypeOf<Row<DocTypes>["format"]>().toEqualTypeOf<Format>();
  });

  test('invalid: "null" adds null even on a column that is not nullable', () => {
    expectTypeOf<Payload<NoteTypes, {}>["format"]>().toEqualTypeOf<Format | null>();
  });

  test("select, omit and include", () => {
    expectTypeOf<Payload<DocTypes, { select: { format: true } }>>().toEqualTypeOf<{ format: Format }>();
    expectTypeOf<
      Payload<DocTypes, { omit: { style: true; mood: true; loose: true; plain: true } }>
    >().toEqualTypeOf<{ id: number; format: Format }>();
    type WithNotes = Payload<DocTypes, { include: { notes: true } }>;
    expectTypeOf<WithNotes["notes"][number]["format"]>().toEqualTypeOf<Format | null>();
    type Selected = Payload<DocTypes, { select: { notes: { select: { format: true } } } }>;
    expectTypeOf<Selected>().toEqualTypeOf<{ notes: { format: Format | null }[] }>();
  });
});

describe("writes", () => {
  test("create takes the schema's type and keeps the optional split", () => {
    expectTypeOf<CreateInput<DocTypes>["format"]>().toEqualTypeOf<Format>();
    expectTypeOf<CreateInput<DocTypes>["style"]>().toEqualTypeOf<"minimal" | "bold" | null | undefined>();
    // `invalid: "null"` is about reads: a write still takes the schema's type.
    expectTypeOf<CreateInput<NoteTypes>["format"]>().toEqualTypeOf<Format>();
    expectTypeOf<CreateInput<DocTypes>["plain"]>().toEqualTypeOf<string>();

    const ok: CreateInput<DocTypes> = { format: "post", loose: "a", plain: "anything" };
    // @ts-expect-error a format the schema does not know
    const bad: CreateInput<DocTypes> = { format: "video", loose: "a", plain: "x" };
    // @ts-expect-error a required typed column is still required
    const missing: CreateInput<DocTypes> = { loose: "a", plain: "x" };
    void ok;
    void bad;
    void missing;
  });

  test("update takes the schema's type and { set }", () => {
    expectTypeOf<NonNullable<UpdateInput<DocTypes>["format"]>>().toEqualTypeOf<Format | { set?: Format }>();
    const ok: UpdateInput<DocTypes> = { format: { set: "reel" }, style: null };
    // @ts-expect-error a format the schema does not know
    const bad: UpdateInput<DocTypes> = { format: "video" };
    // @ts-expect-error null on a non-nullable column
    const nulled: UpdateInput<DocTypes> = { format: null };
    void ok;
    void bad;
    void nulled;
  });
});

describe("filters keep the String filter", () => {
  test("any string, and string operators, on a typed column", () => {
    const where: WhereInput<DocTypes> = { format: { in: ["retired", "post"] }, style: { startsWith: "b" } };
    const plain: WhereInput<DocTypes> = { format: "retired" };
    void where;
    void plain;
  });
});

describe("a generated model without $columns", () => {
  test("carries its name and keeps string", () => {
    expectTypeOf<UserTypes["name"]>().toEqualTypeOf<"User">();
    expectTypeOf<Payload<UserTypes, {}>["email"]>().toEqualTypeOf<string | null>();
  });
});
