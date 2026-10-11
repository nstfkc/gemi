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

`cachedInputTokens` is `input_token_details.cached_tokens`.

**Transcription is billed separately.** With `transcription` on, each user utterance's transcription carries its own usage, at the transcription model's rates, and it never appears in `response.done`. The sideband maps it onto `transcriptionUsage` or `transcriptionSeconds` (see above). Add it to your meter as well, or a call with captions under-reports its cost. To price a response, subtract the audio shares from the totals for the text part, and the cached audio share from `audioInputTokens` for the uncached audio. `toRealtimeUsage(raw)` maps a raw vendor `usage` object, for usage you read some other way.
