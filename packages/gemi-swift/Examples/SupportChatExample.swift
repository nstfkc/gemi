// A support chat screen built on GemiChat, showing the library end to end.
//
// It is written against `SupportAgent` and `Classifier`, the files
// `gemi ai:generate-client` wrote for the fixture agents in
// `packages/gemi/bin/ai-client/__fixtures__/support.ts` — in an app they are
// whatever you generated for your own agents:
//
//   gemi ai:generate-client app/agents/support.ts#supportAgent \
//     --out ios/App/Agents --platform swift
//
// Sections:
//   1. Creating a session: endpoint, auth headers, threads, restoring
//   2. Persisting a conversation: messages + cursor, together
//   3. Rendering a transcript: every ContentPart case
//   4. Typed tool calls: inputs, progress (a discriminated union), sub-agents
//   5. Typed tool results: Outcome and a union output
//   6. Pending calls: approvals and typed answers
//   7. Status, errors, stop, regenerate
//   8. Uploads: the two ids
//   9. Structured output
//  10. The untyped session, for an agent you did not generate for

import GemiChat
import SwiftUI
import UniformTypeIdentifiers

// MARK: - 1. Creating a session

/// Where the access token comes from. Anything async works: `headers` is asked
/// before every request, so a refreshed token is picked up on the next one.
enum Tokens {
  static func current() async throws -> String { "token" }
}

@MainActor
func makeSession(restoring saved: SavedConversation?) -> ChatSession<SupportAgent> {
  let session = ChatSession<SupportAgent>(
    // The agent's route as mounted: `"/support": this.agent(SupportController)`
    // in an ApiRouter is served at `/api/support`.
    endpoint: URL(string: "https://example.com/api/support")!,
    // With a thread the server keeps the history; without one the session
    // keeps it and posts it with every turn (stateless).
    threadId: saved?.threadId,
    initialMessages: saved?.messages ?? [],
    // Restored beside the messages, so attaching to a run that is still going
    // asks only for the frames this client has not seen.
    cursor: saved?.cursor,
    // On a thread, pick up a run that is still streaming — the app was
    // backgrounded mid-answer, say. Defaults to true.
    attach: true,
    headers: { ["Authorization": "Bearer \(try await Tokens.current())"] },
    // Merged into every request body, for whatever your controller reads off
    // the request besides the message.
    body: ["locale": "tr"]
  )

  // Callbacks. Each fires once per event, never again for a replayed frame.
  session.onFinish = { message in
    print("assistant finished \(message.id): \(message.finishReason?.rawValue ?? "?")")
  }
  session.onError = { error in
    print("agent error \(error.code): \(error.message) retryable=\(error.retryable)")
  }
  session.onAwaitingInput = { pending in
    print("the agent is waiting on \(pending.count) call(s)")
  }
  session.onAttachMiss = { threadId in
    // No run found for the thread. Behind a load balancer the run may be alive
    // on another instance: re-read the thread from your own route and hand the
    // messages over with `session.setMessages(_:)`.
    print("nothing to attach to on \(threadId)")
  }
  return session
}

// MARK: - 2. Persisting a conversation

/// What to save when the screen goes away. `AgentMessage` and `ChatCursor` are
/// `Codable`, and a message encodes as exactly the JSON the server sent — the
/// fields this client does not model included — so a restored stateless
/// conversation posts back what the server expects.
struct SavedConversation: Codable {
  var threadId: String?
  var messages: [AgentMessage]
  var cursor: ChatCursor
}

@MainActor
func save(_ session: ChatSession<SupportAgent>) throws -> Data {
  try JSONEncoder().encode(
    SavedConversation(threadId: session.threadId, messages: session.messages, cursor: session.cursor))
}

// MARK: - The screen

struct SupportChatView: View {
  @State private var chat: ChatSession<SupportAgent>
  @State private var draft = ""
  @State private var attached: [ChatFile] = []
  @State private var importing = false

  init(restoring saved: SavedConversation? = nil) {
    _chat = State(initialValue: makeSession(restoring: saved))
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(chat.messages) { message in
            MessageView(message: message)
          }
          if !chat.loadedTools.isEmpty {
            // Deferred tools the model pulled in this run: somewhere to say
            // what it is doing instead of an unexplained pause.
            Text("Looking at \(chat.loadedTools.joined(separator: ", "))…")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
        .padding()
      }
      PendingCallsView(chat: chat)
      StatusBar(chat: chat)
      composer
    }
    // `close()` drops the stream without stopping the run — the server
    // finishes it, and a session made later on the thread attaches to it.
    // `stop()` is the one that ends the run.
    .onDisappear { chat.close() }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .image]) { result in
      guard case .success(let url) = result else { return }
      Task { await upload(url) }
    }
  }

  private var composer: some View {
    HStack {
      Button("Attach", systemImage: "paperclip") { importing = true }
        .labelStyle(.iconOnly)
      TextField("Message", text: $draft)
        .textFieldStyle(.roundedBorder)
        .onSubmit(send)
      Button("Send", action: send)
        .disabled(draft.isEmpty && attached.isEmpty)
    }
    .padding()
  }

  private func send() {
    // A turn is text, files, answers to pending calls, or any mix.
    let turn = ClientTurn(text: draft.isEmpty ? nil : draft, files: attached)
    draft = ""
    attached = []
    Task { await chat.send(turn) }
  }

  // MARK: 8. Uploads

  private func upload(_ url: URL) async {
    guard let data = try? Data(contentsOf: url) else { return }
    let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
      ?? "application/octet-stream"
    do {
      let upload = try await chat.upload(data, name: url.lastPathComponent, mimeType: mimeType)
      // Two ids, either of which can be missing:
      //  - `fileId` is the provider's. `upload.file` is the ChatFile to put in
      //    a turn so the model sees it — nil when the server kept the file
      //    without sending it to the provider.
      //  - `attachmentId` is gemi's: the handle a tool fetches the bytes by.
      //    Tell the agent about it in your own words or payload.
      if let file = upload.file { attached.append(file) }
      if let attachmentId = upload.attachmentId {
        draft += " (attachment \(attachmentId))"
      }
      if upload.downgraded == "no_scope" {
        // The server wanted to keep the file but could not tell whose it is:
        // a route missing its auth middleware, not the app's policy.
        print("upload was not kept: the route has no attachment scope")
      }
    } catch let error as AgentError {
      // Also reported through `chat.error` and `onError`.
      print("upload failed: \(error.message)")
    } catch {
      print("upload failed: \(error)")
    }
  }
}

// MARK: - 3. Rendering a transcript

struct MessageView: View {
  let message: AgentMessage

  var body: some View {
    VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
      ForEach(Array(message.content.enumerated()), id: \.offset) { _, part in
        PartView(part: part)
      }
      if message.role == .assistant, message.finishReason == nil {
        ProgressView().controlSize(.small)  // still streaming
      }
      if message.finishReason == .aborted {
        Text("Stopped").font(.caption2).foregroundStyle(.secondary)
      }
      if let usage = message.usage {
        Text("\(usage.totalTokens) tokens").font(.caption2).foregroundStyle(.tertiary)
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
  }
}

/// `ContentPart` is the transcript's own vocabulary, the same union `useChat`
/// renders. Tool parts are read typed through the generated schema.
struct PartView: View {
  let part: ContentPart

  var body: some View {
    switch part {
    case .text(let text):
      Text(text)

    case .reasoning(let reasoning):
      // Rendered separately, or not at all — it is not the answer.
      if let text = reasoning.text {
        Text(text).font(.footnote).italic().foregroundStyle(.secondary)
      }

    case .file(let file):
      Label(file.name ?? file.fileId, systemImage: "doc")

    case .toolCall(let call):
      ToolCallView(call: SupportAgent.toolCall(call))

    case .toolResult(let result):
      ToolResultView(result: SupportAgent.toolResult(result))

    case .output(let output):
      // Only on an agent with an `output` schema — see section 9.
      Text(output.partial ? "Composing an answer…" : "Answer ready")

    case .unknown:
      // A part type from a newer server. Nothing to show, nothing broken.
      EmptyView()
    }
  }
}

// MARK: - 4. Typed tool calls

struct ToolCallView: View {
  let call: SupportAgent.ToolCall

  var body: some View {
    switch call {
    case .grep(let grep):
      // `input` is nil while the model is still streaming the arguments.
      if let input = grep.input {
        Label("Searching \(input.filePath) for /\(input.pattern)/", systemImage: "magnifyingglass")
      } else {
        Label("Deciding what to search…", systemImage: "magnifyingglass")
      }

    case .bash(let bash):
      VStack(alignment: .leading) {
        Text("$ \(bash.input?.command ?? "…")").monospaced()
        // `progress` is what the tool's generator yielded, typed by the
        // generator: here a union told apart by its `stage` field.
        ForEach(Array(bash.progress.enumerated()), id: \.offset) { _, entry in
          switch entry {
          case .started(let started):
            Text("started, pid \(Int(started.pid))").font(.caption)
          case .line(let line):
            Text(line.text)
              .monospaced()
              .foregroundStyle(line.stream == .stderr ? .red : .primary)
          }
        }
      }

    case .charge(let charge):
      if let input = charge.input {
        // `currency` is an enum with the wire values; `metadata` is optional
        // (absent), `reason` is nullable (present, may be null).
        VStack(alignment: .leading) {
          Text("Charge \(input.amountCents / 100, format: .number) \(input.currency.rawValue.uppercased())")
          if let reason = input.reason { Text(reason).font(.caption) }
          ForEach(input.metadata?.lineItems ?? [], id: \.sku) { item in
            Text("\(Int(item.qty))× \(item.sku)").font(.caption2)
          }
        }
      }

    case .refundOrder(let refund):
      // `refund_order` on the wire, `refundOrder` in Swift.
      Label("Refunding \(refund.input?.orderId ?? "…")", systemImage: "arrow.uturn.left")

    case .stats, .ping:
      Label("Checking…", systemImage: "chart.bar")

    case .ask:
      // Answered from the pending list — section 6.
      EmptyView()

    case .unknown(let part):
      // A tool added since this file was generated, or a skill.
      Label(part.name, systemImage: "wrench")
    }

    // Sub-agent runs a tool drove. Their messages are an ordinary transcript,
    // so they render with the same views — untyped, because a sub-agent's
    // tools are its own.
    ForEach(nested(call), id: \.runId) { run in
      DisclosureGroup(run.label ?? run.agent) {
        ForEach(run.messages) { MessageView(message: $0) }
      }
    }
  }

  private func nested(_ call: SupportAgent.ToolCall) -> [NestedRun] {
    switch call {
    case .grep(let c): c.nested
    case .bash(let c): c.nested
    case .charge(let c): c.nested
    case .stats(let c): c.nested
    case .ping(let c): c.nested
    case .ask(let c): c.nested
    case .refundOrder(let c): c.nested
    case .unknown(let part): part.nested
    }
  }
}

// MARK: - 5. Typed tool results

struct ToolResultView: View {
  let result: SupportAgent.ToolResult

  var body: some View {
    switch result {
    case .charge(let charge):
      switch charge.outcome {
      // The output is itself a union, told apart by `status`.
      case .ok(.paid(let paid)):
        Label("Paid — receipt \(paid.receiptId)", systemImage: "checkmark.circle")
      case .ok(.declined(let declined)):
        Label(
          "Declined (\(declined.declineCode))\(declined.retryable ? ", try again" : "")",
          systemImage: "xmark.circle")
      case .error(let error):
        Label("Failed: \(error.message)", systemImage: "exclamationmark.triangle")
      case .denied(let cause, let reason):
        // "refused" when the user said no, "stopped" when a stop landed first.
        Label("Not charged (\(cause))\(reason.map { ": \($0)" } ?? "")", systemImage: "hand.raised")
      }

    case .grep(let grep):
      if case .ok(let output) = grep.outcome {
        Text("\(output.matches.count) match(es)").font(.caption)
      }

    case .bash(let bash):
      if case .ok(let output) = bash.outcome, output.exitCode != 0 {
        Text("exited \(Int(output.exitCode))").font(.caption).foregroundStyle(.red)
      }

    case .stats(let stats):
      if case .ok(let output) = stats.outcome {
        // `Record<string, number>` is a dictionary.
        ForEach(output.counts.sorted(by: { $0.key < $1.key }), id: \.key) { label, count in
          Text("\(label): \(Int(count))").font(.caption)
        }
      }

    case .ping(let ping):
      // No schema and an `unknown` return: raw JSON, as sent.
      if case .ok(let value) = ping.outcome { Text(verbatim: "\(value)").font(.caption2) }

    case .refundOrder(let refund):
      if case .ok(let output) = refund.outcome {
        Text("Refund \(output.refundId)\(output.default ? " (default)" : "")").font(.caption)
      }

    case .ask:
      EmptyView()

    case .unknown:
      // Includes a known tool whose output no longer decodes: the raw part is
      // still in the transcript, nothing throws.
      EmptyView()
    }
  }
}

// MARK: - 6. Pending calls

struct PendingCallsView: View {
  let chat: ChatSession<SupportAgent>
  @State private var answer = ""

  var body: some View {
    // Non-empty exactly when `status == .awaitingInput`.
    if !chat.typedPending.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(chat.typedPending, id: \.self) { pending in
          switch pending {
          case .charge(let call):
            // An approval: the server runs the tool once someone says yes.
            HStack {
              Text("Charge \((call.input?.amountCents ?? 0) / 100, format: .number)?")
              Spacer()
              Button("Approve") { chat.approve(call, true) }
              Button("Decline", role: .destructive) {
                chat.approve(call, false, reason: "The customer declined")
              }
            }

          case .ask(let call):
            // A question: the answer's type is the tool's output schema, so a
            // wrong-shaped answer does not compile.
            VStack(alignment: .leading) {
              Text(call.input?.question ?? "")
              TextField("Your answer", text: $answer)
                .onSubmit { chat.answer(call, with: SupportAgent.AskOutput(answer: answer)) }
            }

          default:
            // Any other pending call, typed or not, answered by id.
            if let raw = chat.pending.first(where: { $0.kind == .approval }) {
              Button("Approve \(raw.name)") { chat.approve(raw.toolCallId, true) }
            }
          }
        }
        // Approving everything at once: answers given in one go are sent as
        // ONE turn. Sent one by one, the first turn would refuse the others.
        if chat.pending.count > 1 {
          Button("Approve all") {
            for call in chat.pending where call.kind == .approval {
              chat.approve(call.toolCallId, true)
            }
          }
        }
        // A question a sub-agent asked arrives here too; `path` says whose it
        // is, and answering it is no different.
        ForEach(chat.pending.filter { $0.path != nil }) { call in
          Text("\(call.name) is asked by a sub-agent").font(.caption2)
        }
      }
      .padding()
      .background(.yellow.opacity(0.15))
    }
  }
}

// MARK: - 7. Status, errors, stop, regenerate

struct StatusBar: View {
  let chat: ChatSession<SupportAgent>

  var body: some View {
    HStack {
      switch chat.status {
      case .idle: Text("Ready")
      case .submitted: Text("Sending…")
      case .streaming: Text("Answering…")
      case .awaitingInput: Text("Waiting for you")
      case .error: Text(chat.error?.message ?? "Something went wrong").foregroundStyle(.red)
      }
      Spacer()
      if chat.status == .submitted || chat.status == .streaming {
        // Marks the turn aborted at once, then tells the server, which ends
        // the generation and any tool mid-flight.
        Button("Stop") { Task { await chat.stop() } }
      }
      if chat.status == .error, chat.error?.code == "thread_not_found" {
        // The thread is gone: start a new one, or carry on stateless.
        Text("This conversation expired").font(.caption)
      } else if chat.status == .error, chat.error?.retryable == true {
        Button("Retry") { Task { await chat.regenerate() } }
      } else if chat.status == .idle, chat.messages.last?.role == .assistant {
        Button("Regenerate") { Task { await chat.regenerate() } }
      }
    }
    .font(.caption)
    .padding(.horizontal)
  }
}

// MARK: - 9. Structured output

/// An agent with an `output` schema answers with an object. Its `output` part
/// streams as partial snapshots; the typed value is there once it parses.
@MainActor
func classify(_ text: String) async -> Classifier.StructuredOutput? {
  let chat = ChatSession<Classifier>(endpoint: URL(string: "https://example.com/api/classify")!)
  await chat.send(text)
  guard let message = chat.messages.last(where: { $0.role == .assistant }),
    let result = chat.output(of: message)
  else { return nil }
  // `sentiment` is an enum: `.positive`, `.neutral`, `.negative`.
  print("\(result.sentiment) about \(result.topics.joined(separator: ", "))")
  return result
}

// MARK: - 10. The untyped session

/// For an agent nothing was generated for. Every view is the raw part, and
/// payloads are `JSONValue` — still the whole library, just not typed.
@MainActor
func untyped() async {
  let chat = UntypedChatSession(endpoint: URL(string: "https://example.com/api/other")!)
  await chat.send("hello")
  for message in chat.messages {
    for case .toolCall(let call) in message.content {
      // `JSONValue` subscripts like the JSON it is.
      print(call.name, call.input["query"]?.stringValue ?? "-")
    }
  }
  if let call = chat.pending.first, call.kind == .question {
    // Any `Encodable` answers an untyped question.
    chat.answer(call.toolCallId, with: ["answer": "yes"] as [String: String])
  }
}
