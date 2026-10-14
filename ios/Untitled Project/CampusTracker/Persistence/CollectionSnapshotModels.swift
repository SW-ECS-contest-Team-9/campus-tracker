import Foundation

nonisolated enum CollectorAppState: String, Codable, Sendable {
    case foreground
    case background
    case inactive
}

nonisolated struct SensorGapSummary: Codable, Sendable {
    var count = 0
    var maximumMilliseconds = 0.0

    mutating func record(previous: Date?, current: Date, expectedInterval: TimeInterval) {
        guard let previous else { return }
        let gap = current.timeIntervalSince(previous)
        guard gap > max(expectedInterval * 3, 1) else { return }
        count += 1
        maximumMilliseconds = max(maximumMilliseconds, gap * 1_000)
    }
}

/// Per-stream clock observations. `.nominal` mapping means "native timestamps are assumed to be
/// boot-relative uptime" — it is an assumption, not a verified result. The residual mixes
/// delivery latency and any clock-domain difference; it cannot separate the two on its own.
nonisolated struct ClockStreamDiagnostics: Codable, Sendable, Equatable {
    var domain: String
    var quality: String
    var mappingVersion: Int
    var verifiedOffsetSeconds: Double
    var samples = 0
    var firstResidualSeconds: Double?
    var maximumAbsoluteResidualSeconds = 0.0
    var residualSumSeconds = 0.0
    var maximumNativeGapSeconds = 0.0
    var nonIncreasingNativeTimestamps = 0
}

nonisolated struct CollectionDiagnostics: Codable, Sendable {
    var foregroundDuration: TimeInterval = 0
    var backgroundDuration: TimeInterval = 0
    var backgroundTransitionCount = 0
    var locationGaps = SensorGapSummary()
    var motionGaps = SensorGapSummary()
    var altimeterGaps = SensorGapSummary()
    var pedometerGaps = SensorGapSummary()
    var pendingUploadPeakCount = 0
    var lowPowerModeObserved = false
    var thermalStatePeak = 0
    var wasInterrupted = false
    // Optional so snapshots written before these fields existed still decode.
    var clock: [String: ClockStreamDiagnostics]? = nil
    var lateCallbackDrops: [String: Int]? = nil
    var invalidSampleDrops: [String: Int]? = nil
    var pedometerDuplicateDrops: Int? = nil
    var pedometerDuplicateConflicts: Int? = nil
    var arkitBackpressurePauses: Int? = nil
}

nonisolated struct PendingStopState: Codable, Equatable, Sendable {
    let endedAt: Date
    let reason: String
    let locationSequence: Int
    let motionSequence: Int
    let altimeterSequence: Int
    let pedometerSequence: Int
}

/// The durable per-session capture snapshot. Since the SQLite migration this lives in
/// `sessions.snapshot_json`; it is no longer written to `active_collection.json`.
nonisolated struct ActiveCollectionState: Codable, Sendable {
    var session: CollectionSession
    var motionRate: MotionSamplingRate
    var locationProfile: LocationCollectionProfile
    var distanceFilter: Double
    var locationSequence: Int
    var motionSequence: Int
    var altimeterSequence: Int
    var pedometerSequence: Int
    var lastPersistedAt: Date
    var lastLocationTimestamp: Date?
    var lastMotionTimestamp: Date?
    var lastAltimeterTimestamp: Date?
    var lastPedometerTimestamp: Date?
    var diagnostics: CollectionDiagnostics
    var pendingStop: PendingStopState? = nil
}

/// Legacy per-stream lease file format (`sequence_leases/<session>.json`). Each value is the
/// first sequence not yet reserved (exclusive boundary). Read only by the one-time migration.
nonisolated struct SequenceLease: Codable, Sendable {
    var location = 0
    var motion = 0
    var altimeter = 0
    var pedometer = 0
}
