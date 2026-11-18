import {
  ApiRouter as Router,
  type CreateRawHttpOutputs as Raw,
} from "../../../../../http/ApiRouter";
export type { ApiRouterHandler, CreateRPC, HttpMethod } from "../../../../../http/ApiRouter";

// Simulate a new route kind understood by CreateRPC before the raw-output projection.
export type CreateRawHttpOutputs<T extends Router> = Omit<Raw<T>, "GET:/missing">;

export class ApiRouter extends Router {}
export default class PartialApi extends ApiRouter {
  routes = {
    "/missing": this.get(() => "ok"),
    "/throws": this.get((): never => {
      throw new Error("no success response");
    }),
  };
}
