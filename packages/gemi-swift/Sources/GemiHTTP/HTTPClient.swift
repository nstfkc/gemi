import Foundation

/// Supply the API base URL, including its /api prefix.
public struct GemiHTTPClient: Sendable {
  private let baseURL: URL
  private let session: URLSession

  private static let defaultSession: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    return URLSession(configuration: config)
  }()

  public init(baseURL: URL, session: URLSession? = nil) {
    self.baseURL = baseURL
    self.session = session ?? Self.defaultSession
  }

  public func send<Output: Decodable, Failure: Decodable & GemiHTTPRouteError>(
    method: String, segments: [String], body: (any Encodable)? = nil, response: Output.Type, rejection: Failure.Type
  ) async throws -> Output {
    var url = baseURL
    for segment in segments {
      guard !segment.isEmpty, segment != ".", segment != ".." else { throw URLError(.badURL) }
      url = url.appending(component: segment, directoryHint: .notDirectory)
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    let (data, reply) = try await session.data(for: request, delegate: NoRedirectDelegate())
    guard let http = reply as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    if (200..<300).contains(http.statusCode) {
      return try JSONDecoder().decode(response, from: data)
    }
    // HttpResponse.error puts the status on the HTTP response and wraps the fields in "error".
    if http.statusCode == Failure.declaredStatus,
       let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       var fields = envelope["error"] as? [String: Any] {
      if fields["status"] == nil { fields["status"] = http.statusCode }
      let payload = try JSONSerialization.data(withJSONObject: fields)
      if let typed = try? JSONDecoder().decode(rejection, from: payload) { throw typed }
    }
    throw GemiHTTPStatusError(status: http.statusCode, body: data)
  }
}

/// A refusal received from the server, including the errors declared by a route.
public protocol GemiHTTPError: Error {
  var status: Int { get }
}

/// Generated models keep their strongly typed status field. Through GemiHTTPError
/// callers can read the same status as an integer for any server refusal.
public protocol GemiHTTPRouteError: GemiHTTPError {
  static var declaredStatus: Int { get }
}

extension GemiHTTPRouteError {
  public var status: Int { Self.declaredStatus }
}

/// A non-success response outside the route's declared error contract.
public struct GemiHTTPStatusError: GemiHTTPError {
  public let status: Int
  public let body: Data
}

/// Return the redirect to the caller, keeping the mutation at its original URL.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
