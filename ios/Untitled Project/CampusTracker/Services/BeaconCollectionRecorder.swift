import Combine
import Foundation

/// Collector-only glue (docs/BEACON_POSITIONING.md): active session + switches + cached registry -> beacon scanner ->
/// SQLite (`beacon_observations` + a `beacon` upload item per batch, one transaction) -> upload engine.
///
/// Deliberately outside `CollectionCore` / the sensor ingress: no beacon failure (no permission, Bluetooth, server or
/// config) can stop or delay GPS / motion / barometer capture. Settings keys: `beaconScanningEnabled` (default off),
/// `beaconUploadEnabled` (default on).
final class BeaconCollectionRecorder: ObservableObject {
    static let scanningKey = "beaconScanningEnabled"
    static let uploadKey = "beaconUploadEnabled"
    static let flushInterval: TimeInterval = 2
    static let flushCount = 200

    @Published private(set) var scannerState: BeaconScannerState = .idle
    @Published private(set) var plan: BeaconCollectionPlan?
    @Published private(set) var configVersion: Int?
    @Published private(set) var configFreshness: BeaconConfigFreshness = .missing
    @Published private(set) var lastError: String?
    @Published private(set) var observationCount = 0
    @Published private(set) var registeredCount = 0

    private let store: CollectionStore
    private let scanner: BeaconScanning
    private let defaults: UserDefaults
    private var registry: BeaconRegistry?
    private var sessionID: UUID?
    private var deviceModel: String?
    private var buffer: [BeaconObservation] = []
    private var flushTimer: Timer?
    private var cancellables: Set<AnyCancellable> = []
    private weak var coordinator: CollectionCoordinator?
    private weak var authentication: AuthenticationManager?

    init(store: CollectionStore, scanner: BeaconScanning? = nil, defaults: UserDefaults = .standard) {
        self.store = store
        self.scanner = scanner ?? CoreLocationBeaconScanner()
        self.defaults = defaults
        self.scanner.onStateChanged = { [weak self] in self?.scannerState = $0 }
        self.scanner.onObservations = { [weak self] in self?.record($0) }
    }

    /// Follows the coordinator's active session; called once from the root view.
    func bind(coordinator: CollectionCoordinator, authentication: AuthenticationManager) {
        guard self.coordinator == nil else { return }
        self.coordinator = coordinator
        self.authentication = authentication
        coordinator.$activeSession
            .map { $0?.id }
            .removeDuplicates()
            .sink { [weak self] id in self?.sessionChanged(id) }
            .store(in: &cancellables)
    }

    /// Re-evaluates after a settings change.
    func settingsChanged() { sessionChanged(sessionID, force: true) }

    private func sessionChanged(_ id: UUID?, force: Bool = false) {
        guard force || id != sessionID else { return }
        if id != sessionID { flush() }
        sessionID = id
        deviceModel = coordinator?.activeSession?.deviceModel
        let scanning = defaults.object(forKey: Self.scanningKey) as? Bool ?? false
        let upload = defaults.object(forKey: Self.uploadKey) as? Bool ?? true
        guard id != nil, scanning, let auth = authentication, let server = auth.configuration else {
            apply(BeaconCollectionPolicy.decide(activeSession: id != nil, localScanning: scanning, localUpload: upload, cached: nil, freshness: .missing),
                  localUpload: upload)
            return
        }
        let serverKey = server.ownerKey
        let configURL = server.baseURL?.appendingPathComponent("api/v1/positioning/beacon-config")
        let token = auth.currentAccessToken()
        let storage = SQLiteBeaconConfigStorage(store: store)
        Task.detached {
            // SQLite and the network stay off the main thread.
            let cache = BeaconConfigCache(storage: storage)
            let refreshed = await cache.refresh(serverKey: serverKey, now: Date()) { etag in
                try await Self.fetchConfig(url: configURL, token: token, etag: etag)
            }
            let freshness = cache.freshness(refreshed.cached, now: Date())
            await MainActor.run {
                guard self.sessionID == id else { return }
                if case let .failed(_, message) = refreshed { self.lastError = "config: \(message)" } else { self.lastError = nil }
                self.registry = refreshed.cached.map { BeaconRegistry(config: $0.config) }
                self.configVersion = refreshed.cached?.config.configVersion
                self.configFreshness = freshness
                self.apply(BeaconCollectionPolicy.decide(activeSession: true, localScanning: scanning, localUpload: upload,
                                                         cached: refreshed.cached, freshness: freshness), localUpload: upload)
            }
        }
    }

    private func apply(_ plan: BeaconCollectionPlan, localUpload: Bool) {
        self.plan = plan
        // while ranging: the plan (local + remote switch); otherwise held batches of earlier sessions follow the local switch
        coordinator?.setBeaconUploadEnabled(plan.scan ? plan.upload : localUpload)
        guard plan.scan else {
            scanner.stop()
            flushTimer?.invalidate()
            flushTimer = nil
            return
        }
        scanner.start(proximityUUIDs: plan.uuids.compactMap(UUID.init(uuidString:)))
        flushTimer?.invalidate()
        flushTimer = Timer.scheduledTimer(withTimeInterval: Self.flushInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    private func record(_ observations: [BeaconObservation]) {
        guard sessionID != nil else { return }
        observationCount += observations.count
        registeredCount += observations.filter { registry?.lookup(uuid: $0.uuid, major: $0.major, minor: $0.minor) != nil }.count
        buffer.append(contentsOf: observations)
        if buffer.count >= Self.flushCount { flush() }
    }

    /// Raw rows + upload item in one SQLite transaction; the engine learns about the item after the commit.
    private func flush() {
        guard let id = sessionID, !buffer.isEmpty else { buffer = []; return }
        let rows = buffer
        buffer = []
        let batchID = UUID().uuidString
        let payload = BeaconObservationBatchPayload(batchId: batchID, sessionId: nil, clientSessionId: id.uuidString,
                                                    deviceModel: deviceModel, createdAt: Date(), observations: rows)
        store.async({ access in
            try access.commitBeaconBatch(sessionID: id, batchID: batchID, observations: rows,
                                         payload: try TrackingJSONCodec.makeEncoder().encode(payload))
        }) { [weak self] result in
            switch result {
            case let .success(record): self?.coordinator?.ingestUploadItems([record])
            case let .failure(error):
                self?.lastError = "store: \(error)"
                print("[BeaconRecorder] beacon batch commit failed error=\(error)")
            }
        }
    }

    nonisolated private static func fetchConfig(url: URL?, token: String?, etag: String?) async throws -> BeaconConfigResponse {
        guard let url, let token else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return BeaconConfigResponse(status: http.statusCode, etag: http.value(forHTTPHeaderField: "ETag"), body: http.statusCode == 200 ? data : nil)
    }
}

/// The collector keeps the registry cache in collection-v2.sqlite (`beacon_config_cache`). Never call on the main thread.
nonisolated struct SQLiteBeaconConfigStorage: BeaconConfigStorage {
    let store: CollectionStore
    func loadBeaconConfig(serverKey: String) throws -> CachedBeaconConfig? { try store.sync { try $0.loadBeaconConfig(serverKey: serverKey) } }
    func saveBeaconConfig(_ cached: CachedBeaconConfig) throws { try store.sync { try $0.saveBeaconConfig(cached) } }
}
