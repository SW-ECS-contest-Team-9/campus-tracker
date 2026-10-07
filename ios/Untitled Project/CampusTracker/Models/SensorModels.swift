import Foundation
import CoreLocation

nonisolated struct SensorCapabilities: Codable, Sendable {
    let locationAvailable: Bool
    let deviceMotionAvailable: Bool
    let altimeterAvailable: Bool
    let stepCountingAvailable: Bool
    let distanceAvailable: Bool
    let floorCountingAvailable: Bool
    let paceAvailable: Bool
    let cadenceAvailable: Bool
    var attitudeReferenceFrame: String?
    var motionUpdateHz: Int?
    var locationAuthorization: String?
    var locationAccuracyAuthorization: String?
    var backgroundLocationUpdates: Bool?
    var pausesLocationUpdatesAutomatically: Bool?

    var pedometerAvailable: Bool {
        stepCountingAvailable || distanceAvailable || floorCountingAvailable || paceAvailable || cadenceAvailable
    }
}

/// A personal flat-ground stride snapshot derived from HealthKit `walkingStepLength`, fixed once
/// at session start (see `HealthStrideService`). Matches the server's `strideCalibration` v1
/// contract in `docs/HEALTH_STRIDE_SERVER_PLAN.md` exactly — field names and units are a network
/// contract, not free to rename.
nonisolated struct StrideCalibration: Codable, Sendable, Equatable {
    static let schemaVersionV1 = 1
    static let sourceAppleHealthWalkingStepLength = "APPLE_HEALTH_WALKING_STEP_LENGTH"
    static let aggregationVersionMedianMadV1 = "median_mad_v1"
    static let sourcePolicyIPhoneAutomaticV1 = "IPHONE_AUTOMATIC_V1"

    let schemaVersion: Int
    let source: String
    let aggregationVersion: String
    let sourcePolicy: String
    let stepLengthM: Double
    let sampleCount: Int
    let observedDays: Int
    let dispersionM: Double
    let windowStart: Date
    let windowEnd: Date
    let latestSampleAt: Date
    let computedAt: Date
}

/// The server's acknowledgement of a submitted `StrideCalibration`. `status`/`reason` are decoded
/// as plain strings (not enums) so a future server value this build doesn't know about still
/// decodes instead of failing the whole `session:start` ACK.
nonisolated struct StrideCalibrationAck: Codable, Sendable, Equatable {
    let status: String
    let reason: String?
}

struct DeviceInfo: Codable {
    let deviceId: UUID
    let deviceModel: String
    let systemName: String
    let systemVersion: String
    let appVersion: String
    let sensorCapabilities: SensorCapabilities
}

enum CollectionStatus: String, Codable {
    case recording
    case completed
}

struct SampleCounts: Codable {
    var location = 0
    var motion = 0
    var altimeter = 0
    var pedometer = 0
    var marker = 0
}

nonisolated struct CollectionSession: Codable, Identifiable {
    let id: UUID
    let collectorId: String
    let deviceId: UUID
    let startedAt: Date
    var endedAt: Date?
    var status: CollectionStatus
    var serverSessionId: String?
    let deviceModel: String
    let systemVersion: String
    let sensorCapabilities: SensorCapabilities
    var sampleCounts: SampleCounts
    /// Fixed once at session creation from whatever HealthKit candidate was ready at that
    /// instant (see `HealthStrideService.readyCandidateForNewSession(sessionStartedAt:)`).
    /// `let`, not `var`: nothing after session creation is allowed to touch this.
    let strideCalibration: StrideCalibration?

    init(
        id: UUID,
        collectorId: String,
        deviceId: UUID,
        startedAt: Date,
        endedAt: Date? = nil,
        status: CollectionStatus,
        serverSessionId: String? = nil,
        deviceModel: String,
        systemVersion: String,
        sensorCapabilities: SensorCapabilities,
        sampleCounts: SampleCounts,
        strideCalibration: StrideCalibration? = nil
    ) {
        self.id = id
        self.collectorId = collectorId
        self.deviceId = deviceId
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.status = status
        self.serverSessionId = serverSessionId
        self.deviceModel = deviceModel
        self.systemVersion = systemVersion
        self.sensorCapabilities = sensorCapabilities
        self.sampleCounts = sampleCounts
        self.strideCalibration = strideCalibration
    }

    enum CodingKeys: String, CodingKey {
        case id, collectorId, deviceId, startedAt, endedAt, status, serverSessionId
        case deviceModel, systemVersion, sensorCapabilities, sampleCounts, strideCalibration
    }

    // Manual Decodable so metadata.json files written before `strideCalibration` existed still
    // decode (missing key -> nil) instead of throwing and dropping the whole persisted session.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        collectorId = try container.decode(String.self, forKey: .collectorId)
        deviceId = try container.decode(UUID.self, forKey: .deviceId)
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        endedAt = try container.decodeIfPresent(Date.self, forKey: .endedAt)
        status = try container.decode(CollectionStatus.self, forKey: .status)
        serverSessionId = try container.decodeIfPresent(String.self, forKey: .serverSessionId)
        deviceModel = try container.decode(String.self, forKey: .deviceModel)
        systemVersion = try container.decode(String.self, forKey: .systemVersion)
        sensorCapabilities = try container.decode(SensorCapabilities.self, forKey: .sensorCapabilities)
        sampleCounts = try container.decode(SampleCounts.self, forKey: .sampleCounts)
        strideCalibration = try container.decodeIfPresent(StrideCalibration.self, forKey: .strideCalibration)
    }
}

struct LocationSample: Codable {
    let id: UUID
    let sessionId: UUID
    let sequence: Int
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
    let appState: CollectorAppState
    let sensorSegmentId: String
}

struct MotionSample: Codable {
    let id: UUID
    let sessionId: UUID
    let sequence: Int
    let timestamp: Date
    let userAccelerationX: Double
    let userAccelerationY: Double
    let userAccelerationZ: Double
    let rotationRateX: Double
    let rotationRateY: Double
    let rotationRateZ: Double
    let gravityX: Double
    let gravityY: Double
    let gravityZ: Double
    let attitudeRoll: Double
    let attitudePitch: Double
    let attitudeYaw: Double
    let appState: CollectorAppState
    let sensorSegmentId: String
}

struct AltimeterSample: Codable {
    let id: UUID
    let sessionId: UUID
    let sequence: Int
    let timestamp: Date
    let relativeAltitude: Double
    let pressure: Double
    let appState: CollectorAppState
    let sensorSegmentId: String
}

enum SensorCaptureSource: String, Codable {
    case live = "LIVE"
    case historicalRecovery = "HISTORICAL_RECOVERY"
}

struct PedometerSample: Codable {
    let id: UUID
    let sessionId: UUID
    let sequence: Int
    let timestamp: Date
    let captureSource: SensorCaptureSource
    let numberOfSteps: Int?
    let distance: Double?
    let currentPace: Double?
    let currentCadence: Double?
    let floorsAscended: Int?
    let floorsDescended: Int?
    let appState: CollectorAppState
    let sensorSegmentId: String
}

enum EventMarkerType: String, Codable, CaseIterable, Identifiable {
    case entrance, intersection, stairStart, stairEnd, rampStart, rampEnd, elevator, stop, custom
    var id: String { rawValue }
    var title: String {
        switch self {
        case .entrance: return "Entrance"
        case .intersection: return "Intersection"
        case .stairStart: return "Stair Start"
        case .stairEnd: return "Stair End"
        case .rampStart: return "Ramp Start"
        case .rampEnd: return "Ramp End"
        case .elevator: return "Elevator"
        case .stop: return "Stop"
        case .custom: return "Custom"
        }
    }
}

struct EventMarker: Codable {
    let id: UUID
    let sessionId: UUID
    let timestamp: Date
    let type: EventMarkerType
    let note: String?
    let latitude: Double?
    let longitude: Double?
    let altitude: Double?
    let horizontalAccuracy: Double?
    let verticalAccuracy: Double?
}

enum MotionSamplingRate: Int, Codable, CaseIterable, Identifiable {
    case hz10 = 10, hz20 = 20, hz50 = 50
    var id: Int { rawValue }
    var interval: TimeInterval { 1.0 / Double(rawValue) }
    var label: String { "\(rawValue) Hz" }
}

enum LocationCollectionProfile: String, Codable, CaseIterable, Identifiable {
    case highAccuracy, balanced, batterySaving
    var id: String { rawValue }
    var title: String {
        switch self {
        case .highAccuracy: return "High Accuracy Collection"
        case .balanced: return "Balanced Collection"
        case .batterySaving: return "Battery Saving"
        }
    }
    var desiredAccuracy: CLLocationAccuracy {
        switch self {
        case .highAccuracy: return kCLLocationAccuracyBest
        case .balanced: return kCLLocationAccuracyNearestTenMeters
        case .batterySaving: return kCLLocationAccuracyHundredMeters
        }
    }
}
