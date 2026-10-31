import type { User } from "../../auth/types";
import type { HttpRequest } from "../../http/HttpRequest";

/**
 * Requests that act for a user gemi already knows, without that user's
 * credentials: `AgentController.startTurn`'s, a turn the server starts (a
 * job carrying on a thread) for the user it was given (#1075). A local tool
 * call made inside one is dispatched as that user, an identity as a remote
 * caller's is, rather than by copying an access token the request does not
 * have. Only gemi's own code marks a request; a user signed in any other way
 * still crosses over to no tool call.
 */
const actingFor = new WeakMap<HttpRequest<any, any>, User>();

export function actFor(req: HttpRequest<any, any>, user: User) {
  actingFor.set(req, user);
}

export function userActedFor(req: HttpRequest<any, any>): User | undefined {
  return actingFor.get(req);
}
