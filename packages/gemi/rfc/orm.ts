// class Schema<T> {
//   __brand = "Schema";
//   fields: T;
//   constructor(fields: T = {} as T) {
//     this.fields = fields;
//   }

//   static create<U>(fields: U) {
//     return new Schema<U>(fields);
//   }
// }

// class Model {
//   __brand = "Model";
//   schema: Schema<any>;

//   static findOne<T extends new () => Model>(
//     this: T,
//     fields: InstanceType<T>["schema"]["fields"],
//   ) {
//     // Simulate a database query
//     return new this();
//   }
// }

// class User extends Model {
//   schema = Schema.create({ name: "string", age: "number" });
// }

// User.findOne({ name: "enes", age: "30" });

class Field<T> {
  __brand = "Field";
  value: T;
}

class Table {
  __brand = "Table";
  __name: string;
}

class User extends Table {
  id = new Field<number>();
  name = new Field<string>();
  email = new Field<string>();
}

class Account extends Table {
  id = new Field<number>();
  userId = new Field<string>();
}

class Schema {
  tables: Record<string, new () => Table>;

  static table<
    T extends new () => Schema,
    const U extends keyof InstanceType<T>["tables"],
  >(this: T, tables: U) {}
}

class MySchema extends Schema {
  tables = {
    user: User,
    account: Account,
  };
}

MySchema.table("user");
