import Combine
import Foundation

enum ServerScheme: String, Codable, CaseIterable, Identifiable {
    case http
    case https

    var id: String { rawValue }
    var title: String { rawValue.uppercased() }
}

struct ServerConfiguration: Codable, Equatable {
    var scheme: ServerScheme
    var host: String
    var port: Int

    var baseURL: URL? {
        guard validationError == nil else { return nil }
        var components = URLComponents()
        components.scheme = scheme.rawValue
        components.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        components.port = port
        return components.url
    }

    /// Fallback used only when the login response does not specify the raw WebSocket endpoint.
    var webSocketURL: URL? {
        guard validationError == nil else { return nil }
        var components = URLComponents()
        components.scheme = scheme == .https ? "wss" : "ws"
        components.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        components.port = port
        components.path = "/ws/collector"
        return components.url
    }

    var validationError: String? {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else { return "Enter a server address." }
        guard !trimmedHost.contains("://"), !trimmedHost.contains("/"), !trimmedHost.contains(" ") else {
            return "Enter only a host or IP address."
        }
        guard (1...65535).contains(port) else { return "Port must be between 1 and 65535." }
        guard baseURLComponentsAreValid else { return "Enter a valid server address." }
        return nil
    }

    private var baseURLComponentsAreValid: Bool {
        var components = URLComponents()
        components.scheme = scheme.rawValue
        components.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        components.port = port
        return components.url != nil
    }
}

protocol ServerConfigurationStore {
    func load() -> ServerConfiguration?
    func save(_ configuration: ServerConfiguration)
    func clear()
}

final class UserDefaultsServerConfigurationStore: ServerConfigurationStore {
    private let key = "CampusTracker.serverConfiguration"
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> ServerConfiguration? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? decoder.decode(ServerConfiguration.self, from: data)
    }

    func save(_ configuration: ServerConfiguration) {
        guard let data = try? encoder.encode(configuration) else { return }
        defaults.set(data, forKey: key)
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}

enum APIEndpoint {
    static let collectorLogin = "api/v1/collectors/login"
    static let health = "health"
}

enum APIClientError: LocalizedError {
    case invalidURL
    case invalidResponse
    case badRequest
    case unauthorized
    case notFound
    case conflict
    case serverError
    case networkUnavailable
    case timedOut
    case decodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "The server address is invalid."
        case .badRequest: return "The server rejected the request."
        case .unauthorized: return "Collector authentication failed."
        case .notFound: return "The collector or server endpoint was not found."
        case .conflict: return "The server reported a collector conflict."
        case .serverError: return "The server could not complete the request."
        case .networkUnavailable: return "Cannot connect to the server. Check the address, port, Wi-Fi, and server status."
        case .timedOut: return "The request timed out. Check the server connection."
        case .invalidResponse: return "The server returned an invalid response."
        case .decodingFailed: return "The server returned an unreadable response."
        }
    }
}

protocol APIClient {
    func send(_ request: URLRequest) async throws -> Data
}

final class HTTPAPIClient: APIClient {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func send(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIClientError.invalidResponse
            }
            switch httpResponse.statusCode {
            case 200...299:
                return data
            case 400:
                throw APIClientError.badRequest
            case 401:
                throw APIClientError.unauthorized
            case 404:
                throw APIClientError.notFound
            case 409:
                throw APIClientError.conflict
            case 500...599:
                throw APIClientError.serverError
            default:
                throw APIClientError.invalidResponse
            }
        } catch let error as APIClientError {
            throw error
        } catch let error as URLError {
            switch error.code {
            case .timedOut:
                throw APIClientError.timedOut
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .networkConnectionLost:
                throw APIClientError.networkUnavailable
            default:
                throw APIClientError.networkUnavailable
            }
        } catch {
            throw APIClientError.networkUnavailable
        }
    }
}

struct LoginRequest: Codable {
    let collectorId: String
    let deviceId: String
    let platform: String
    let deviceModel: String
    let systemVersion: String
    let appVersion: String
}

struct LoginResponse: Codable {
    let collectorId: String
    let accessToken: String
    let webSocketURL: String?
}

enum WebSocketConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed(String)

    var label: String {
        switch self {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting…"
        case .failed: return "Connection failed"
        }
    }
}

/// Standard RFC 6455 WebSocket transport using Foundation only.
final class RawWebSocketConnectionManager: NSObject, ObservableObject {
    @Published private(set) var state: WebSocketConnectionState = .disconnected

    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onTextMessage: ((String) -> Void)?

    private var urlSession: URLSession?
    private var task: URLSessionWebSocketTask?
    private var reconnectWorkItem: DispatchWorkItem?
    private var shouldReconnect = false
    private var reconnectAttempts = 0
    private var connectionURL: URL?
    private var accessToken: String?
    private var deviceId: String?

    func connect(url: URL, accessToken: String, deviceId: String) {
        guard task == nil || state == .disconnected || isFailed else { return }
        disconnect(reconnect: false)
        connectionURL = url
        self.accessToken = accessToken
        self.deviceId = deviceId
        shouldReconnect = true
        open(isReconnect: false)
    }

    func disconnect() {
        disconnect(reconnect: false)
    }

    func send(text: String, completion: @escaping (Error?) -> Void) {
        guard let task = task, state == .connected else {
            completion(APIClientError.networkUnavailable)
            return
        }
        task.send(.string(text), completionHandler: completion)
    }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    private func open(isReconnect: Bool) {
        guard let connectionURL = connectionURL, let accessToken = accessToken, let deviceId = deviceId else { return }
        state = isReconnect ? .reconnecting : .connecting
        var request = URLRequest(url: connectionURL)
        request.timeoutInterval = 10
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID")
        print("[WebSocket] create task url=\(connectionURL.absoluteString)")
        let configuration = URLSessionConfiguration.default
        urlSession = URLSession(configuration: configuration, delegate: self, delegateQueue: OperationQueue())
        let newTask = urlSession?.webSocketTask(with: request)
        task = newTask
        print("[WebSocket] resume() called")
        newTask?.resume()
    }

    private func receiveNext() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .string(text):
                    DispatchQueue.main.async { self.onTextMessage?(text) }
                case let .data(data):
                    if let text = String(data: data, encoding: .utf8) {
                        DispatchQueue.main.async { self.onTextMessage?(text) }
                    }
                @unknown default:
                    break
                }
                self.receiveNext()
            case let .failure(error):
                DispatchQueue.main.async { self.connectionEnded(error: error) }
            }
        }
    }

    private func connectionEnded(error: Error?) {
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        if let error = error {
            print("[WebSocket] receive/error: \(error.localizedDescription)")
        }
        onDisconnected?()
        scheduleReconnectIfNeeded()
    }

    private func disconnect(reconnect: Bool) {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        shouldReconnect = reconnect
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        if !reconnect { state = .disconnected }
    }

    private func scheduleReconnectIfNeeded() {
        guard shouldReconnect, connectionURL != nil else {
            state = .disconnected
            return
        }
        reconnectAttempts += 1
        state = .reconnecting
        let delay = min(pow(2.0, Double(reconnectAttempts - 1)), 15.0)
        let item = DispatchWorkItem { [weak self] in self?.open(isReconnect: true) }
        reconnectWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }
}

extension RawWebSocketConnectionManager: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        DispatchQueue.main.async {
            guard self.task === webSocketTask else { return }
            self.reconnectAttempts = 0
            self.state = .connected
            print("[WebSocket] connected")
            self.onConnected?()
            self.receiveNext()
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        DispatchQueue.main.async {
            guard self.task === webSocketTask else { return }
            let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? "—"
            print("[WebSocket] disconnected code=\(closeCode.rawValue) reason=\(reasonText)")
            self.connectionEnded(error: nil)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let webSocketTask = task as? URLSessionWebSocketTask else { return }
        DispatchQueue.main.async {
            guard self.task === webSocketTask else { return }
            self.connectionEnded(error: error)
        }
    }
}
