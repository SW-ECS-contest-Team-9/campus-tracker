import Combine
import Foundation
import Security

struct AuthenticatedCollector: Codable, Equatable {
    let collectorId: String
}

enum AuthenticationState: Equatable {
    case unknown
    case signedOut
    case authenticating
    case authenticated(AuthenticatedCollector)
    case failed(String)
}

protocol AuthTokenStore {
    func save(_ token: String) throws
    func load() throws -> String?
    func delete() throws
}

enum KeychainError: Error {
    case unexpectedStatus(OSStatus)
    case invalidData
}

final class KeychainAuthTokenStore: AuthTokenStore {
    private let service = "CampusTracker.authentication"
    private let account = "accessToken"

    func save(_ token: String) throws {
        try delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }

    func load() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
        guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw KeychainError.invalidData
        }
        return token
    }

    func delete() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}

protocol AuthService {
    func login(
        collectorId: String,
        configuration: ServerConfiguration,
        deviceInfo: DeviceInfo
    ) async throws -> LoginResponse

    func testConnection(configuration: ServerConfiguration) async throws
}

final class HTTPAuthService: AuthService {
    private let client: APIClient

    init(client: APIClient = HTTPAPIClient()) {
        self.client = client
    }

    func login(
        collectorId: String,
        configuration: ServerConfiguration,
        deviceInfo: DeviceInfo
    ) async throws -> LoginResponse {
        guard let baseURL = configuration.baseURL else { throw APIClientError.invalidURL }
        let requestBody = LoginRequest(
            collectorId: collectorId,
            deviceId: deviceInfo.deviceId.uuidString,
            platform: "ios",
            deviceModel: deviceInfo.deviceModel,
            systemVersion: deviceInfo.systemVersion,
            appVersion: deviceInfo.appVersion
        )
        var request = URLRequest(url: baseURL.appendingPathComponent(APIEndpoint.collectorLogin))
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(requestBody)

        let data = try await client.send(request)
        guard let response = try? JSONDecoder().decode(LoginResponse.self, from: data) else {
            throw APIClientError.decodingFailed
        }
        return response
    }

    func testConnection(configuration: ServerConfiguration) async throws {
        guard let baseURL = configuration.baseURL else { throw APIClientError.invalidURL }
        var request = URLRequest(url: baseURL.appendingPathComponent(APIEndpoint.health))
        request.timeoutInterval = 5
        _ = try await client.send(request)
    }
}

@MainActor
final class AuthenticationManager: ObservableObject {
    @Published private(set) var state: AuthenticationState = .unknown
    @Published private(set) var configuration: ServerConfiguration?
    @Published private(set) var collectorId: String?

    /// Shared app-lifetime transport. Collection code receives this object by injection.
    let webSocket = RawWebSocketConnectionManager()

    private let configurationStore: ServerConfigurationStore
    private let tokenStore: AuthTokenStore
    private let authService: AuthService
    private let defaults: UserDefaults
    private let collectorIDKey = "CampusTracker.collectorId"

    init(
        configurationStore: ServerConfigurationStore? = nil,
        tokenStore: AuthTokenStore? = nil,
        authService: AuthService? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.configurationStore = configurationStore ?? UserDefaultsServerConfigurationStore()
        self.tokenStore = tokenStore ?? KeychainAuthTokenStore()
        self.authService = authService ?? HTTPAuthService()
        self.defaults = defaults
        restoreSession()
    }

    var authenticatedCollector: AuthenticatedCollector? {
        guard case let .authenticated(collector) = state else { return nil }
        return collector
    }

    func restoreSession() {
        configuration = configurationStore.load()
        collectorId = normalizedCollectorID(defaults.string(forKey: collectorIDKey) ?? "")
        do {
            if let collectorId = collectorId, try tokenStore.load() != nil {
                state = .authenticated(AuthenticatedCollector(collectorId: collectorId))
                connectWebSocketIfPossible()
            } else {
                state = .signedOut
            }
        } catch {
            state = .signedOut
        }
    }

    func saveConfiguration(_ proposed: ServerConfiguration) -> String? {
        guard let error = proposed.validationError else {
            let configurationChanged = configuration != proposed
            configurationStore.save(proposed)
            configuration = proposed
            if configurationChanged {
                logout()
            }
            return nil
        }
        return error
    }

    func saveCollectorID(_ value: String) -> String? {
        guard let normalized = normalizedCollectorID(value) else {
            return "Enter a collector ID."
        }
        let changed = collectorId != normalized
        defaults.set(normalized, forKey: collectorIDKey)
        collectorId = normalized
        if changed {
            logout()
        }
        return nil
    }

    func testConnection(configuration: ServerConfiguration) async -> String? {
        guard let error = configuration.validationError else {
            do {
                try await authService.testConnection(configuration: configuration)
                return nil
            } catch {
                return userMessage(for: error)
            }
        }
        return error
    }

    func login(configuration: ServerConfiguration, collectorID: String) async {
        guard let configurationError = saveConfiguration(configuration) else {
            guard let collectorError = saveCollectorID(collectorID) else {
                state = .authenticating
                let capabilities = SensorCapabilityDetector.detect()
                let deviceInfo = DeviceInfoProvider.current(capabilities: capabilities)
                do {
                    let result = try await authService.login(
                        collectorId: collectorId ?? collectorID,
                        configuration: configuration,
                        deviceInfo: deviceInfo
                    )
                    try tokenStore.save(result.accessToken)
                    let authenticated = AuthenticatedCollector(collectorId: result.collectorId)
                    defaults.set(authenticated.collectorId, forKey: collectorIDKey)
                    collectorId = authenticated.collectorId
                    state = .authenticated(authenticated)
                    connectWebSocket(using: result, deviceInfo: deviceInfo)
                } catch {
                    state = .failed(userMessage(for: error))
                }
                return
            }
            state = .failed(collectorError)
            return
        }
        state = .failed(configurationError)
    }

    func logout() {
        webSocket.disconnect()
        try? tokenStore.delete()
        state = .signedOut
    }

    func resetSettings() {
        webSocket.disconnect()
        try? tokenStore.delete()
        configurationStore.clear()
        defaults.removeObject(forKey: collectorIDKey)
        configuration = nil
        collectorId = nil
        state = .signedOut
    }

    private func normalizedCollectorID(_ value: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 64 else { return nil }
        return value
    }

    private func connectWebSocket(using response: LoginResponse, deviceInfo: DeviceInfo) {
        let endpoint = URL(string: response.webSocketURL ?? "") ?? configuration?.webSocketURL
        guard let endpoint = endpoint, let token = try? tokenStore.load() else {
            print("[WebSocket] skipped: no endpoint or access token")
            return
        }
        webSocket.connect(url: endpoint, accessToken: token, deviceId: deviceInfo.deviceId.uuidString)
    }

    private func connectWebSocketIfPossible() {
        let device = DeviceInfoProvider.current(capabilities: SensorCapabilityDetector.detect())
        guard let endpoint = configuration?.webSocketURL,
              let token = try? tokenStore.load() else {
            return
        }
        webSocket.connect(url: endpoint, accessToken: token, deviceId: device.deviceId.uuidString)
    }

    private func userMessage(for error: Error) -> String {
        if let error = error as? LocalizedError, let description = error.errorDescription {
            return description
        }
        return "The request could not be completed. Check the server settings and try again."
    }
}
