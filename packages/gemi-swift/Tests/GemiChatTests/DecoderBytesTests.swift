import Foundation
import Testing

@testable import GemiChat

// What the corpus cannot reach. The TypeScript decoder works on text that
// `TextDecoder` has already assembled, so how the bytes were split is not
// something its tests can vary; this port works on the bytes themselves.

@Test func aByteOrderMarkSplitAcrossChunksIsDropped() {
  var decoder = SSEFrameDecoder()
  #expect(decoder.push(Data([0xEF])).isEmpty)
  #expect(decoder.push(Data([0xBB])).isEmpty)
  let frames = decoder.push(Data([0xBF] + Array("data: {}\n\n".utf8)))
  #expect(frames == [StreamFrame(seq: 0, event: [:])])
}

@Test func bytesThatOnlyStartLikeAByteOrderMarkAreKept() {
  var decoder = SSEFrameDecoder()
  #expect(decoder.push(Data([0xEF, 0xBB])).isEmpty)
  // Not a BOM after all: the held bytes open the next line and are kept, so
  // the field name is garbage and the frame has no `data:`.
  #expect(decoder.push(Data("data: {}\n\n".utf8)).isEmpty)
  #expect(decoder.push(Data("data: {}\n\n".utf8)) == [StreamFrame(seq: 0, event: [:])])
}

/// A frame ended with bare CRs must arrive while the connection is still open,
/// not when 4 KiB have piled up behind it. It does wait for one more byte: a
/// CR that ends a chunk may be half a CRLF.
@Test func decodeSSEHandsOverAFrameEndedByCarriageReturns() async throws {
  let (bytes, input) = AsyncStream.makeStream(of: UInt8.self)
  let closed = Flag()
  for byte in "id: 3\rdata: {}\r\ri".utf8 { input.yield(byte) }
  let closer = Task {
    try await Task.sleep(for: .seconds(2))
    closed.set()
    input.finish()
  }
  defer { closer.cancel() }

  var frames = decodeSSE(bytes).makeAsyncIterator()
  let frame = try await frames.next()
  #expect(frame == StreamFrame(seq: 3, event: [:]))
  #expect(!closed.value, "the frame waited for the stream to end")
}

private final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var raised = false
  var value: Bool { lock.withLock { raised } }
  func set() { lock.withLock { raised = true } }
}
