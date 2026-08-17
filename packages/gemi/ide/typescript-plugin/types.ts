/** The `plugins` entry's options in an app's `tsconfig.json`. */
export interface GemiPluginConfig {
  /**
   * Directory the app's `app/` folder sits in. Defaults to the directory
   * holding the `tsconfig.json` that enabled the plugin, which is right unless
   * the two have been separated.
   */
  projectRoot?: string;
  /** Overrides `<projectRoot>/app/views` as where view components are found. */
  viewsDir?: string;
  /** Set to `false` to disable without editing the `plugins` array. */
  enable?: boolean;
}

export type HttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Span {
  start: number;
  length: number;
}

export type TargetKind =
  /** A method on a `Controller` — `this.get(HomeController, "index")`. */
  | "controller-method"
  /** An inline callback — `this.get(() => ...)`. */
  | "inline-handler"
  /** A view's React component file — `this.view("auth/SignIn")`. */
  | "view-component"
  /**
   * The `routes` entry itself. Used when nothing more precise resolves, so a
   * jump always lands somewhere useful rather than doing nothing.
   */
  | "route-entry";

export interface RouteTarget {
  fileName: string;
  /** What to select on arrival — a handler's name, not its whole body. */
  span: Span;
  /** The surrounding declaration; editors use it to frame the landing span. */
  contextSpan?: Span;
  name: string;
  containerName: string;
  kind: TargetKind;
}

interface RouteEntryBase {
  path: string;
  targets: RouteTarget[];
  /**
   * Whether the route reaches the client's RPC types. `file`, `stream` and
   * `proxy` routes are real routes that `CreateRPC` drops, so no typed call
   * site can name them — they are indexed anyway, for hardcoded URLs.
   */
  inRpc: boolean;
}

export interface ApiRouteEntry extends RouteEntryBase {
  verb: HttpVerb;
}

export interface ViewRouteEntry extends RouteEntryBase {
  kind: "view" | "layout";
}

export interface RouteTable {
  /** Path → one entry per verb declared at it. */
  api: Map<string, ApiRouteEntry[]>;
  /** Path → its view entry, plus the layout entry when a layout shares the path. */
  views: Map<string, ViewRouteEntry[]>;
  /**
   * Every file whose contents the table was derived from. The plugin rebuilds
   * when one of them changes and reuses the table when none has.
   */
  dependencies: string[];
  /** Non-fatal problems worth surfacing in the tsserver log. */
  diagnostics: string[];
}
