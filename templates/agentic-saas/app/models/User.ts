import { register } from "gemi/orm";

import { UserModel } from "./generated";

// The generated base carries the query surface and the runtime metadata. This
// class is the place your own code goes: scopes, policies, observers, and any
// static an application wants to hang off the model.
//
// Queries return plain objects, never instances of this class — `select` makes
// that unavoidable, since a `Pick<User, "id">` hydrated as a `User` would carry
// methods reading fields the query never fetched.
// Policies go in `$policies`, which is a list so that composition needs no
// intermediate class and no object spread:
//
//   import { softDeletes } from "gemi/orm"
//   import { UserPolicy } from "./generated"
//
//   export class User extends UserModel {
//     static $policies: UserPolicy[] = [
//       softDeletes<User>(),
//       { scope: (ctx) => ({ accounts: { some: { organizationId: orgOf(ctx) } } }),
//         onCreate: (ctx, data) => data,
//         onUpdate: (_ctx, data) => data },
//     ]
//   }
//
// The `UserPolicy` annotation is what types `ctx`, `data` and the returned
// `where` against this model — without it the entries are inferred from the
// literal and the parameters are implicitly `any`.
//
// The scope goes through `accounts` because that is where a membership lives: a
// user belongs to an organization by having an account in it, and may have
// several. `ctx.user` is the session user, which carries `accounts[].organization`
// and no `organizationId` of its own — so `ctx.user.organizationId` would be
// `undefined`, and an undefined value in a scope is an *absent* filter rather
// than an error. The scope would silently vanish and the read would return every
// tenant's rows. Whatever picks the current organization out of `ctx.user.accounts`
// is the application's own decision, which is what `orgOf` stands in for here.
export class User extends UserModel {}

// Registers the name against *this* class, replacing the generated base that
// `generated/index.ts` registered.
//
// `app/kernel/Kernel.ts` already does this for everything `app/models/index.ts`
// exports, so the line is no longer what makes the app correct — which is the
// point of listing the modules there. It is kept because this module is also
// imported on its own, by tests and by `app/preload.ts`, and in those the
// registry is whatever the imports made it.
//
// What it is protecting against, either way: a relation read resolves its target
// through the registry by name, so whatever is registered under "User" is the
// class that runs inside every nested `include`. If that is the generated base
// while a policy lives here, the policy applies to root queries and is skipped
// inside includes — scoped one way, unscoped the other, with nothing to notice
// it.
register("User", User);
