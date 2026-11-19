import Foundation

/// Supply the API base URL, including its /api prefix.
public struct GemiHTTPClient: Sendable {
  private let baseURL: URL
  private let session: URLSession

  public init(baseURL: URL, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.session = session
  }

  public func patch<Body: Encodable, Output: Decodable, Failure: Decodable & Error>(
    segments: [String], body: Body, response: Output.Type, rejection: Failure.Type, status: Int
  ) async throws -> Output {
    var url = baseURL
    for segment in segments {
      guard !segment.isEmpty, segment != ".", segment != ".." else { throw URLError(.badURL) }
      url = url.appending(component: segment, directoryHint: .notDirectory)
    }
    var request = URLRequest(url: url)
    request.httpMethod = "PATCH"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, reply) = try await session.data(for: request, delegate: PatchRedirectDelegate())
    guard let http = reply as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    if (200..<300).contains(http.statusCode) {
      return try JSONDecoder().decode(response, from: data)
    }
    // HttpResponse.error puts the status on the HTTP response and wraps the fields in "error".
    if http.statusCode == status,
       let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       var fields = envelope["error"] as? [String: Any] {
      if fields["status"] == nil { fields["status"] = status }
      let payload = try JSONSerialization.data(withJSONObject: fields)
      if let typed = try? JSONDecoder().decode(rejection, from: payload) { throw typed }
    }
    throw GemiHTTPStatusError(status: http.statusCode, body: data)
  }
}

/// A non-success response outside the route's declared error contract.
public struct GemiHTTPStatusError: Error {
  public let status: Int
  public let body: Data
}

/// Return the redirect to the caller, keeping the mutation at its original URL.
private final class PatchRedirectDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
