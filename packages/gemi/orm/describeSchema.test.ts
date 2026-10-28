import { afterEach, describe, expect, test } from "vitest";
import { describeSchema, describeSchemaModels } from "./describeSchema";
import * as registry from "./registry";
import type { FieldSchema, ModelSchema } from "./schema";

// `describeSchema` (#1065): the models as prompt-ready text.

const field = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  column: name,
  type: "String",
  nullable: false,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});

const User: ModelSchema = {
  name: "User",
  table: "users",
  fields: {
    id: field("id", { type: "Int", isId: true }),
    email: field("email"),
    name: field("name", { nullable: true }),
    passwordHash: field("passwordHash", { column: "password_hash", sensitive: true }),
    apiKey: field("apiKey", { nullable: true, encrypted: true }),
    role: field("role", { enum: "Role" }),
    tags: field("tags", { isList: true }),
    createdAt: field("createdAt", { type: "DateTime", column: "created_at" }),
  },
  primaryKey: ["id"],
  uniques: [["email"]],
  relations: {
    posts: { name: "posts", model: "Post", kind: "many", relationName: "UserPosts", from: [], to: [], nullable: false },
  },
};

const Post: ModelSchema = {
  name: "Post",
  table: "Post",
  fields: {
    id: field("id", { type: "Int", isId: true }),
    authorId: field("authorId", { type: "Int", column: "author_id" }),
    slug: field("slug"),
    orgId: field("orgId", { type: "Int" }),
  },
  primaryKey: ["id"],
  uniques: [["orgId", "slug"]],
  relations: {
    author: {
      name: "author",
      model: "User",
      kind: "one",
      relationName: "UserPosts",
      from: ["authorId"],
      to: ["id"],
      nullable: false,
    },
    tags: {
      name: "tags",
      model: "Tag",
      kind: "many",
      relationName: "PostToTag",
      from: [],
      to: [],
      nullable: false,
      joinTable: { table: "_PostToTag", a: "A", b: "B" },
    },
  },
};

const Tag: ModelSchema = {
  name: "Tag",
  table: "Tag",
  fields: { id: field("id", { type: "Int", isId: true }), label: field("label") },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};

const schemas = [User, Post, Tag];

afterEach(() => registry.clearRegistry());

describe("describeSchema (#1065)", () => {
  test("one line per model, with columns, keys, relations and the sensitive legend", () => {
    expect(describeSchema({ schemas })).toBe(
      [
        'User table "users": id:Int [pk], email:String [unique], name:String?, ' +
          "passwordHash@password_hash:String [sensitive], apiKey:String? [sensitive], " +
          "role:Role(enum), tags:String[], createdAt@created_at:DateTime; " +
          "relations: posts -> Post[]",
        'Post table "Post": id:Int [pk], authorId@author_id:Int, slug:String, orgId:Int; ' +
          "unique (orgId, slug); relations: author -> User on author_id = User.id, " +
          'tags -> Tag[] via "_PostToTag"',
        'Tag table "Tag": id:Int [pk], label:String',
        "Columns marked [sensitive] hold secrets: never select them.",
      ].join("\n"),
    );
  });

  test("sensitiveColumns: omit leaves them out, and the legend with them", () => {
    const text = describeSchema({ schemas, sensitiveColumns: "omit", models: ["User"] });
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("[sensitive]");
    expect(text).toContain("email:String [unique]");
  });

  test("sensitive marks more fields, exclude drops models and fields", () => {
    const text = describeSchema({
      schemas,
      sensitive: ["Post.slug"],
      exclude: ["Tag", "User.tags", "Post.author"],
    });
    expect(text).toContain("slug:String [sensitive]");
    expect(text).not.toContain("Tag table");
    expect(text).not.toContain("tags:String[]");
    // The relation into an excluded model goes too.
    expect(text).not.toContain("_PostToTag");
    expect(text).not.toContain("author ->");
  });

  test("models picks some, and an unknown name is refused", () => {
    expect(describeSchema({ schemas, models: ["Tag"] })).toBe('Tag table "Tag": id:Int [pk], label:String');
    expect(() => describeSchema({ schemas, models: ["Nope"] })).toThrow(/no model named "Nope"/);
  });

  test("takes the generated module as is, skipping its other exports", () => {
    const generated = { ARTIFACT_VERSION: 2, User, Post, Tag };
    expect(describeSchema({ schemas: generated })).toBe(describeSchema({ schemas }));
  });

  test("defaults to the registered models, each once", () => {
    registry.register("User", { $schema: User });
    registry.register("UserModel", { $schema: User });
    registry.register("Tag", { $schema: Tag });
    registry.register("NotAModel", {});
    expect(describeSchemaModels().map((model) => model.name)).toEqual(["User", "Tag"]);
  });

  test("the structured form has database names and flags", () => {
    const [user, post] = describeSchemaModels({ schemas });
    expect(user!.columns.find((column) => column.field === "passwordHash")).toEqual({
      field: "passwordHash",
      column: "password_hash",
      type: "String",
      nullable: false,
      primaryKey: false,
      unique: false,
      list: false,
      sensitive: true,
    });
    expect(post!.relations[0]).toEqual({
      name: "author",
      model: "User",
      kind: "one",
      nullable: false,
      from: ["author_id"],
      to: ["id"],
    });
    expect(post!.uniques).toEqual([["orgId", "slug"]]);
  });
});
