import { FeatureFlagModel } from "./generated";

/**
 * The feature flag control plane.
 *
 * Read by the framework through the ORM registry, under the name
 * `"FeatureFlag"` — which is why the barrel export in `./index.ts` matters more
 * than usual here: without it the generated base keeps the name, and any policy
 * declared on this class would be invisible to the read.
 *
 * **No tenant policy, deliberately.** Flags are global application
 * configuration, not customer data: the store loads the whole table once per TTL
 * from a background refresh, outside any request and with no user, and the
 * evaluator is what decides who each flag applies to. A `scope` here would make
 * that load return nothing.
 *
 * If this table ever needs to be readable by an admin UI, put the authorization
 * on the route, not on the model.
 */
export class FeatureFlag extends FeatureFlagModel {}
