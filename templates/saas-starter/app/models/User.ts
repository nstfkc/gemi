import { UserModel } from "./generated";

// The generated base carries the query surface and the runtime metadata. This
// class is the place your own code goes: scopes, policies, observers, and any
// static an application wants to hang off the model.
//
// Queries return plain objects, never instances of this class — `select` makes
// that unavoidable, since a `Pick<User, "id">` hydrated as a `User` would carry
// methods reading fields the query never fetched.
export class User extends UserModel {}
