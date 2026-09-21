import Foundation

/// One SSE frame: the event and its position in the run.
public struct StreamFrame: Hashable, Sendable {
  /// The frame's `id:`. What `/attach` resumes from.
  public var seq: Int
  /// The `AgentStreamEvent`, as sent. The reducer reads it by its `type`.
  public var event: JSONValue

  public init(seq: Int, event: JSONValue) {
    self.seq = seq
    self.event = event
  }
}

/// Bytes to frames. A port of `ai/client/sse.ts`, held to the same recorded
/// cases (`ai/client/__fixtures__/sse.json`).
///
/// It works on bytes where the TypeScript works on decoded text, and that
/// changes nothing it can observe: every delimiter SSE has is ASCII, so a
/// frame's bytes are only turned into a string once the frame is complete —
/// which is also why a chunk that ends halfway through a UTF-8 character needs
/// no streaming decoder here.
public struct SSEFrameDecoder: Sendable {
  private var buffer: [UInt8] = []
  /// A CR at the very end of a chunk may be half a CRLF; held back one chunk.
  private var pendingCR = false
  /// `TextDecoder` drops a byte-order mark at the start of a byte stream.
  private var sawBytes = false
  private var lastSeq = -1

  public init() {}

  /// The cursor to resume from: the highest `id:` seen, `-1` before any.
  public var cursor: Int { lastSeq }

  public mutating func push(_ data: Data) -> [StreamFrame] {
    var bytes = [UInt8](data)
    if !sawBytes, !bytes.isEmpty {
      sawBytes = true
      if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
    }
    append(bytes)
    return drain()
  }

  public mutating func push(_ text: String) -> [StreamFrame] {
    append(Array(text.utf8))
    return drain()
  }

  /// End of stream. An event with no terminating blank line is discarded, as
  /// the SSE spec says: half a `text-delta` is worse than a missing one.
  public mutating func flush() -> [StreamFrame] {
    let frames = drain()
    buffer = []
    pendingCR = false
    return frames
  }

  /// Normalises every line ending to `\n`.
  private mutating func append(_ bytes: [UInt8]) {
    if bytes.isEmpty { return }
    var rest = bytes[...]
    if pendingCR {
      buffer.append(0x0A)
      pendingCR = false
      if rest.first == 0x0A { rest = rest.dropFirst() }
    }
    if rest.last == 0x0D {
      rest = rest.dropLast()
      pendingCR = true
    }
    var index = rest.startIndex
    while index < rest.endIndex {
      let byte = rest[index]
      if byte == 0x0D {
        buffer.append(0x0A)
        let next = rest.index(after: index)
        if next < rest.endIndex, rest[next] == 0x0A { index = next }
      } else {
        buffer.append(byte)
      }
      index = rest.index(after: index)
    }
  }

  private mutating func drain() -> [StreamFrame] {
    var frames: [StreamFrame] = []
    var start = 0
    var index = 0
    while index + 1 < buffer.count {
      if buffer[index] == 0x0A, buffer[index + 1] == 0x0A {
        if let frame = parse(buffer[start..<index]) { frames.append(frame) }
        start = index + 2
        index = start
      } else {
        index += 1
      }
    }
    if start > 0 { buffer.removeFirst(start) }
    return frames
  }

  private mutating func parse(_ block: ArraySlice<UInt8>) -> StreamFrame? {
    var id: String?
    var data: [String] = []

    for line in block.split(separator: 0x0A, omittingEmptySubsequences: false) {
      // A comment: the server's keepalive. Carries nothing.
      if line.isEmpty || line.first == UInt8(ascii: ":") { continue }
      let colon = line.firstIndex(of: UInt8(ascii: ":"))
      let field = String(decoding: line[..<(colon ?? line.endIndex)], as: UTF8.self)
      var value = colon.map { line[line.index(after: $0)...] } ?? []
      if value.first == UInt8(ascii: " ") { value = value.dropFirst() }
      if field == "data" {
        data.append(String(decoding: value, as: UTF8.self))
      } else if field == "id" {
        id = String(decoding: value, as: UTF8.self)
      }
      // `event:` and `retry:` are dropped: the frame's own `type` is the
      // discriminator.
    }

    if data.isEmpty { return nil }
    // One unparseable frame must not take the rest of the run with it.
    guard let event = JSONValue.parse(Data(data.joined(separator: "\n").utf8)) else { return nil }

    // A frame with no usable id continues the count: seq is the replay guard
    // downstream, so treating it as 0 would make it look already applied.
    let seq = id.flatMap(Self.number) ?? lastSeq + 1
    lastSeq = seq
    return StreamFrame(seq: seq, event: event)
  }

  /// `Number(id)` as JavaScript reads it, for the ids a server sends.
  private static func number(_ text: String) -> Int? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    guard let value = Double(trimmed), value.isFinite else { return nil }
    return Int(exactly: value.rounded(.towardZero))
  }
}

/// The decoder over a byte stream, e.g. `URLSession.bytes(for:)`.
///
/// Reads in the chunks the transport hands over rather than a byte at a time:
/// `AsyncBytes` yields single bytes, and a frame per byte would be a callback
/// per byte in the app.
public func decodeSSE<Bytes: AsyncSequence & Sendable>(_ bytes: Bytes) -> AsyncThrowingStream<
  StreamFrame, Error
> where Bytes.Element == UInt8 {
  AsyncThrowingStream { continuation in
    let task = Task {
      var decoder = SSEFrameDecoder()
      var chunk = Data()
      chunk.reserveCapacity(4096)
      do {
        for try await byte in bytes {
          chunk.append(byte)
          // A frame can only complete on a newline, so there is no point
          // handing the decoder anything that does not end in one.
          if byte == 0x0A || chunk.count >= 4096 {
            for frame in decoder.push(chunk) { continuation.yield(frame) }
            chunk.removeAll(keepingCapacity: true)
          }
        }
        if !chunk.isEmpty { for frame in decoder.push(chunk) { continuation.yield(frame) } }
        for frame in decoder.flush() { continuation.yield(frame) }
        continuation.finish()
      } catch {
        continuation.finish(throwing: error)
      }
    }
    // Cancelling the consumer cancels the read, which closes the connection.
    continuation.onTermination = { _ in task.cancel() }
  }
}
