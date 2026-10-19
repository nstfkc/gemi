import type Api from "@/app/http/routes/api";
import type View from "@/app/http/routes/view";
import type I18nComponents from "@/app/i18n";
import type AppFeatures from "@/app/features";
import type Channels from "@/app/http/routes/channels";
import type * as AppModels from "@/app/models";

import type {
  ApiRouter,
  ChannelRouter,
  CreateBroadcastRPC,
  CreateFileRPC,
  CreateRPC,
  CreateViewRPC,
  ViewRouter,
} from "gemi/http";
import type { CreateI18nDictionary } from "gemi/client";
import type { CreateFeatures, FeatureRegistry } from "gemi/services";

/**
 * The augmentation that gives an application its own route, view, dictionary,
 * feature and broadcast channel types. Referenced by `client/index.ts` and `facades/index.ts`, so
 * importing from either is the whole of the wiring — an application maintains
 * nothing, and a capability added here reaches every application on upgrade.
 *
 * The cost of delivering it from inside the package is that it is no longer
 * opt-in: every program that imports `gemi/client` compiles this file, whether
 * or not it is an application. So the five imports above have to be allowed to
 * fail — a shared package in a monorepo, an app on a `src/` layout, an app using
 * a different alias, or a playground all reach here with no `@/app/*` mapping.
 * `app/features` and `app/http/routes/channels` are additionally optional
 * *within* an application: they are the two of the five an app can simply not
 * have.
 *
 * `Resolved` is what makes that safe, and the shape is load-bearing. An
 * unresolved import is `any`, and `CreateRPC<any>` does not terminate: it
 * surfaces as `TS2589 Type instantiation is excessively deep` reported *in the
 * application's own file*, which `skipLibCheck` cannot suppress because the
 * diagnostic is not in a declaration file. Guarding at the use site does not
 * help — `extends Resolved<Api, CreateRPC<Api>>` still instantiates `CreateRPC`
 * eagerly to pass it as an argument. The conditional has to wrap the
 * instantiation, which is why each of these is its own alias.
 *
 * With the alias present the behaviour is unchanged. Without it, the interfaces
 * stay empty and the application keeps the framework's own routes and nothing
 * more, which is the correct answer for a program that has no application in it.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

type AppRPC<T> = IsAny<T> extends true ? {} : T extends ApiRouter ? CreateRPC<T> : {};

type AppFileRPC<T> = IsAny<T> extends true ? {} : T extends ApiRouter ? CreateFileRPC<T> : {};

type AppViewRPC<T> = IsAny<T> extends true ? {} : T extends ViewRouter ? CreateViewRPC<T> : {};

type AppBroadcastRPC<T> =
  IsAny<T> extends true ? {} : T extends ChannelRouter ? CreateBroadcastRPC<T> : {};

type AppDictionary<T> = IsAny<T> extends true ? {} : CreateI18nDictionary<T>;

type AppFeatureMap<T> =
  IsAny<T> extends true ? {} : T extends FeatureRegistry ? CreateFeatures<T> : {};

// The app's typed `Json` columns (#995): each exported model class that
// declares `static $json`, under its export name (the model's name, as the
// `app/models` barrel exports it).
type AppJsonColumns<T> =
  IsAny<T> extends true
    ? {}
    : { [K in keyof T as T[K] extends { $json: object } ? K : never]: T[K] extends { $json: infer J } ? J : never };

// The app's typed scalar columns (#1001): each exported model class that
// declares `static $columns`, under its export name.
type AppScalarColumns<T> =
  IsAny<T> extends true
    ? {}
    : { [K in keyof T as T[K] extends { $columns: object } ? K : never]: T[K] extends { $columns: infer C } ? C : never };

declare module "gemi/orm" {
  export interface JsonColumns extends AppJsonColumns<typeof AppModels> {}
  export interface ScalarColumns extends AppScalarColumns<typeof AppModels> {}
}

declare module "gemi/client" {
  export interface RPC extends AppRPC<Api> {}
  export interface FileRPC extends AppFileRPC<Api> {}
  export interface ViewRPC extends AppViewRPC<View> {}
  export interface BroadcastRPC extends AppBroadcastRPC<Channels> {}
  export interface I18nDictionary extends AppDictionary<typeof I18nComponents> {}
  export interface Features extends AppFeatureMap<typeof AppFeatures> {}
}

// The same table as `RPC`, minus the framework's `/auth` routes, for
// `McpRouter.fromApiRoute` — see `McpRoutes` in `http/McpRouter.ts`. It lives
// on `gemi/http` because that is what an app's MCP file imports.
declare module "gemi/http" {
  export interface McpRoutes extends AppRPC<Api> {}
}
