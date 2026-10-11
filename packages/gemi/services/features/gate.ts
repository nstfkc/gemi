import { app } from "../../foundation/app";
import { FeatureManager } from "./FeatureManager";

/**
 * Whether something gated on `key` is on for the ambient request: `true` when
 * there is no gate. The one check behind every `feature` option that is not a
 * route's `.feature()` (#885): the remote MCP endpoint, an OAuth sign-in
 * provider, an MCP tool.
 *
 * Fails closed like every feature read: an undeclared key, a switch nobody has
 * turned on, or a store that has never loaded all answer `false`.
 */
export async function featureOn(key: string | undefined): Promise<boolean> {
  if (key === undefined) return true;
  return await app(FeatureManager).enabled(key);
}
