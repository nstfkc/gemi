import {
  AgentTool,
  ToolNamespace,
  type AnyAgentTool,
  type ToolEntry,
  type ToolShapesOf,
} from "../../ai/Agent";
import { ToolError } from "../../ai/redact";
import type { McpRouteDeclaration, McpRouter } from "../../http/McpRouter";
import { RequestContext } from "../../http/requestContext";
import type { McpRegistry, McpToolDescriptor, McpToolFilter } from "./McpRegistry";

/** One namespace `toAgentTools` groups a tag's tools into. */
export type McpToolNamespaceOptions = {
  /**
   * What the model reads when deciding whether anything inside is worth
   * loading — the only description the group has. Required.
   */
  description: string;
  /** Overrides the top-level `deferred` for this namespace. */
  deferred?: boolean;
};

export type ToAgentToolsOptions = {
  /** Narrows the tools, as `McpRegistry.descriptors` does. */
  filter?: McpToolFilter;
  /**
   * Withholds the tools' parameter schemas until the model searches for them
   * (`ToolNamespace.deferred` for a namespace, `AgentTool.deferred` for a bare
   * tool). The default for every namespace and every bare tool; a namespace
   * may override it. Purely a prompt optimization: a provider without tool
   * search is sent every schema inline, and the agent behaves the same.
   */
  deferred?: boolean;
  /**
   * Groups the tools into `ToolNamespace`s by tag: each key is a tag, and the
   * namespace's name. A tool goes into the namespace of the first of its tags
   * declared here, in the order the keys are written — tool names are unique
   * within an agent, so it cannot be in two. A tool with none of these tags
   * stays a bare tool.
   */
  namespaces?: Record<string, McpToolNamespaceOptions>;
};

// --- types, read off the router (#771) ----------------------------------------

type RoutesOf<R> = R extends { routes: infer T } ? T : never;

/** Whether a filter's field narrows by literals, rather than by `string`s. */
type LiteralsOf<L> = L extends readonly (infer X)[] ? (string extends X ? never : X) : never;

/** Whether the tool `N`, declared as `D`, passes the filter `F`. */
type Passes<N, D, F> =
  // `names`: kept when the filter names it, or names only `string`s.
  (F extends { names: readonly string[] }
    ? [LiteralsOf<F["names"]>] extends [never]
      ? true
      : N extends LiteralsOf<F["names"]>
        ? true
        : false
    : true) extends true
    ? // `tags`: kept when one of its tags is filtered for, or either side's
      // tags are only `string`s.
      F extends { tags: readonly string[] }
      ? [LiteralsOf<F["tags"]>] extends [never]
        ? true
        : D extends McpRouteDeclaration<any, any, any, any, infer T>
          ? [LiteralsOf<T>] extends [never]
            ? true
            : [Extract<LiteralsOf<T>, LiteralsOf<F["tags"]>>] extends [never]
              ? false
              : true
          : true
      : true
    : false;

/**
 * The tools of the router `R` that pass the filter `F`, as `toAgentTools`
 * builds them: named by their `routes` key, with the input the model sends and
 * the output the tool answers. An untyped router (`McpRouter<any>`, what the
 * container answers) gives `AnyAgentTool`, as before.
 */
export type McpAgentTool<R extends McpRouter<any>, F = {}> =
  string extends keyof RoutesOf<R>
    ? AnyAgentTool
    : {
        [N in keyof RoutesOf<R> & string]: Passes<N, RoutesOf<R>[N], F> extends true
          ? RoutesOf<R>[N] extends McpRouteDeclaration<any, any, infer I, infer O, any>
            ? AgentTool<N, I, O, never>
            : never
          : never;
      }[keyof RoutesOf<R> & string];

/**
 * The client's shapes of the router's tools, as `ToolShapesOf` gives them for
 * an agent holding `toAgentTools(registry, { filter: F })`. For a chat built
 * on its tools alone; an agent mixing them with its own tools gets them from
 * `ToolShapesOf<typeof agent.tools>`.
 */
export type McpToolShapesOf<R extends McpRouter<any>, F = {}> = ToolShapesOf<
  McpAgentTool<R, F>[]
>;

/** What the grouped call answers: namespaces of the tools, and the bare ones. */
type McpToolEntry<R extends McpRouter<any>, F> =
  string extends keyof RoutesOf<R>
    ? ToolEntry
    : ToolNamespace<string, readonly McpAgentTool<R, F>[]> | McpAgentTool<R, F>;

type FilterOf<O> = O extends { filter: infer F } ? F : {};

/** Namespace names are sent to the provider the way tool names are. */
const NAMESPACE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The registry's tools as `AgentTool`s, for an agent running in this server —
 * v1's only projection.
 *
 * Build them once and hand them to `Agent.create`. None of them holds a user:
 * the caller is `{ kind: "local", req }`, where `req` is the request the run is
 * executing inside, taken when the tool executes, so the same tools run as
 * whichever user's run calls them. That is the reason the caller is not an
 * argument here.
 *
 * AMBIENT, AND ONLY HERE. A run is not given a request (see `AgentContext`),
 * but these tools have no other way to act as a user: the route is dispatched
 * with the initiator's own credentials, and those live on the request. A run
 * started by `AgentController` executes inside its request, which the run holds
 * open until it settles, so the request is there to read. A run started from a
 * job or a script has none, and these tools refuse there with a sentence
 * saying so rather than dispatching as nobody.
 *
 * `requiresApproval` comes from the route's meta, where the app wrote it down;
 * it is never inferred from the verb.
 *
 * A failure the model should read — a 4xx, a missing file, a bad argument —
 * throws a `ToolError` (`McpToolError` is one), whose message is shown, and the agent loop turns a throw into a `tool_error` result the model
 * sees and can correct on its next step.
 *
 * Grouped (#758): with `namespaces`, the tools come back as `ToolNamespace`s
 * by tag, followed by the bare tools left over, ready for `Agent.create`'s
 * `tools`:
 *
 * ```ts
 * toAgentTools(registry, {
 *   namespaces: {
 *     pages: { description: "Read and edit the pages of the site" },
 *     files: { description: "Upload, list and delete files" },
 *   },
 *   deferred: true,
 * });
 * ```
 *
 * The second argument is read as options when it has `filter`, `deferred` or
 * `namespaces`, and as a filter otherwise, so `toAgentTools(registry, filter)`
 * is unchanged.
 *
 * Typed (#771): given the app's router type, the tools keep their names,
 * inputs and outputs, so the client's `ToolShapesOf<typeof agent.tools>` types
 * their parts. A literal `filter` narrows them as it narrows the tools:
 *
 * ```ts
 * const registry = app(McpRegistry) as McpRegistry<SiteMcpRouter>;
 * toAgentTools(registry, { filter: { tags: ["collections"] } });
 * // AgentTool<"listCollections", { page: string | null }, { name: string }[]> | …
 * ```
 *
 * `toAgentTools<SiteMcpRouter>(app(McpRegistry), …)` types them too, but an
 * explicit type argument leaves the filter uninferred: every tool of the
 * router is in the type. An untyped registry answers `AnyAgentTool`s, as
 * before.
 */
export function toAgentTools<
  R extends McpRouter<any> = McpRouter<any>,
  const F extends McpToolFilter = {},
>(registry: McpRegistry<R> | McpRegistry, filter?: F): McpAgentTool<R, F>[];
export function toAgentTools<
  R extends McpRouter<any> = McpRouter<any>,
  const O extends ToAgentToolsOptions & {
    namespaces: Record<string, McpToolNamespaceOptions>;
  } = ToAgentToolsOptions & { namespaces: Record<string, McpToolNamespaceOptions> },
>(registry: McpRegistry<R> | McpRegistry, options: O): McpToolEntry<R, FilterOf<O>>[];
export function toAgentTools<
  R extends McpRouter<any> = McpRouter<any>,
  const O extends ToAgentToolsOptions & { namespaces?: undefined } = ToAgentToolsOptions & {
    namespaces?: undefined;
  },
>(registry: McpRegistry<R> | McpRegistry, options: O): McpAgentTool<R, FilterOf<O>>[];
/** Options whose `namespaces` is not known statically: either shape. */
export function toAgentTools<R extends McpRouter<any> = McpRouter<any>>(
  registry: McpRegistry<R> | McpRegistry,
  options: ToAgentToolsOptions,
): McpToolEntry<R, FilterOf<ToAgentToolsOptions>>[];
export function toAgentTools(
  registry: McpRegistry,
  arg?: McpToolFilter | ToAgentToolsOptions,
): AnyAgentTool[] | ToolEntry[] {
  const options: ToAgentToolsOptions = isOptions(arg) ? arg : { filter: arg };
  const deferred = options.deferred === true;
  const descriptors = registry.descriptors(options.filter);

  if (!options.namespaces) {
    return descriptors.map((descriptor) => agentTool(registry, descriptor, deferred));
  }

  const declared = Object.entries(options.namespaces);
  const known = new Set(registry.descriptors().flatMap((descriptor) => descriptor.tags));
  for (const [tag, namespace] of declared) {
    if (!NAMESPACE_NAME.test(tag)) {
      throw new Error(
        `toAgentTools: "${tag}" is not a valid namespace name. A namespace is named by its tag and sent to the provider as a tool name is — letters, digits, "_" and "-", at most 64.`,
      );
    }
    if (typeof namespace?.description !== "string" || namespace.description.trim() === "") {
      throw new Error(
        `toAgentTools: the namespace "${tag}" needs a description. It is what the model reads to decide whether to look inside.`,
      );
    }
    // Checked against every tool, not the filtered ones: a filter may leave a
    // namespace empty on purpose, but a tag no tool carries is a typo, and a
    // typo here would silently leave its tools bare.
    if (!known.has(tag)) {
      throw new Error(`toAgentTools: no tool is tagged "${tag}", so its namespace would be empty.`);
    }
  }

  const grouped = new Map<string, AnyAgentTool[]>(declared.map(([tag]) => [tag, []]));
  const bare: AnyAgentTool[] = [];
  for (const descriptor of descriptors) {
    const tag = declared.find(([name]) => descriptor.tags.includes(name))?.[0];
    if (tag === undefined) {
      bare.push(agentTool(registry, descriptor, deferred));
    } else {
      // Deferral is the namespace's, not the tool's: `ToolNamespace.deferred`
      // covers its members, and a member deferred on its own would stay
      // deferred under a namespace that set `deferred: false`.
      grouped.get(tag)!.push(agentTool(registry, descriptor, false));
    }
  }

  const entries: ToolEntry[] = [];
  for (const [tag, namespace] of declared) {
    const tools = grouped.get(tag)!;
    // Emptied by the filter. A namespace with nothing in it is a description
    // the model would search for nothing.
    if (tools.length === 0) continue;
    entries.push(
      ToolNamespace.create({
        name: tag,
        description: namespace.description,
        tools,
        deferred: namespace.deferred ?? deferred,
      }),
    );
  }
  return [...entries, ...bare];
}

function isOptions(arg: unknown): arg is ToAgentToolsOptions {
  return (
    typeof arg === "object" &&
    arg !== null &&
    ("filter" in arg || "namespaces" in arg || "deferred" in arg)
  );
}

function agentTool(
  registry: McpRegistry,
  descriptor: McpToolDescriptor,
  deferred: boolean,
): AnyAgentTool {
  return AgentTool.create({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
    requiresApproval: descriptor.requiresApproval,
    deferred,
    execute: (input, ctx) => {
      const req = RequestContext.getStore()?.req;
      if (!req) {
        throw new ToolError(
          `"${descriptor.name}" calls an api route as the user who started this run, and this run was not started inside a request. Run it from an AgentController, or give this agent tools that do not go through the MCP registry.`,
        );
      }
      return registry.execute({ kind: "local", req }, descriptor.name, input, ctx);
    },
  });
}
