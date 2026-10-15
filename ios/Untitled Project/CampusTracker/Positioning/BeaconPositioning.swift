import Foundation

// Platform-neutral BLE positioning core (Foundation only): observation model, server config, RSSI model and the
// measurement filter. Shared by the collector and a future navigator; extractable into a Swift package as is.
// The model and constants mirror the server's fusion-v4 rev 18 (backend/src/modules/fusion/fusion-beacon.ts,
// positioning/beacon-calibration.ts) and are checked against fixtures/beacon/measurement-model.json.

nonisolated enum RssiAggregation {
    /// Core Location ranging: RSSI averaged by the OS over about one second.
    static let coreLocationRanging = "CORE_LOCATION_RANGING"
    /// Android: one advertisement.
    static let singleAdvertisement = "SINGLE_ADVERTISEMENT"
}

/// Server identity key: `IBEACON:<lower-case uuid>:<major>:<minor>`.
nonisolated func beaconKey(uuid: String, major: Int, minor: Int) -> String {
    "IBEACON:\(uuid.lowercased()):\(major):\(minor)"
}

/// One beacon observation (the `beacon.observations.v1` row before serialization). No session or upload state.
nonisolated struct BeaconObservation: Codable, Sendable, Equatable {
    var observationId: String
    var protocolName: String = "IBEACON"
    var uuid: String
    var major: Int
    var minor: Int
    var rssiDbm: Int
    var observedAt: Date
    /// CLBeacon.accuracy (m). Reference only, never used as a range measurement. nil when negative (unknown).
    var platformEstimatedDistanceMeters: Double?
    var proximity: String?
    var observationTimeUncertaintyMs: Double?
    var rssiAggregation: String
    var sampleCount: Int?
    var measuredPowerDbm: Int?

    var key: String { beaconKey(uuid: uuid, major: major, minor: minor) }

    enum CodingKeys: String, CodingKey {
        case observationId, protocolName = "protocol", uuid, major, minor, rssiDbm, observedAt, platformEstimatedDistanceMeters,
             proximity, observationTimeUncertaintyMs, rssiAggregation, sampleCount, measuredPowerDbm
    }
}

// MARK: - Server config (GET /api/v1/positioning/beacon-config); unknown fields are ignored by Codable

nonisolated struct BeaconAnchorPosition: Codable, Sendable, Equatable { let x: Double; let y: Double; let z: Double }

nonisolated struct BeaconAnchor: Codable, Sendable, Equatable {
    let anchorId: String
    let buildingId: String
    let floor: String?
    let floorHeightM: Double?
    /// EPSG:5186 metres; z = mounting height above MSL (KVD Incheon)
    let position: BeaconAnchorPosition
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyM: Double?
}

nonisolated struct BeaconCalibration: Codable, Sendable, Equatable {
    var beaconId: String?
    var platform: String = "*"
    var deviceGroup: String = "*"
    let measuredPower1m: Double
    let pathLossExponent: Double
    let rssiVariance: Double
    var sampleCount: Int?
}

nonisolated struct RegisteredBeacon: Codable, Sendable, Equatable {
    let beaconId: String
    let uuid: String
    let major: Int
    let minor: Int
    let measuredPowerDbm: Int?
    let anchor: BeaconAnchor?
    let calibrations: [BeaconCalibration]?
    var key: String { beaconKey(uuid: uuid, major: major, minor: minor) }
}

nonisolated struct BeaconFeatures: Codable, Sendable, Equatable {
    var scanning = false
    var upload = false
    var fusion = false
    var floorCorrection = false
}

nonisolated struct BeaconCachePolicy: Codable, Sendable, Equatable {
    var maxAgeSeconds: Double = 3_600
    var staleMaxSeconds: Double = 14 * 86_400
}

nonisolated struct RssiDefaults: Codable, Sendable, Equatable {
    var measuredPower1m: Double = -59
    var pathLossExponent: Double = 2.2
    var rssiVariance: Double = 36
}

nonisolated struct BeaconConfig: Codable, Sendable, Equatable {
    let schemaVersion: Int
    let configVersion: Int
    var cachePolicy: BeaconCachePolicy?
    var features: BeaconFeatures?
    var proximityUuids: [String]?
    var rssiDefaults: RssiDefaults?
    var defaultCalibrations: [BeaconCalibration]?
    var beacons: [RegisteredBeacon]?
}

/// Read-only lookup over one config.
nonisolated struct BeaconRegistry: Sendable {
    let config: BeaconConfig
    private let byKey: [String: RegisteredBeacon]

    init(config: BeaconConfig) {
        self.config = config
        self.byKey = Dictionary((config.beacons ?? []).map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
    }

    var proximityUUIDs: [UUID] { (config.proximityUuids ?? []).compactMap(UUID.init(uuidString:)) }

    func lookup(uuid: String, major: Int, minor: Int) -> RegisteredBeacon? { byKey[beaconKey(uuid: uuid, major: major, minor: minor)] }

    func model(for beacon: RegisteredBeacon, platform: String = "ios", deviceModel: String?) -> RssiModel {
        let own = (beacon.calibrations ?? []).map { c -> BeaconCalibration in var c = c; c.beaconId = beacon.beaconId; return c }
        let global = (config.defaultCalibrations ?? []).map { c -> BeaconCalibration in var c = c; c.beaconId = nil; return c }
        return RssiModel.select(rows: own + global, beaconId: beacon.beaconId, platform: platform, deviceModel: deviceModel,
                                advertisedPower: beacon.measuredPowerDbm, defaults: config.rssiDefaults ?? RssiDefaults())
    }
}

// MARK: - Measurement model

nonisolated struct RssiModel: Sendable, Equatable {
    let measuredPower1m: Double
    let pathLossExponent: Double
    let rssiVariance: Double
    let source: String

    /// d = 10^((P1m - rssi) / (10 n)), metres (3D)
    func range(rssi: Double) -> Double { pow(10, (measuredPower1m - rssi) / (10 * pathLossExponent)) }
    /// 1-sigma of ln(range)
    var lnRangeSigma: Double { rssiVariance.squareRoot() * log(10) / (10 * pathLossExponent) }

    /// Most specific calibration (beacon x platform x device ... global), else the advertised 1 m power, else defaults.
    /// A calibration of one platform is never used on the other (Core Location aggregates vs single advertisements).
    static func select(rows: [BeaconCalibration], beaconId: String?, platform: String, deviceModel: String?,
                       advertisedPower: Int?, defaults: RssiDefaults = RssiDefaults()) -> RssiModel {
        let order: [(String?, String, String, String)] = [
            (beaconId, platform, deviceModel ?? "", "BEACON_DEVICE"), (beaconId, platform, "*", "BEACON_PLATFORM"),
            (beaconId, "*", "*", "BEACON"), (nil, platform, deviceModel ?? "", "GLOBAL_DEVICE"),
            (nil, platform, "*", "GLOBAL_PLATFORM"), (nil, "*", "*", "GLOBAL"),
        ]
        for (b, p, g, source) in order {
            if b == nil && source.hasPrefix("BEACON") { continue }
            if g.isEmpty { continue }
            if let row = rows.first(where: { $0.beaconId == b && $0.platform == p && $0.deviceGroup == g }) {
                return RssiModel(measuredPower1m: row.measuredPower1m, pathLossExponent: row.pathLossExponent, rssiVariance: row.rssiVariance, source: source)
            }
        }
        if let advertisedPower, advertisedPower < 0 {
            return RssiModel(measuredPower1m: Double(advertisedPower), pathLossExponent: defaults.pathLossExponent, rssiVariance: defaults.rssiVariance, source: "ADVERTISED")
        }
        return RssiModel(measuredPower1m: defaults.measuredPower1m, pathLossExponent: defaults.pathLossExponent, rssiVariance: defaults.rssiVariance, source: "DEFAULT")
    }
}

nonisolated struct BeaconRangeMeasurement: Sendable, Equatable {
    let key: String
    let time: Date
    let medianRssi: Double
    let rangeM: Double
    let lnRange: Double
    let lnVariance: Double
    let upperRangeM: Double
    let samples: Int
}

nonisolated enum BeaconMeasurementRejection: Error, Equatable { case rssiOutOfRange, rssiOutlier, tooFar, throttled, stale }

/// Per-beacon RSSI window (median, MAD outlier rejection, throttling, stale drop). Same constants as fusion-v4 rev 18.
nonisolated struct BeaconMeasurementFilter: Sendable {
    var windowSeconds = 3.0
    var updateIntervalSeconds = 1.0
    var maxAgeSeconds = 4.0
    var minRssi = -100.0
    var maxRssi = -20.0
    var outlierMinDb = 8.0
    var maxEffectiveSamples = 3
    var minRangeM = 0.5
    var maxRangeM = 25.0

    private struct Sample: Sendable { let t: Date; let rssi: Double; let n: Int }
    private var windows: [String: [Sample]] = [:]
    private var lastUpdate: [String: Date] = [:]
    private var newest: Date?

    init() {}

    mutating func add(key: String, time: Date, rssi: Double, sampleCount: Int, model: RssiModel,
                      anchorAccuracyM: Double = 0) -> Result<BeaconRangeMeasurement, BeaconMeasurementRejection> {
        guard rssi.isFinite, rssi >= minRssi, rssi <= maxRssi else { return .failure(.rssiOutOfRange) }
        if let newest, time.timeIntervalSince(newest) < -maxAgeSeconds { return .failure(.stale) }
        newest = max(newest ?? time, time)
        var w = (windows[key] ?? []).filter { $0.t.timeIntervalSince(time) > -windowSeconds && $0.t <= time }
        if w.count >= 3 {
            let m = Self.median(w.map(\.rssi))
            let mad = Self.median(w.map { abs($0.rssi - m) })
            if abs(rssi - m) > max(outlierMinDb, 3 * 1.4826 * mad) { windows[key] = w; return .failure(.rssiOutlier) }
        }
        w.append(Sample(t: time, rssi: rssi, n: max(1, sampleCount)))
        windows[key] = w
        if let last = lastUpdate[key], time.timeIntervalSince(last) < updateIntervalSeconds { return .failure(.throttled) }
        lastUpdate[key] = time
        let med = Self.median(w.map(\.rssi))
        let range = max(minRangeM, model.range(rssi: med))
        guard range <= maxRangeM else { return .failure(.tooFar) }
        let n = min(maxEffectiveSamples, w.reduce(0) { $0 + $1.n })
        let variance = pow(model.lnRangeSigma, 2) / Double(n) + pow(anchorAccuracyM / max(range, 1), 2)
        return .success(BeaconRangeMeasurement(key: key, time: time, medianRssi: med, rangeM: range, lnRange: log(range),
                                               lnVariance: variance, upperRangeM: range * exp(2 * variance.squareRoot()), samples: n))
    }

    /// Signal loss / session end: every window is forgotten.
    mutating func reset() { windows = [:]; lastUpdate = [:]; newest = nil }

    private static func median(_ v: [Double]) -> Double {
        let s = v.sorted()
        let m = s.count / 2
        return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
    }
}

// MARK: - CLBeacon adapter (pure part)

/// Core Location -> observation. RSSI is Core Location's own ~1 s aggregate; 0 means "unknown" and is dropped.
/// The platform distance (CLBeacon.accuracy) is kept only as reference data and only when non-negative and finite.
nonisolated enum BeaconObservationAdapter {
    static let rssiRange = -120...(-1)

    static func observation(uuid: UUID, major: Int, minor: Int, rssi: Int, accuracy: Double, proximity: String,
                            timestamp: Date, id: String = UUID().uuidString) -> BeaconObservation? {
        guard rssiRange.contains(rssi), (0...65_535).contains(major), (0...65_535).contains(minor) else { return nil }
        let distance = accuracy.isFinite && accuracy >= 0 && accuracy < 1_000 ? accuracy : nil
        return BeaconObservation(observationId: id, uuid: uuid.uuidString.lowercased(), major: major, minor: minor, rssiDbm: rssi,
                                 observedAt: timestamp, platformEstimatedDistanceMeters: distance,
                                 proximity: proximity, observationTimeUncertaintyMs: 1_000,
                                 rssiAggregation: RssiAggregation.coreLocationRanging, sampleCount: nil, measuredPowerDbm: nil)
    }
}

// MARK: - Registry cache (storage injected: SQLite in the collector, a file in other apps)

nonisolated struct CachedBeaconConfig: Codable, Sendable, Equatable {
    let config: BeaconConfig
    let etag: String?
    let fetchedAt: Date
    let serverKey: String
}

nonisolated enum BeaconConfigFreshness: String, Sendable { case fresh, staleUsable, expired, missing }

nonisolated protocol BeaconConfigStorage: Sendable {
    func loadBeaconConfig(serverKey: String) throws -> CachedBeaconConfig?
    func saveBeaconConfig(_ cached: CachedBeaconConfig) throws
}

nonisolated enum BeaconConfigRefresh: Sendable, Equatable {
    case updated(CachedBeaconConfig), notModified(CachedBeaconConfig), skipped(CachedBeaconConfig), failed(CachedBeaconConfig?, String)

    var cached: CachedBeaconConfig? {
        switch self {
        case let .updated(c), let .notModified(c), let .skipped(c): return c
        case let .failed(c, _): return c
        }
    }
}

/// Fetch result: HTTP status, ETag, body (304 = not modified).
nonisolated struct BeaconConfigResponse: Sendable { let status: Int; let etag: String?; let body: Data? }

nonisolated struct BeaconConfigCache: Sendable {
    let storage: BeaconConfigStorage

    func freshness(_ cached: CachedBeaconConfig?, now: Date) -> BeaconConfigFreshness {
        guard let cached else { return .missing }
        let age = now.timeIntervalSince(cached.fetchedAt)
        let policy = cached.config.cachePolicy ?? BeaconCachePolicy()
        if age < 0 { return .staleUsable }
        if age < policy.maxAgeSeconds { return .fresh }
        if age < policy.staleMaxSeconds { return .staleUsable }
        return .expired
    }

    /// Re-validates with If-None-Match when the cache is not fresh. Any failure keeps the cache (offline positioning).
    func refresh(serverKey: String, now: Date, force: Bool = false,
                 fetch: (String?) async throws -> BeaconConfigResponse) async -> BeaconConfigRefresh {
        let cached = (try? storage.loadBeaconConfig(serverKey: serverKey)) ?? nil
        if !force, let cached, freshness(cached, now: now) == .fresh { return .skipped(cached) }
        do {
            let response = try await fetch(cached?.etag)
            if response.status == 304, let cached {
                let touched = CachedBeaconConfig(config: cached.config, etag: cached.etag, fetchedAt: now, serverKey: serverKey)
                try storage.saveBeaconConfig(touched)
                return .notModified(touched)
            }
            guard response.status == 200, let body = response.body else { return .failed(cached, "HTTP \(response.status)") }
            let config = try JSONDecoder().decode(BeaconConfig.self, from: body)
            guard config.schemaVersion == 1 else { return .failed(cached, "unsupported schemaVersion \(config.schemaVersion)") }
            let fresh = CachedBeaconConfig(config: config, etag: response.etag, fetchedAt: now, serverKey: serverKey)
            try storage.saveBeaconConfig(fresh)
            return .updated(fresh)
        } catch {
            return .failed(cached, String(describing: error))
        }
    }
}

/// File storage for apps without the collector's SQLite store (e.g. a navigator).
nonisolated struct FileBeaconConfigStorage: BeaconConfigStorage {
    let url: URL

    func loadBeaconConfig(serverKey: String) throws -> CachedBeaconConfig? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        guard let cached = try? decoder.decode(CachedBeaconConfig.self, from: data), cached.serverKey == serverKey else { return nil }
        return cached
    }

    func saveBeaconConfig(_ cached: CachedBeaconConfig) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(cached).write(to: url, options: .atomic)
    }
}

// MARK: - Collection policy (same rules as Android BeaconCollectionPolicy)

nonisolated struct BeaconCollectionPlan: Sendable, Equatable {
    let scan: Bool
    let upload: Bool
    /// lower-case proximity UUIDs to range
    let uuids: [String]
    let reason: String
}

nonisolated enum BeaconCollectionPolicy {
    /// Ranges only during an active session, with the local switch on, the server's remote switch on and a usable
    /// registry. An expired cache still lets the collector record raw observations of the UUIDs it knows (the server
    /// resolves them); the remote switch of an expired config is not trusted to be on.
    static func decide(activeSession: Bool, localScanning: Bool, localUpload: Bool, cached: CachedBeaconConfig?,
                       freshness: BeaconConfigFreshness) -> BeaconCollectionPlan {
        guard activeSession else { return BeaconCollectionPlan(scan: false, upload: false, uuids: [], reason: "NO_ACTIVE_SESSION") }
        guard localScanning else { return BeaconCollectionPlan(scan: false, upload: false, uuids: [], reason: "LOCAL_SWITCH_OFF") }
        guard let cached else { return BeaconCollectionPlan(scan: false, upload: false, uuids: [], reason: "NO_CONFIG") }
        let features = cached.config.features ?? BeaconFeatures()
        if freshness != .expired && !features.scanning {
            return BeaconCollectionPlan(scan: false, upload: false, uuids: [], reason: "SERVER_SWITCH_OFF")
        }
        let uuids = Array(Set((cached.config.proximityUuids ?? []).map { $0.lowercased() })).sorted()
        guard !uuids.isEmpty else { return BeaconCollectionPlan(scan: false, upload: false, uuids: [], reason: "NO_REGISTERED_BEACONS") }
        let upload = localUpload && (freshness == .expired || features.upload)
        return BeaconCollectionPlan(scan: true, upload: upload, uuids: uuids, reason: freshness == .expired ? "EXPIRED_CONFIG" : "OK")
    }
}
