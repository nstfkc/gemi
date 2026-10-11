# AI Voice

Voice conversations on OpenAI's Realtime API and Azure OpenAI's GA realtime surface. The browser sends and receives audio over WebRTC, straight to the vendor. Your server starts the call with its own key and keeps a control connection to it (the sideband), where tool calls run and usage arrives.

```
browser ──WebRTC audio + data channel──▶ OpenAI / Azure Realtime
   │ SDP offer                                  ▲ sideband WebSocket (call_id)
   ▼                                            │
your route ── createCall (server key) ──────────┘
     └─ sideband: tool calls, usage, hang-up
```

No key or ephemeral secret reaches the browser, and the browser doesn't choose the model or the instructions when the call starts. Usage comes to the server on the sideband, so metering doesn't depend on what a browser reports, and the server can end the call.

**What the browser still sees and can do.** The data channel delivers `session.created` / `session.updated`, which carry the full instructions and tool schemas, so instructions must not hold secrets. The browser can also send its own `session.update`, and `response.create` with per-response instructions or tools. The prompt doesn't limit a misbehaving client. Metering on the sideband and your own limits do. On Azure, `createCall({ webrtcFilter: true })` keeps the instructions and function calls off the data channel.

> **Experimental.** Everything on this page may change in a minor release until a live call has run on Azure and on OpenAI. Both sides follow the vendors' GA documentation and are tested against recorded protocol fixtures only. On Azure, that's `/openai/v1/realtime/client_secrets`, `/calls` and the `call_id` sideband. Azure doesn't document `/realtime/calls/{id}/hangup`, so the hangup on Azure is the least certain part.

## Realtime calls on a provider

`OpenAIProvider` and `AzureOpenAIProvider` have a `realtime` property. Build the provider with a realtime model (on Azure, the realtime deployment): it becomes the call's default model.

```typescript
import { AzureOpenAIProvider, OpenAIProvider } from "gemi/ai";

const voice = AzureOpenAIProvider.model("gpt-realtime-mini", { deployment: "voice" }).realtime;
// or: OpenAIProvider.model("gpt-realtime-mini").realtime
```

The host, credential (`api-key`, `Bearer` or an Entra token per request) and resource come from the same config and `AZURE_OPENAI_*` / `OPENAI_*` variables as text calls. On Azure, realtime always uses the GA `/openai/v1/realtime` path with no `api-version`, even when `apiVersion` pins a dated version for text calls.

| Method | |
|---|---|
| `createCall({ sdp, session?, safetyIdentifier?, flow?, webrtcFilter?, signal? })` | Starts a WebRTC call from the browser's SDP offer, server-side, and answers `{ sdpAnswer, callId }`. A 429 or 5xx is retried, a timeout is not. See [Call flows](#call-flows). |
| `sideband(callId, options?)` | Opens the call's control WebSocket (`wss://…/realtime?call_id=…`). See below. |
| `hangup(callId)` | Ends the call for everyone. A 404 counts as "already over" only when its body says the call wasn't found. Any other 404, such as a route the vendor doesn't serve, throws, so you never stop metering a call that's still running. |
| `clientSecret({ session?, ttlSeconds? })` | An ephemeral secret (`/realtime/client_secrets`, 10–7200 seconds, default 600) for apps that let the browser connect on its own. The browser then receives the function calls and its usage can't be trusted, so prefer `createCall` and the sideband. |

### Call flows

Both flows run on your server, and neither hands the browser a credential.

| `flow` | Requests | Default on |
|---|---|---|
| `"unified"` | One multipart `POST /realtime/calls` (`sdp` + `session`) with the server's key. | `OpenAIProvider` (OpenAI documents this one) |
| `"ephemeral"` | `POST /realtime/client_secrets` with the server's credential, carrying the session. Then `POST /realtime/calls` with `Authorization: Bearer <secret>`, `Content-Type: application/sdp` and the raw SDP. Expects 201 and `Location`. | `AzureOpenAIProvider` (Azure documents this one) |

The secret behind an ephemeral call lives 60 seconds and is used once, by the server. Pass `flow` to `createCall` to use the other flow on a provider.

`webrtcFilter: true` (Azure only) adds `?webrtcfilter=on`. The browser's data channel then carries no instructions, function calls or `response.done`. That keeps the prompt private, but the browser can no longer tell from events alone that work is running.

Failures are a `RealtimeRequestError` with the normalized `code` (`rate_limited`, `provider_error`, …), `retryable` and the HTTP `status`.

`safetyIdentifier` is sent as `OpenAI-Safety-Identifier`. Pass a hash of the user's id so the vendor attributes abuse to one user rather than to the whole app.

### A call route

```typescript
import { HttpRequest } from "gemi/http";
import { AzureOpenAIProvider } from "gemi/ai";

const voice = AzureOpenAIProvider.model("gpt-realtime-mini").realtime;

export async function createVoiceCall(req: HttpRequest<{ sdp: string }>) {
  const { sdp } = await req.input();
  const { sdpAnswer, callId } = await voice.createCall({
    sdp,
    safetyIdentifier: await hashUserId(req),
    session: {
      instructions: "You are the voice of the page builder. Keep answers short.",
      voice: "marin",
      tools: [{ name: "ask_builder", description: "Delegate a change.", parameters: askBuilderSchema }],
      turnDetection: { type: "semantic_vad" },
      transcription: { model: "gpt-4o-mini-transcribe" },
      noiseReduction: "near_field",
    },
  });
  startSideband(callId); // see below
  return { sdpAnswer, callId };
}
```

### The session

`RealtimeSession` names the fields most apps set, in gemi's spelling, and maps them onto the vendor's GA session object:

| Field | Vendor field |
|---|---|
| `model` | `model` (default: the provider's model or deployment) |
| `instructions` | `instructions` |
| `voice`, `speed` | `audio.output.voice`, `audio.output.speed` |
| `outputModalities` | `output_modalities` |
| `tools` | `tools` (`type: "function"`). `parameters` is a gemi schema (`s.object(...)`) or a JSON Schema object. |
| `toolChoice` | `tool_choice` (`{ name }` becomes `{ type: "function", name }`) |
| `turnDetection` | `audio.input.turn_detection`: `{ type: "semantic_vad", eagerness? }` or `{ type: "server_vad", threshold?, prefixPaddingMs?, silenceDurationMs?, idleTimeoutMs? }`, both with `createResponse?` / `interruptResponse?`. `null` turns detection off, for push-to-talk. |
| `transcription` | `audio.input.transcription` (`{ model, language?, prompt? }`) |
| `noiseReduction` | `audio.input.noise_reduction` (`"near_field"`, `"far_field"` or `null`) |
| `maxOutputTokens`, `truncation` | `max_output_tokens`, `truncation` |
| `vendor` | Merged into the vendor's session object last, for any field not listed here. |

## The sideband

`realtime.sideband(callId)` opens at once and returns a `RealtimeSideband`. Events you send before it is open are queued.

```typescript
const sideband = voice.sideband(callId);

for await (const event of sideband) {
  if (event.type === "response.function_call_arguments.done") {
    const args = JSON.parse(event.arguments); // untrusted: validate it
    sideband.functionOutput(event.call_id, await runTool(event.name, args));
    sideband.createResponse();
  }
  if (event.type === "response.done" && event.usage) meter(event.usage);
}
```

Events are the vendor's, as documented for the GA Realtime API, narrowed on `type`, with these changes:

- `response.done` gains `usage`, gemi's `Usage` with the audio breakdown (see below).
- `conversation.item.input_audio_transcription.completed` gains `transcriptionUsage` (a `Usage`, for token-billed transcription) or `transcriptionSeconds` (for duration-billed transcription). The vendor's raw object stays in `usage`.
- The beta names of transcript and text deltas are renamed to the GA ones (`response.audio_transcript.delta` becomes `response.output_audio_transcript.delta`).
- `sideband.reconnected` (`attempt`) and `sideband.closed` (`code`, `reason`, `byClient`) are gemi's own. `sideband.closed` is always the last event.
- An event gemi has no type for arrives as itself, with its own `type`.

Typed events include `session.created` / `session.updated`, `error`, `input_audio_buffer.speech_started` / `speech_stopped` / `committed`, `conversation.item.input_audio_transcription.delta` / `completed`, `response.created`, `response.output_audio_transcript.delta` / `done`, `response.output_text.delta` / `done`, `response.function_call_arguments.done`, `response.done` and `output_audio_buffer.started` / `stopped`.

Each `for await` gets the events from the moment it starts; the first one also gets the events that arrived before it. `on(listener)` adds a callback for every event and returns an unsubscribe.

Sending:

| Method | Client event |
|---|---|
| `send(event)` | Any client event, as the vendor documents it. |
| `addNote(text)` | `conversation.item.create` with a `system` message: context for the model's next answer, without making it speak. |
| `addItem(item)` | `conversation.item.create` |
| `functionOutput(callId, output)` | `conversation.item.create` with a `function_call_output`. `output` is JSON-encoded unless it is a string. |
| `createResponse({ instructions?, toolChoice?, outputModalities?, conversation?, metadata?, vendor? })` | `response.create` |
| `cancelResponse(responseId?)` | `response.cancel` |
| `updateSession(session)` | `session.update` (without `model`: a live call keeps its model) |

Ending:

- `close()` closes this server's control socket. The call goes on, and another process can open its own sideband by `callId`.
- `hangup()` ends the call for everyone, then closes the socket. If the vendor refuses the hangup, the socket **stays open** and the error is thrown, because the call may still be running and this socket is what meters it. If the vendor had already closed the sideband normally, a refused hangup is ignored.
- `ready` resolves when the socket first opens. `closed` resolves with the final `sideband.closed` event.

**Reconnecting.** An abnormal close (anything but 1000, or a socket that never opened) re-opens the sideband by `callId`, up to `reconnect.attempts` times (default 3) with a doubling delay from `reconnect.delayMs` (default 500). A normal close (1000) means the call is over. When the attempts run out, the iterator ends with `sideband.closed`: a call nobody is metering should then be hung up with `realtime.hangup(callId)`.

The socket is Bun's `WebSocket`, which accepts headers. Tests pass `webSocket: (url, { headers }) => fakeSocket` in the options.

## Usage

`Usage` has three audio fields. Like `cachedInputTokens` and `imageInputTokens`, they are a breakdown of the totals, not separate buckets:

| Field | Vendor field (`response.done`'s `usage`) |
|---|---|
| `audioInputTokens` | `input_token_details.audio_tokens` |
| `cachedAudioInputTokens` | `input_token_details.cached_tokens_details.audio_tokens` |
| `audioOutputTokens` | `output_token_details.audio_tokens` |

`cachedInputTokens` is `input_token_details.cached_tokens`. To price a response, subtract the audio shares from the totals for the text part, and the cached audio share from `audioInputTokens` for the uncached audio. `toRealtimeUsage(raw)` maps a raw vendor `usage` object, for usage you read some other way.

**Transcription is billed separately.** With `transcription` on, each user utterance's transcription carries its own usage, at the transcription model's rates, and it never appears in `response.done`. The sideband maps it onto `transcriptionUsage` or `transcriptionSeconds` (see above). Add it to your meter as well, or a call with captions under-reports its cost.

## Voice in front of an agent

Most apps don't want a second assistant with its own tools. They want to talk to the agent they already have. `this.voice(Controller)` and `useVoiceSession` do that: a realtime voice model talks to the user, and every piece of real work is delegated to your `AgentController` as a turn on the chat's thread.

> **Experimental.** `this.voice()`, `VoiceBridge`, `VoiceConfig` and `gemi/ai/voice` may change in a minor release until a live call has run on Azure and on OpenAI.

```
browser ──WebRTC──▶ voice model ── ask_agent({ request }) ──▶ sideband (your server)
                                                                  │
                                       Controller.startTurn({ threadId, text, user, body })
                                                                  │
                                    the agent's turn, stored on the thread like a typed message
```

The voice model gets four tools:

| Tool | What the bridge does |
|---|---|
| `ask_agent({ request })` | Runs `startTurn({ threadId, text: request, user, body })`. The name is configurable (`delegate.name`). |
| `stop_work()` | Stops the running turn (what the chat's stop button does) and drops queued requests. |
| `work_status()` | Answers what is running (with its latest progress), what is queued, and any open question. |
| `answer_question({ answer, approve? })` | Answers a turn that ended `awaiting-input`, with `startTurn({ turn: { toolResults } })`. |

Delegated turns go through the controller exactly like a typed message: `authorizeRequest`, `resource`, `runOwner`, `maxConcurrentRuns`, `instructions()`, `context()`, hooks, tools and store. The chat panel shows them as they run.

### The controller

Set `voice` on the controller and mount the route:

```typescript
import { AgentController, AzureOpenAIProvider, VoiceHangup } from "gemi/ai";
import type { VoiceConfig } from "gemi/ai";

type PageBody = { pageId: string; selectedNode?: string };

export class PageBuilderController extends AgentController<typeof siteAgent, PageBody> {
  agent = siteAgent;

  voice: VoiceConfig<PageBody> = {
    realtime: AzureOpenAIProvider.model("gpt-realtime-mini").realtime,
    delegate: { name: "ask_builder" },
    start: async ({ req, body, threadId, user }) => {
      await chargeFirstBlock(user); // throw to refuse (402, 429…) before the call exists
      return {
        session: {
          instructions: voiceFrontPrompt(body),
          voice: "marin",
          turnDetection: { type: "semantic_vad" },
          transcription: { model: "gpt-4o-mini-transcribe" },
          noiseReduction: "near_field",
        },
        safetyIdentifier: hashUserId(user),
        limits: { maxDurationMs: 15 * 60_000, idleTimeoutMs: 2 * 60_000 },
        contextNote: (next) => (next.selectedNode ? `The user selected ${next.selectedNode}.` : null),
        onTick: async ({ elapsedMs }) => {
          if (!(await chargeNextBlockIfDue(user, elapsedMs))) {
            throw new VoiceHangup("You're out of credits. Buy a pack to keep talking.");
          }
        },
        onUsage: (usage, { total }) => recordUsage(total),
        onEnd: (summary) => settleVoiceSession(user, summary),
      };
    },
  };
}
```

```typescript
import { ApiRouter } from "gemi/http";

export class Api extends ApiRouter {
  routes = {
    "/page-builder": this.agent(PageBuilderController),
    "/page-builder/voice": this.voice(PageBuilderController),
  };
}
```

`this.voice(Controller)` mounts three routes. The enclosing router's `middlewares` guard them, and `.middleware({ start, update, end })` adds more per route:

| Route | Method | What it does |
|---|---|---|
| `POST /page-builder/voice` | `voiceStart` | Takes the browser's `sdp`, `threadId`, `pushToTalk` and the app's `body`. Runs `authorizeRequest` and then `voice.start`, creates the call with the server's key (the bridge's tools are added to `session.tools`), records the session in `voiceStore`, and starts a `VoiceBridge` on its sideband. Answers `{ sessionId, sdp, threadId, delegate, endsAt }`. |
| `PATCH /page-builder/voice/:sessionId` | `voiceUpdate` | Takes a new `body`, such as the current selection or the open page. The next delegated turn gets it, and `contextNote` tells the voice. |
| `DELETE /page-builder/voice/:sessionId` | `voiceEnd` | Hangs up. On the instance holding the bridge, `onEnd` runs before the answer. |

All three call `authorizeRequest` with `route: "stream"` and the session's `threadId` and `body`. Every delegated turn is a `stream` turn on that thread, so the same check applies. A `PATCH` or `DELETE` from a caller whose `runOwner` differs from the one that started the session gets a 403. An unknown session gets a 404, and a `PATCH` to an ended session gets a 409 (`voice_ended`).

The thread is the client's `threadId`, or the `threadId` that `start` returns (which is checked with `authorizeRequest` as well).

Once `start` has run, every failure calls `onEnd` with reason `start_failed`, so a charge made in `start` can be refunded:

- no thread from either source: 400.
- the thread `start` returned is refused: `authorizeRequest`'s error.
- `createCall` fails: 502, or 429 when the vendor rate-limited, with code `voice_unavailable`.
- anything fails after the vendor call exists (`runOwner`, `voiceStore.create`): 500. The vendor call is also hung up, so it isn't left running with nobody metering it.

**`start` is where abuse limits go, and it must enforce them.** gemi has no per-user concurrency cap or rate limit for voice. Check in `start` that the user has no other live session (`voiceStore` holds them), cap calls per hour, and charge or reserve credit. Throw to refuse (a 402 or 429 error) before the call exists.

The app's `body` keys must not be named `sdp`, `threadId` or `pushToTalk`. The route reads those itself, and the hook's values win.

### What the bridge does

- **One turn at a time.** A request that arrives while a turn is running is queued (up to `limits.maxQueued`, default 3) and answered at once with `status: "queued"`, so the voice can say "after this one". When the queue is full, the answer is `status: "busy"`. A run already going on the thread, such as a typed message, is waited for, and looked for again right before `startTurn`. Two limits remain. `liveRuns` is per process, so a run on another instance isn't seen. And a typed message that starts in the instant between that last look and `startTurn` is superseded, as one typed message supersedes another. `stop_work` before a request has started means it never starts.
- **The user is captured once.** Delegated turns run as the user `start` saw, for the whole call. A sign-out or revoked access mid-call is seen only when `authorizeRequest` refuses a turn.
- **Outcomes.** When a turn ends, the delegate call's output is `{ status: "done", text }`, `{ status: "needs_input", questions }`, `{ status: "failed", message }`, `{ status: "stopped" }` or `{ status: "refused", message }` (an `AgentTurnError` from `startTurn`). Then the voice is asked to respond, so it speaks the outcome. For a request that was answered `queued`, the outcome arrives as a note instead. If a response is still in flight, the bridge waits for it to finish before asking for another.
- **Progress.** While a turn runs, each tool call (and a string, or a `message` / `label` / `title` that a tool yields) becomes a quiet `system` note in the voice conversation, at most one per `limits.progressIntervalMs` (default 4 s). Pass `progress(event)` to summarise the run's events yourself.
- **Barge-in** stays native: server VAD cancels the spoken response but never the work. Only `stop_work` stops a turn.
- **Questions.** A turn that ends `awaiting-input` hands its pending calls to the voice. `answer_question` answers a `question` call with the spoken answer. It approves an `approval` call only when `approve: true`, and otherwise denies it with the answer as the reason. It denies a `client` call, since it can't run in a voice call.
- **The end.** Ending the call doesn't stop a running turn. The turn belongs to the thread, and the chat shows how it ends.

### Limits, metering and the end

| Option | Default | |
|---|---|---|
| `limits.maxDurationMs` | 15 minutes | Says `lines.maxDuration`, then hangs up (`max_duration`). |
| `limits.idleTimeoutMs` | 2 minutes | No speech, no response and no running work: says `lines.idle`, then hangs up (`idle`). |
| `limits.tickMs` | 1 minute | How often `onTick` is called. |
| `limits.closingLineMs` | 10 s | The longest a closing line may play before the hang-up. |
| `limits.hangupGraceMs` | 30 s | When the vendor refuses the hang-up, how long the sideband stays open (still metering) waiting for the vendor to end the call. The refusal is recorded in `errors` as `hangup_failed`. |

- **Closing lines.** A response still playing is cancelled first, and its `response.done` is awaited before the line is requested. The line's own `response.done` and then `output_audio_buffer.stopped` end the wait. `output_audio_buffer.*` are documented as WebRTC events. If the sideband doesn't receive them, every closing line waits the full `closingLineMs`.
- `onUsage(usage, { total, elapsedMs, sessionId, transcription })` runs after each `response.done` that carries usage, including the audio token fields.
- `onTranscriptionUsage({ usage?, seconds? }, info)` runs after each transcribed user utterance. Transcription is billed apart from responses, at the transcription model's rates: `usage` for a token-billed model, `seconds` for a duration-billed one. `info.transcription` holds the running totals.
- `onTick(info)` runs every `tickMs`, for time-based billing.
- Hooks run one after another, but outside the sideband's event loop, so a slow billing write doesn't hold up tool calls.
- Throw `new VoiceHangup(line)` from any of them to have the voice say `line` and hang up (reason `usage`). Any other error ends the call with reason `error`.
- `onEnd(summary)` runs once. `summary` has `reason`, `startedAt`, `endedAt`, `durationMs`, `seconds` (rounded up), `usage` (responses), `transcription` (`{ usage, seconds }`), `transcript` (the vendor's transcripts of what was said, `{ role, text, at }`), `requests` (each delegated request, its status and `runId`) and `errors`. Your app decides what to keep: nothing is stored by gemi.
- End reasons are `hangup`, `call_ended` (the vendor ended the call, for example because the browser left), `sideband_lost` (the call is hung up so it isn't left unmetered), `max_duration`, `idle`, `usage`, `session_tampered`, `start_failed` and `error`.
- **Tampering: a speed bump, not a boundary.** The browser can send `session.update` on its data channel. If a `session.updated` arrives whose instructions or tool *names* differ from the ones the session was created with, the bridge hangs up (`session_tampered`). Turning voice activity detection on or off (push-to-talk) is allowed.
  - The check doesn't cover tool descriptions or parameters, `tool_choice`, `max_output_tokens`, the voice or the transcription model.
  - A client can also send `response.create` with per-response instructions or tools, which never produces a `session.updated`.
  - On OpenAI the data channel hands the browser the full instructions anyway.

  What actually protects you is that every response's usage is metered on the sideband, plus the limits and billing in `start`, `onUsage`, `onTranscriptionUsage` and `onTick`. Tool calls also run only on the server, through the controller's checks.

### The app's MCP tools

The voice can call your MCP server's tools directly, alongside delegating to the agent. That's useful for quick reads and small edits that don't need a full agent turn. Return `mcp` from `start`:

```typescript
import { app } from "gemi/foundation";
import { McpRegistry } from "gemi/services";
import { ToolError } from "gemi/ai";

start: async ({ body, user }) => ({
  session: { instructions: voiceFrontPrompt(body) },
  mcp: {
    registry: app(McpRegistry),
    filter: { tags: ["pages"] },
    scopes: ["site:read", "site:write"], // default: every scope the router declares
    authorize: ({ input }) => {
      if ((input as { siteId?: string }).siteId !== body.siteId) {
        throw new ToolError("You can only work on the site that's open.");
      }
    },
  },
  onToolCall: async (call) => {
    if (call.status === "done") await chargeToolCall(user, call.name);
  },
}),
```

`this.voice()` lists the tools inside the starting request, adds them to the session, and the bridge runs each call on the server.

**How a call runs.** The voice model calls a plain function tool. The bridge receives the call on the sideband and runs it through `McpRegistry.execute` in this process. The caller is a remote principal built from the user `start` saw: `{ user, via: "voice", id: "voice:<sessionId>", scopes }`.

- The registry's remote rules apply. Only tools exposed to remote callers (`remote` on a native tool) and reached by `scopes` are listed or callable, and features are checked per call.
- The route runs as that user. Nothing of the browser's own request crosses over.
- Tools with `requiresApproval` are left out, because a voice call has no approval screen.
- MCP tools need a signed-in user. A session without one fails to start (`start_failed`).

**Limits and metering.** Calls go through `authorize` first. Then the bridge applies its limits:

| Option | Default | |
|---|---|---|
| `limits.maxToolCallsPerMinute` | 20 | More calls are answered `busy`. |
| `limits.toolTimeoutMs` | 60 s | The call's signal is aborted and the model is told it took too long. |
| `limits.toolOutputChars` | 8000 | The output's JSON is cut, because the voice model is billed for it on every later response. |

- `onToolCall(record, info)` runs after each call, in the same hook chain as `onUsage`. Throw `VoiceHangup` from it, or from `authorize`, to end the call.
- `summary.toolCalls` lists every call.
- A `ToolError`'s message reaches the model. Any other failure reads "The tool failed." and is logged.
- The routes charge their normal prices, as they would for any caller.
- Long work still belongs to the agent (`ask_agent`), so its progress shows in the chat.

**Why not the Realtime API's native `mcp` tool.** The native tool has the vendor call your `/mcp` endpoint with an `authorization` value carried in the session. The browser holds the call's data channel, which delivers `session.created` and `session.updated` with the session's tools. Neither vendor documents that the `mcp` tool's `authorization` or `headers` are left out of those events, so a token there must be assumed visible to the browser. The native tool also runs calls at the vendor, where the server can't refuse, rate-limit or meter them first, and the endpoint has to be reachable from the internet. Bridging through the sideband avoids all of that: no token is minted, so none can reach the browser.

`tools` (a list of `{ tool, run(input, { sessionId, signal }), timeoutMs? }`) does the same for the app's own in-process tools. `mcpVoiceTools(options, { user, sessionId })` builds the MCP list for a bridge you start yourself.

### More than one instance

A session's record (`callId`, `threadId`, owner, `body`, end) lives in `voiceStore`, a `VoiceSessionStore` with `create`, `get` and `update`. The default `MemoryVoiceSessionStore` is per process. With more than one instance, assign a shared store:

- A `PATCH` on another instance writes the store, and the bridge reads the latest `body` before every delegated turn. `contextNote` fires only on the instance that holds the bridge.
- A `DELETE` on another instance hangs the call up at the vendor. The holder's sideband sees the call end and runs `onEnd` (`call_ended`).
- A sideband that drops is re-opened by `callId` (see above). The bridge itself lives in the process that started it: on shutdown, call `VoiceBridge.endAll("Voice paused. Tap the microphone to resume.")`.

### Without the route

`VoiceBridge.start({ controller, threadId, user, body, call: { realtime, callId }, ... })` runs the bridge on a call you created yourself (`controller` is the controller class, or anything with `startTurn`). `voiceTools(delegate)` returns the four tools for the session. `bridge.setBody(body)`, `bridge.end(reason?, line?)` and `bridge.ended` (the summary) are its handles.

## The browser: `useVoiceSession`

`useVoiceSession` comes from `gemi/ai/voice`, an entry of its own. An app that doesn't use voice never bundles it, and when it is used from a view or a dynamically imported component, it isn't in the entry chunk. It uses no vendor SDK, only `getUserMedia` and a raw `RTCPeerConnection`.

```tsx
import { useVoiceSession } from "gemi/ai/voice";

export function VoiceButton({ threadId, pageId }: { threadId: string; pageId: string }) {
  const voice = useVoiceSession("/page-builder/voice", { threadId, body: { pageId } });

  if (voice.status === "idle" || voice.status === "ended") {
    return <button onClick={() => voice.start()}>Talk</button>;
  }
  return (
    <div>
      <span aria-live="polite">{voice.status}</span>
      {voice.captions.slice(-2).map((line) => (
        <p key={line.id}>{line.text}</p>
      ))}
      <button aria-pressed={voice.muted} onClick={() => voice.mute()}>Mute</button>
      <button onClick={() => voice.end()}>End</button>
    </div>
  );
}
```

| | |
|---|---|
| `status` | `idle`, `connecting`, `listening`, `thinking`, `speaking`, `working` (a delegated request is running and the voice is quiet) or `ended` |
| `captions` | The last 20 lines, the user's and the voice's: `{ id, role, text, final }` |
| `error` | Why the call couldn't start or ended early. `code` is `microphone_denied`, `unsupported`, or the route's error code (`out_of_credits`, `voice_unavailable`…), and `status` is the route's HTTP status. |
| `start()` | Asks for the microphone and starts the call. Call it from a click: browsers allow the microphone and audio playback only after a user gesture. |
| `end()` | Hangs up through the route. Unmounting does too. |
| `mute(on?)`, `muted` | Turns the microphone track off. |
| `setPushToTalk(on)`, `press()`, `release()` | Push-to-talk turns voice activity detection off. `press` opens the microphone, and `release` commits the turn and asks for an answer. The `pushToTalk` option starts the call that way. |
| `setBody(body)` | `PATCH`es the session's body, such as the selection, for the next delegated request. |
| `sessionId`, `endsAt` | The session's id, and when the server will end the call at the latest. |

The options are `threadId`, `body` (typed from the controller's `Body`), `pushToTalk`, `params` (values for `:params` in the route path), `headers`, `onError` and `onEnd`.

`start()` while a start is already in flight does nothing, and `end()` (or unmounting) sends its `DELETE` with `keepalive`, so a hang-up sent as the tab closes still reaches the route.

> **Status: experimental.** The route, the bridge and the hook are tested against a fake vendor that follows the documented protocol, a real controller and agent, and faked browser media APIs. These haven't been checked on a live call:
>
> - whether the browser's data channel receives the `function_call_output` items the sideband adds (they end `working`);
> - whether the sideband receives `output_audio_buffer.*`;
> - how the model behaves with a function call left open for minutes;
> - Azure's support for the `call_id` sideband and the hang-up route.

## Live transcription

Speech to text while the user talks, with no spoken answer: a **transcription session** (`session.type: "transcription"`) on OpenAI's Realtime API. The browser streams the microphone over WebRTC, the live text grows as the user speaks, and when they stop the browser commits the turn and the final transcript arrives. Use it for voice commands and dictation, where the app decides what to do with the text.

```
browser ──WebRTC audio──▶ OpenAI (gpt-live-transcribe)
   │  ▲ data channel: transcript deltas, then the final per committed turn
   │  └──────────── input_audio_buffer.commit when the user stops (browser VAD)
   ▼
your route ── clientSecret({ session: { type: "transcription" } }) ── ephemeral secret
```

> **Experimental.** This follows OpenAI's realtime transcription guide and the `client_secrets` reference (checked October 2026). It is tested against fakes only: no live session has run yet. On Azure the request is the same and goes through the same `RealtimeClient`, but Azure's support for transcription sessions is unconfirmed.

### The server: a transcription secret

`clientSecret` and `createCall` take a `TranscriptionSession` as well as a `RealtimeSession`:

```typescript
import { OpenAIProvider } from "gemi/ai";
import { HttpRequest } from "gemi/http";

const realtime = OpenAIProvider.model("gpt-live-transcribe").realtime;

export async function voiceToken(req: HttpRequest) {
  await enforceVoiceLimits(req); // your caps: minutes per day, one session at a time
  const { value, expiresAt, callsUrl } = await realtime.clientSecret({
    ttlSeconds: 60,
    safetyIdentifier: await hashUserId(req),
    session: {
      type: "transcription",
      languages: ["en", "tr"],
      prompt: "Voice commands for a website builder.",
      keywords: ["hero", "navbar", "fager"],
      delay: "low",
    },
  });
  return { value, expiresAt, callsUrl };
}
```

| `TranscriptionSession` field | Vendor field | |
|---|---|---|
| `type: "transcription"` | `type` | Required: it marks the session as a transcription session. |
| `model` | `audio.input.transcription.model` | Default `gpt-live-transcribe`. On Azure, the transcription deployment. A transcription session has no top-level `model`, so the provider's model isn't used. |
| `languages` | `…transcription.languages` | Expected languages (`en`, `tr`, …). `gpt-live-transcribe` reads this one. |
| `language` | `…transcription.language` | The single hint that older models (`gpt-4o-transcribe`, `whisper-1`) read. Passing both `language` and `languages` throws. |
| `prompt` | `…transcription.prompt` | What the audio is about. |
| `keywords` | `…transcription.keywords` | Literal terms likely to be said. Each must fit on one line without `<` or `>`, or the call throws before any request. |
| `delay` | `…transcription.delay` | `minimal`, `low`, `medium`, `high` or `xhigh`. A lower delay gives earlier partials; a higher one gives better accuracy. Benchmark with real audio. |
| `noiseReduction` | `audio.input.noise_reduction` | `"near_field"`, `"far_field"` or `null`. |
| `turnDetection` | `audio.input.turn_detection` | `null` by default. `gpt-live-transcribe` supports neither `server_vad` nor `semantic_vad`, so the client commits each turn. |
| `logprobs` | `include: ["item.input_audio_transcription.logprobs"]` | For models that return them. |
| `vendor` | merged last | Any other field. |

`ClientSecret.callsUrl` is where the browser posts its SDP offer with the secret: `https://api.openai.com/v1/realtime/calls`, or `https://<resource>/openai/v1/realtime/calls` on Azure. `safetyIdentifier` is sent as `OpenAI-Safety-Identifier` when the secret is minted, and the vendor binds it to the secret. A secret can start several sessions until it expires, so keep `ttlSeconds` short and enforce your limits in the route.

### The browser: `useLiveTranscription`

From `gemi/ai/voice`, so only the views that use it load it. It uses no vendor SDK.

```tsx
import { useLiveTranscription } from "gemi/ai/voice";

export function VoiceMode() {
  const live = useLiveTranscription("/api/voice/token", {
    silenceMs: 350,
    onFinal: (turn) => runCommand(turn.text),
  });

  return (
    <div>
      <button onClick={() => (live.status === "idle" ? live.start() : live.stop({ flush: true }))}>
        {live.status === "idle" ? "Voice" : "Stop"}
      </button>
      <meter value={live.level} />
      <p aria-live="polite">{live.partial}</p>
      {live.error && <p role="alert">{live.error.message}</p>}
    </div>
  );
}
```

`useLiveTranscription(source, options)`. `source` is the URL of the app's token route, which is POSTed `options.body` as JSON and answers `{ value, callsUrl? }`. It can also be a function that returns the token.

| | |
|---|---|
| `status` | `idle`, `connecting` or `listening` (the data channel is open). |
| `partial` | The live text of the turn in progress, built from the transcript deltas. |
| `turns` | Finished turns, oldest first (the last 50): `{ id, text, seconds? }`. `id` is the vendor's `item_id`, and turns are ordered by item even when completions arrive out of order. `seconds` is the audio duration the vendor billed, when it reports one. |
| `speaking`, `level` | What the end-of-speech detector hears, and the microphone level from 0 to 1. |
| `error` | The last failure. `code` is `microphone_denied`, `microphone_unavailable`, `unsupported`, `connection_failed`, the route's `error.code` (with `status`), or the vendor's. A vendor `error` event is shown without closing the session. An empty commit is ignored. |
| `start()` | Asks for the microphone and fetches the token in parallel, then connects. Call it from a click. While a session is starting or live it does nothing. |
| `stop({ flush?, timeoutMs? })` | Releases the microphone, the peer connection and the audio graph. With `flush: true`, speech in progress is committed first and its final transcript is awaited (up to `timeoutMs`, default 1500). Unmounting stops too. |
| `commit()` | Ends the turn now, for push-to-talk or a send button. |
| `mute(on?)`, `muted` | Turns the microphone track off. |
| `reset()` | Clears `turns` and `partial`. |

The callbacks are `onPartial(text)`, `onFinal(turn)`, `onSpeechStart()`, `onSpeechEnd()` and `onError(error)`.

**End of speech.** OpenAI's live transcription model has no server-side turn detection, so the hook detects the end of speech in the browser and sends `input_audio_buffer.commit`. Only a turn that had speech in it is committed. The options are:

- `vad: "energy"` (default) uses a built-in energy detector over a Web Audio analyser. It learns the room's noise floor while nobody speaks, opens a turn after `energy.minSpeechMs` (default 120) of sound above the floor, and ends it after `silenceMs` (default 350) of quiet, with hysteresis so a soft syllable doesn't end the turn. It is a few hundred bytes and needs no model files. That suits a close microphone with the browser's noise suppression on.
- `vad: (stream, { speechStart, speechEnd }) => ({ stop })` plugs in your own detector on the same stream, such as Silero through `@ricky0123/vad-web`. Use one in noisy rooms. It costs an ONNX runtime and model files served from your origin, which is why gemi doesn't bundle it:

  ```typescript
  import { MicVAD } from "@ricky0123/vad-web";

  const silero = async (stream: MediaStream, events: { speechStart(): void; speechEnd(): void }) => {
    const vad = await MicVAD.new({
      getStream: async () => stream,
      // The stream is shared with the WebRTC call: the hook stops its tracks,
      // vad-web's default pause would stop them early.
      pauseStream: async () => {},
      onSpeechStart: () => events.speechStart(),
      onSpeechEnd: () => events.speechEnd(),
      redemptionMs: 350,
    });
    return { stop: () => void vad.destroy() };
  };
  // useLiveTranscription("/api/voice/token", { vad: silero })
  ```
- `vad: false`: turns end only on `commit()`.

The meter (`level`) runs in every case.

### Metering

A transcription is billed by audio duration. Each `conversation.item.input_audio_transcription.completed` carries `usage: { type: "duration", seconds }`, which the hook shows as `turn.seconds`. **Don't bill from the browser.** With a secret, the session is the browser's: the server never learns its call id, so it can't open a sideband. Two ways to meter:

- **Cap and count on the server.** Mint secrets only within a daily minute cap, and count the minutes a session may run.
- **Hold the call on the server** with `connect: "sdp"`. The hook posts `{ sdp, ...body }` to the route, and the route answers `{ sdp }`. The route creates the call itself and meters it on the sideband, which maps each completion's duration onto `transcriptionSeconds`:

  ```typescript
  export async function voiceCall(req: HttpRequest<{ sdp: string }>) {
    const { sdp } = await req.input();
    const { sdpAnswer, callId } = await realtime.createCall({
      sdp,
      session: { type: "transcription", languages: ["en", "tr"] },
    });
    void (async () => {
      for await (const event of realtime.sideband(callId)) {
        if (event.type === "conversation.item.input_audio_transcription.completed") {
          await recordVoiceSeconds(req, event.transcriptionSeconds ?? 0);
        }
      }
    })();
    return { sdp: sdpAnswer };
  }
  // useLiveTranscription("/api/voice/call", { connect: "sdp" })
  ```

  Whether OpenAI serves a sideband for transcription sessions hasn't been checked on a live call.

Not checked on a live session yet: transcription sessions over WebRTC with `gpt-live-transcribe` end to end, how soon after a commit the final arrives, and what Azure supports.
