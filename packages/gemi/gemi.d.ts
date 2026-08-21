import type Api from "@/app/http/routes/api";
import type View from "@/app/http/routes/view";
import type I18nComponents from "@/app/i18n";
import type AppFeatures from "@/app/features";

import type { ApiRouter, CreateRPC, CreateViewRPC, ViewRouter } from "gemi/http";
import type { CreateI18nDictionary } from "gemi/client";
import type { CreateFeatures, FeatureRegistry } from "gemi/services";

/**
 * The augmentation that gives an application its own route, view, dictionary
 * and feature types. Referenced by `client/index.ts` and `facades/index.ts`, so
 * importing from either is the whole of the wiring — an application maintains
 * nothing, and a capability added here reaches every application on upgrade.
 *
 * The cost of delivering it from inside the package is that it is no longer
 * opt-in: every program that imports `gemi/client` compiles this file, whether
 * or not it is an application. So the four imports above have to be allowed to
 * fail — a shared package in a monorepo, an app on a `src/` layout, an app using
 * a different alias, or a playground all reach here with no `@/app/*` mapping.
 * `app/features` is additionally optional *within* an application: it is the one
 * of the four an app can simply not have.
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

type AppViewRPC<T> = IsAny<T> extends true ? {} : T extends ViewRouter ? CreateViewRPC<T> : {};

type AppDictionary<T> = IsAny<T> extends true ? {} : CreateI18nDictionary<T>;

type AppFeatureMap<T> =
  IsAny<T> extends true ? {} : T extends FeatureRegistry ? CreateFeatures<T> : {};

declare module "gemi/client" {
  export interface RPC extends AppRPC<Api> {}
  export interface ViewRPC extends AppViewRPC<View> {}
  export interface I18nDictionary extends AppDictionary<typeof I18nComponents> {}
  export interface Features extends AppFeatureMap<typeof AppFeatures> {}
}
