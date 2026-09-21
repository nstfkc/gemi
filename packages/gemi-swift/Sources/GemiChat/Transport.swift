import Foundation

/// What `ChatSession` sends requests through.
///
/// `URLSessionTransport` is the one an app uses. The seam exists so a test can
/// stand in for the server, and so an app with its own networking stack — a
/// certificate pin, a proxy, a request signer — can put it underneath.
public protocol ChatTransport: Sendable {
  /// Sends `request`. The body is streamed: the agent routes answer with SSE,
  /// and a turn's frames have to reach the transcript as they arrive.
  ///
  /// Cancelling the calling task must close the connection. That is what
  /// `stop()` relies on to stop the UI at once, before the server has even
  /// been told.
  func send(_ request: URLRequest) async throws -> ChatResponse
}

public struct ChatResponse: Sendable {
  public var statusCode: Int
  public var body: AsyncThrowingStream<Data, Error>

  public init(statusCode: Int, body: AsyncThrowingStream<Data, Error>) {
    self.statusCode = statusCode
    self.body = body
  }

  public var isSuccess: Bool { (200..<300).contains(statusCode) }

  /// The whole body, for the responses that are not streams.
  public func data() async throws -> Data {
    var data = Data()
    for try await chunk in body { data.append(chunk) }
    return data
  }
}

/// `ChatTransport` over `URLSession`.
public struct URLSessionTransport: ChatTransport {
  public var session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func send(_ request: URLRequest) async throws -> ChatResponse {
    let (bytes, response) = try await session.bytes(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
    let body = AsyncThrowingStream<Data, Error> { continuation in
      let task = Task {
        var chunk = Data()
        chunk.reserveCapacity(4096)
        do {
          for try await byte in bytes {
            chunk.append(byte)
            // A frame only completes on a newline, so that is where a chunk is
            // worth handing on; the cap keeps a long line from buffering whole.
            if byte == 0x0A || chunk.count >= 4096 {
              continuation.yield(chunk)
              chunk.removeAll(keepingCapacity: true)
            }
          }
          if !chunk.isEmpty { continuation.yield(chunk) }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
    return ChatResponse(statusCode: statusCode, body: body)
  }
}
