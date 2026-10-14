import Foundation

/// The capture streams that go through a `TrackingCaptureIngress`. Markers are user commands,
/// not sensor callbacks, and are submitted to `CollectionCore` directly.
nonisolated enum CaptureStream: String, CaseIterable, Codable, Sendable {
    case location, motion, altimeter, absoluteAltitude, pedometer, arkit
}

// Immutable copies made inside the sensor callback. No Core Location / Core Motion / ARKit
// object ever crosses a thread boundary.

nonisolated struct LocationCapture: Sendable {
    let timestamp: Date
    let latitude: Double
    let longitude: Double
    let altitude: Double
    let ellipsoidalAltitude: Double?
    let horizontalAccuracy: Double
    let verticalAccuracy: Double
    let speed: Double
    let course: Double
    let speedAccuracy: Double
    let courseAccuracy: Double
    let floor: Int?
}

nonisolated struct MotionCapture: Sendable {
    let nativeTimestamp: TimeInterval
    let userAcceleration: Vector3D
    let rotationRate: Vector3D
    let gravity: Vector3D
    let roll: Double
    let pitch: Double
    let yaw: Double
    let quaternion: QuaternionD
    let magneticField: CalibratedMagneticFieldSample?
}

nonisolated struct AltimeterCapture: Sendable {
    let nativeTimestamp: TimeInterval
    let relativeAltitude: Double
    let pressure: Double
}

nonisolated struct AbsoluteAltitudeCapture: Sendable {
    let nativeTimestamp: TimeInterval
    let altitude: Double
    let accuracy: Double
    let precision: Double
}

nonisolated struct PedometerCapture: Sendable {
    let endDate: Date
    let numberOfSteps: Int?
    let distance: Double?
    let currentPace: Double?
    let currentCadence: Double?
    let floorsAscended: Int?
    let floorsDescended: Int?
    let source: SensorCaptureSource
}

nonisolated enum CapturedPayload: Sendable {
    case location(LocationCapture)
    case motion(MotionCapture)
    case altimeter(AltimeterCapture)
    case absoluteAltitude(AbsoluteAltitudeCapture)
    case pedometer(PedometerCapture)
    case arkit(ARKitPoseSample)

    var stream: CaptureStream {
        switch self {
        case .location: return .location
        case .motion: return .motion
        case .altimeter: return .altimeter
        case .absoluteAltitude: return .absoluteAltitude
        case .pedometer: return .pedometer
        case .arkit: return .arkit
        }
    }
}

nonisolated struct CapturedSample: Sendable {
    let payload: CapturedPayload
    let callbackUptime: TimeInterval
    let callbackEpoch: Date
    let appState: CollectorAppState

    /// Call inside the sensor callback, before any hop, so callback time is not delivery time.
    static func now(_ payload: CapturedPayload, appState: CollectorAppState) -> CapturedSample {
        CapturedSample(payload: payload, callbackUptime: ProcessInfo.processInfo.systemUptime,
                       callbackEpoch: Date(), appState: appState)
    }
}

/// Local-only capture provenance stored next to every raw sample. Never sent on the wire.
nonisolated struct CaptureMetadata: Codable, Sendable, Equatable {
    var schemaVersion = 2
    let sessionID: UUID
    let segmentID: UUID
    let generation: UUID
    let nativeTimestamp: Double?
    let measuredEpochFromSystem: Date?
    let callbackUptime: Double
    let callbackEpoch: Date
    let appStateAtCapture: CollectorAppState
    var clockMappingVersion: Int? = nil
    var clockDomain: String? = nil
    var clockQuality: String? = nil
    var verifiedOffsetSeconds: Double? = nil
}

/// `raw_samples.payload_json` for rows written by this build. Rows imported from legacy NDJSON
/// are bare sample JSON (no envelope); both shapes decode through `RawSampleDecoding`.
nonisolated struct RawSampleEnvelope<Sample: Codable & Sendable>: Codable, Sendable {
    var schemaVersion = 2
    let capture: CaptureMetadata
    let sample: Sample
}

nonisolated struct ARKitRawRecord: Codable, Sendable {
    let pose: ARKitPoseSample
    let measuredAt: Date
}

nonisolated enum RawSampleDecoding {
    static func decode<Sample: Codable & Sendable>(_ type: Sample.Type, from data: Data) throws -> Sample {
        let decoder = TrackingJSONCodec.makeDecoder()
        if let envelope = try? decoder.decode(RawSampleEnvelope<Sample>.self, from: data) {
            return envelope.sample
        }
        return try decoder.decode(Sample.self, from: data)
    }

    /// Builds the unchanged server batch contract from durable raw rows.
    static func telemetryBatch(batchID: String, clientSessionID: String, rows: [RawRow],
                               createdAt: Date) throws -> TelemetryBatchPayload {
        var locations: [LocationPayload] = []
        var motion: [MotionPayload] = []
        var altimeter: [AltimeterPayload] = []
        var absoluteAltitude: [AbsoluteAltitudePayload] = []
        var pedometer: [PedometerPayload] = []
        for row in rows {
            switch row.stream {
            case CaptureStream.location.rawValue: locations.append(LocationPayload(try decode(LocationSample.self, from: row.payload)))
            case CaptureStream.motion.rawValue: motion.append(MotionPayload(try decode(MotionSample.self, from: row.payload)))
            case CaptureStream.altimeter.rawValue: altimeter.append(AltimeterPayload(try decode(AltimeterSample.self, from: row.payload)))
            case CaptureStream.absoluteAltitude.rawValue: absoluteAltitude.append(AbsoluteAltitudePayload(try decode(AbsoluteAltitudeSample.self, from: row.payload)))
            case CaptureStream.pedometer.rawValue: pedometer.append(PedometerPayload(try decode(PedometerSample.self, from: row.payload)))
            default:
                throw CollectionStoreError.invalidState("unbatchable raw stream \(row.stream)")
            }
        }
        return TelemetryBatchPayload(batchId: batchID, sessionId: nil, clientSessionId: clientSessionID, createdAt: createdAt,
                                     locations: locations, motion: motion, altimeter: altimeter,
                                     absoluteAltitude: absoluteAltitude, pedometer: pedometer)
    }
}

/// Lock-protected app-state snapshot readable from any sensor callback thread without touching
/// UIKit or the MainActor.
nonisolated final class CaptureAppStateBox: @unchecked Sendable {
    private let lock = NSLock()
    private var state: CollectorAppState = .foreground

    var value: CollectorAppState {
        lock.lock(); defer { lock.unlock() }
        return state
    }

    func set(_ newValue: CollectorAppState) {
        lock.lock(); defer { lock.unlock() }
        state = newValue
    }
}
