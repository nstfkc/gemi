import type { HttpRequest } from "../http/HttpRequest";
import type { RealtimeClient, RealtimeSession } from "./providers/realtime";
import type { VoiceBridgeParams, VoiceDelegate } from "./VoiceBridge";

/**
 * What an `AgentController` sets for `this.voice(Controller)` (#921):
 *
 * ```ts
 * export class PageBuilderController extends AgentController<typeof siteAgent, PageBody> {
 *   agent = siteAgent;
 *   voice: VoiceConfig<PageBody> = {
 *     realtime: AzureOpenAIProvider.model("gpt-realtime-mini").realtime,
 *     start: async ({ req, body, threadId }) => {
 *       await chargeVoiceBlock(req);          // throw to refuse (402, 429…)
 *       return {
 *         session: { instructions: voiceFront(body), voice: "marin" },
 *         onUsage: (usage, info) => meter(info),
 *         onEnd: (summary) => settle(summary),
 *       };
 *     },
 *   };
 * }
 * ```
 */
export type VoiceConfig<Body extends object = Record<string, unknown>> = {
  /** A provider's realtime client, e.g. `AzureOpenAIProvider.model("gpt-realtime-mini").realtime`. */
  realtime: RealtimeClient;
  /** The delegate tool's name and description. */
  delegate?: VoiceDelegate;
  /**
   * Called on `POST /<route>` after `authorizeRequest`, before the call is
   * created: check credits, rate limits, a feature flag, and throw to refuse.
   * Answers the session's options.
   */
  start(
    context: VoiceStartContext<Body>,
  ): VoiceSessionOptions<Body> | Promise<VoiceSessionOptions<Body>>;
};

export type VoiceStartContext<Body extends object> = {
  req: HttpRequest<any, any>;
  /** The client's `body`, as `useVoiceSession` sent it. */
  body: Body;
  /** The thread the client named, checked by `authorizeRequest`. */
  threadId?: string;
  /** `req.ctx().user`: who delegated turns run as. */
  user: unknown;
  /** The client asked to start with push-to-talk (no voice activity detection). */
  pushToTalk: boolean;
};

/** One session's options, from `VoiceConfig.start`. */
export type VoiceSessionOptions<Body extends object> = Pick<
  VoiceBridgeParams<Body>,
  "limits" | "lines" | "progress" | "contextNote" | "onUsage" | "onTick" | "onEnd" | "onEvent"
> & {
  /** The thread delegated turns go to, when it is not the client's. Checked
   *  with `authorizeRequest` like the client's. */
  threadId?: string;
  /** Instructions, voice, turn detection, transcription… The bridge's tools
   *  are added to `tools`. */
  session?: RealtimeSession;
  /** Sent as `OpenAI-Safety-Identifier`: a hash of the user's id. */
  safetyIdentifier?: string;
};
