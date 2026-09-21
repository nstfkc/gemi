# Mobile Clients

An agent mounted with `this.agent(...)` in an `ApiRouter` is what `useChat` talks to in the browser. The same route serves native apps: **GemiChat** for iOS (Swift) and **`dev.gemijs.chat`** for Android (Kotlin) are ports of `useChat`, and `gemi ai:generate-client` writes the agent's tool and output types for either one.

Nothing on the server changes. A mobile client sends the same requests as the web hook, to the same four routes: `POST /api/<path>` to stream a turn, and `/stop`, `/attach` and `/files` under it.

## What you get

Each client is a `ChatSession` with the web hook's behaviour:

- `send` (text, files, and answers to pending calls)
- `stop`
- `regenerate`
- `approve` and `answer`
- `upload`
- reattaching to a run still going on a thread
- the `status` / `pending` / `error` / `cursor` state that a chat screen renders

The frame handling isn't a rewrite that might drift from the web hook. Every call the TypeScript reducer's tests make is recorded in `packages/gemi/ai/client/__fixtures__`, and both native reducers are tested against that recording.

## Installing

**iOS.** Add the gemi repository as a Swift package and depend on the `GemiChat` product:

```swift
.package(url: "https://github.com/nstfkc/gemi", exact: "0.63.0") // the gemi your server runs
```

The package is versioned by gemi's own release tags, so pin the one your server runs and the client speaks the same protocol. SwiftPM clones the whole repository to get it. It needs iOS 17 (for `@Observable`).

**Android.** The Kotlin client isn't published to Maven yet. Until it is, include it as a composite build from a checkout of the gemi repository:

```kotlin
// settings.gradle.kts
includeBuild("../gemi/packages/gemi-kotlin")
```

```kotlin
// app/build.gradle.kts
dependencies {
  implementation("dev.gemijs:gemi-chat")
  implementation("dev.gemijs:gemi-chat-compose") // rememberChat, for Compose
}
```

It needs `minSdk` 26 and the kotlinx.serialization Gradle plugin, which the generated types use. The included build finds the Android SDK through `ANDROID_HOME`; without it, only `gemi-chat` is included.

## Generating the types

Point the command at the agent (the value `Agent.create` returned, as `<file>#<export>`) and say where to write:

```bash
gemi ai:generate-client app/agents/support.ts#supportAgent --out ios/App/Agents --platform swift
gemi ai:generate-client app/agents/support.ts#supportAgent --out android/app/src/main/kotlin/com/example/agents \
  --platform kotlin --package com.example.agents
```

Each command writes one file named after the export (`SupportAgent.swift` / `SupportAgent.kt`). It contains every tool's input, output and progress type, plus the agent's structured output. The typed views to read a transcript through are in the same file. Type names match across the two platforms.

The command reads your agent's **TypeScript types** and never imports or runs your app. That means CI can run it without a database or secrets. It also means a tool's progress is typed: progress has no schema, it's whatever the tool's generator yields, and only the types know it. Every type comes from the same `ToolShapesOf` that types `useChat`.

A shape with no faithful Swift or Kotlin spelling stays raw JSON (`JSONValue` / `JsonElement`), and the command prints a warning naming where it was:

| TypeScript | Generated |
| --- | --- |
| `string`, `number`, `boolean` | `String`, `Double`, `Bool` / `Boolean` |
| an object | a struct / `@Serializable data class` |
| a union of string literals | an enum with the wire values |
| a union of objects with one string-literal member in common | a discriminated enum / sealed interface |
| `T \| null` vs. `key?: T` | kept apart: a required nullable key is written as `null`, an optional one is left out |
| `Record<string, T>`, `T[]` | a dictionary / map, an array / list |
| `unknown` (a tool with no output schema and an untyped return) | raw JSON, silently |
| `Date`, a tuple, a union without a string discriminant, a recursive type | raw JSON, with a warning |

Regenerate whenever the agent's tools change. A tool the file doesn't know about isn't an error: it shows up as `.unknown` / `Unknown` in every typed view. The same goes for skills, which reach the client as tools, and for a payload that no longer decodes.

## iOS

```swift
import GemiChat
import SwiftUI

struct SupportView: View {
  @State private var chat = ChatSession<SupportAgent>(
    endpoint: URL(string: "https://example.com/api/support")!,
    headers: { ["Authorization": "Bearer \(try await Tokens.current())"] }
  )
  @State private var draft = ""

  var body: some View {
    List(chat.messages) { message in
      Text(message.text)
      ForEach(chat.toolCalls(in: message), id: \.self) { call in
        if case .bash(let bash) = call {
          ForEach(bash.progress, id: \.self) { Text(verbatim: "\($0)") }
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      if chat.status == .awaitingInput {
        ForEach(chat.typedPending, id: \.self) { pending in
          if case .charge(let call) = pending {
            Button("Approve \(call.input?.amountCents ?? 0)¢") { chat.approve(call, true) }
          }
        }
      }
      TextField("Message", text: $draft).onSubmit {
        let text = draft
        draft = ""
        Task { await chat.send(text) }
      }
    }
    .onDisappear { chat.close() }
  }
}
```

`ChatSession` is `@MainActor` and `@Observable`, so a SwiftUI view re-renders as frames arrive. `messages` is the transcript as the server sent it. `toolCalls(in:)`, `toolResults(in:)`, `typedPending` and `output(of:)` read it through the generated types.

A question tool's answer is typed by the tool's output schema, so an answer of the wrong shape doesn't compile:

```swift
if case .ask(let call) = chat.typedPending.first {
  chat.answer(call, with: .init(answer: "The March order"))
}
```

## Android

```kotlin
class SupportViewModel : ViewModel() {
  val chat = ChatSession(
    endpoint = "https://example.com/api/support",
    scope = viewModelScope,
    headers = { mapOf("Authorization" to "Bearer ${tokens.current()}") },
  )

  fun send(text: String) = viewModelScope.launch { chat.send(text) }
}

@Composable
fun SupportScreen(model: SupportViewModel = viewModel()) {
  val state by model.chat.state.collectAsState()
  LazyColumn {
    items(state.messages) { message -> Text(message.text) }
  }
  if (state.status == ChatStatus.AwaitingInput) {
    state.pending.map(SupportAgent::pending).forEach { pending ->
      if (pending is SupportAgent.Pending.Charge) {
        Button(onClick = { model.chat.approve(pending.value, true) }) { Text("Approve") }
      }
    }
  }
}
```

`state` is a `StateFlow<ChatUiState>` holding everything a chat screen renders. The typed views are functions of the generated object: `SupportAgent.toolCall(part)`, `SupportAgent.pending(call)`, `SupportAgent.output(part)`. `ChatSession` itself isn't generic.

The session is confined to the thread `scope` dispatches to, as a UI is; `viewModelScope` is the main thread. A `ViewModel` keeps the conversation through a configuration change. For a screen that doesn't need that, `rememberChat` from `gemi-chat-compose` ties a session to the composable instead:

```kotlin
val chat = rememberChat("https://example.com/api/support", threadId = threadId)
val state by chat.collectState()
```

## Behaviour worth knowing

These are the web hook's rules; the comments in `packages/gemi/ai/useChat.tsx` explain why each one exists.

- **Stateless by default.** Without a `threadId` the session keeps the history and posts it with every turn. It leaves out tool progress logs, which the server never reads. With a `threadId` (minted by an app route that calls `store.createThread`), the server keeps the history.
- **Persist `messages` and `cursor` together.** Pass both back as `initialMessages` and `cursor` when the screen is rebuilt. A session on a thread then attaches to a run still going and asks only for the frames it hasn't seen. Restoring one without the other is how an answer ends up printed twice.
- **Answers given together go out as one turn.** A turn that leaves a pending call unanswered refuses it. So `approve`/`answer` calls made in one go — a loop over `pending` — are coalesced into a single request.
- **`stop()` ends the run. `close()` doesn't.** `stop()` marks the turn aborted at once and tells the server, which ends the generation and any tool in flight. `close()` only drops the connection, like a React unmount; the run finishes on the server, and a later session on the thread attaches to it. Call `close()` when the screen goes away.
- **`onAttachMiss`** fires when the attach probe finds no run. Behind a load balancer that's ambiguous, because the run may be alive on another instance. Re-reading the thread and calling `setMessages` shows the answer anyway.
- **An upload has two ids, and either can be missing.** `upload` returns a `ChatUpload`. Its `fileId` is the provider's: put `upload.file` in a turn's `files` to show the model the file. Its `attachmentId` is gemi's: the handle a tool fetches the bytes by. A file the server kept but never sent to the provider has no `fileId`, so `file` is `nil`/`null`, not a turn carrying an empty id. An upload the server had no scope to keep has no `attachmentId`, and `downgraded` says so.
- **Authentication** is whatever your routes' middleware checks. Mobile apps usually send a bearer token, so pass it in `headers`, which is asked for before every request.

## Related

- [CLI → `gemi ai:generate-client`](./cli.md#gemi-aigenerate-client) — the command's flags.
- [Data Fetching](./data-fetching.md) — the RPC layer `useChat` shares with `useQuery`.
