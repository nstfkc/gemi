import { register } from "gemi/orm";

import { UserModel } from "./generated";

// The generated base carries the query surface and the runtime metadata. This
// class is the place your own code goes: scopes, policies, observers, and any
// static an application wants to hang off the model.
//
// Queries return plain objects, never instances of this class — `select` makes
// that unavoidable, since a `Pick<User, "id">` hydrated as a `User` would carry
// methods reading fields the query never fetched.
export class User extends UserModel {}

// Re-registers the name against *this* class, replacing the generated base that
// `generated/index.ts` registered.
//
// This is not optional bookkeeping. A relation read resolves its target through
// the registry by name, so whatever is registered under "User" is the class that
// runs for every nested `include` — and if that is the generated base while your
// policy lives here, the policy applies to root queries and is skipped inside
// includes. Scoped one way, unscoped the other, with nothing to notice it.
//
// `Model.$exec` raises `UnregisteredPolicyClassError` if a class carrying
// policies is not the registered one, so forgetting this line fails loudly
// rather than leaking — but the line belongs next to every subclass regardless,
// because the same reasoning will apply to observers and hooks.
register("User", User);
