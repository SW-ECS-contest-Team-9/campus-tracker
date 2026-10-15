import Foundation
import CoreLocation

nonisolated struct SensorCapabilities: Codable, Sendable {
    let locationAvailable: Bool
    let deviceMotionAvailable: Bool
    let altimeterAvailable: Bool
    var absoluteAltitudeAvailable: Bool? = nil
    var absoluteAltitudeEnabled: Bool? = nil
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
    /// Actually-applied location request settings (always BestForNavigation / no distance filter
    /// during collection — see `LocationService.start`), recorded here so the server can confirm
    /// every session used the same request regardless of what `locationRequestedProfile` asked for.
    var locationDesiredAccuracy: String?
    var locationDistanceFilterMeters: Double?
    var locationActivityType: String?
    /// The profile the user picked, which no longer affects `locationDesiredAccuracy` above —
    /// kept only so a session can still show what was selected in the (now informational) UI.
    var locationRequestedProfile: String?
    var arkitEnabled: Bool?
    var walkingFrameEnabled: Bool? = nil
    var walkingFrameAlgorithmVersion: String? = nil
    var walkingFrameSchemaVersion: Int? = nil
    var walkingFrameWindowSeconds: Double? = nil
    var walkingFrameUpdateIntervalSeconds: Double? = nil

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

nonisolated struct DeviceInfo: Codable, Sendable {
    let deviceId: UUID
    let deviceModel: String
    let systemName: String
    let systemVersion: String
    let appVersion: String
    let sensorCapabilities: SensorCapabilities
}

nonisolated enum CollectionStatus: String, Codable, Sendable {
    case recording
    case completed
}

nonisolated struct SampleCounts: Codable, Equatable, Sendable {
    var location = 0
    var motion = 0
    var altimeter = 0
    var absoluteAltitude = 0
    var pedometer = 0
    var marker = 0

    enum CodingKeys: String, CodingKey { case location, motion, altimeter, absoluteAltitude, pedometer, marker }

    init(location: Int = 0, motion: Int = 0, altimeter: Int = 0, absoluteAltitude: Int = 0,
         pedometer: Int = 0, marker: Int = 0) {
        self.location = location; self.motion = motion; self.altimeter = altimeter
        self.absoluteAltitude = absoluteAltitude; self.pedometer = pedometer; self.marker = marker
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(location: try c.decodeIfPresent(Int.self, forKey: .location) ?? 0,
                  motion: try c.decodeIfPresent(Int.self, forKey: .motion) ?? 0,
                  altimeter: try c.decodeIfPresent(Int.self, forKey: .altimeter) ?? 0,
                  absoluteAltitude: try c.decodeIfPresent(Int.self, forKey: .absoluteAltitude) ?? 0,
                  pedometer: try c.decodeIfPresent(Int.self, forKey: .pedometer) ?? 0,
                  marker: try c.decodeIfPresent(Int.self, forKey: .marker) ?? 0)
    }
}

nonisolated struct CollectionSession: Codable, Identifiable, Sendable {
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

nonisolated struct LocationSample: Codable, Sendable {
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

nonisolated struct MotionSample: Codable, Sendable {
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
    let attitudeQuaternion: QuaternionD?
    let magneticField: CalibratedMagneticFieldSample?
    /// Present only when the estimator produced a new snapshot at this sample timestamp. It is not
    /// repeated on intervening 50 Hz samples as if each were an independent observation.
    let walkingFrame: WalkingFrameSnapshot?
    let appState: CollectorAppState
    let sensorSegmentId: String

    init(id: UUID, sessionId: UUID, sequence: Int, timestamp: Date,
         userAccelerationX: Double, userAccelerationY: Double, userAccelerationZ: Double,
         rotationRateX: Double, rotationRateY: Double, rotationRateZ: Double,
         gravityX: Double, gravityY: Double, gravityZ: Double,
         attitudeRoll: Double, attitudePitch: Double, attitudeYaw: Double,
         attitudeQuaternion: QuaternionD? = nil,
         magneticField: CalibratedMagneticFieldSample? = nil,
         walkingFrame: WalkingFrameSnapshot? = nil,
         appState: CollectorAppState, sensorSegmentId: String) {
        self.id = id; self.sessionId = sessionId; self.sequence = sequence; self.timestamp = timestamp
        self.userAccelerationX = userAccelerationX; self.userAccelerationY = userAccelerationY; self.userAccelerationZ = userAccelerationZ
        self.rotationRateX = rotationRateX; self.rotationRateY = rotationRateY; self.rotationRateZ = rotationRateZ
        self.gravityX = gravityX; self.gravityY = gravityY; self.gravityZ = gravityZ
        self.attitudeRoll = attitudeRoll; self.attitudePitch = attitudePitch; self.attitudeYaw = attitudeYaw
        self.attitudeQuaternion = attitudeQuaternion; self.magneticField = magneticField; self.walkingFrame = walkingFrame
        self.appState = appState; self.sensorSegmentId = sensorSegmentId
    }

    enum CodingKeys: String, CodingKey {
        case id, sessionId, sequence, timestamp, userAccelerationX, userAccelerationY, userAccelerationZ
        case rotationRateX, rotationRateY, rotationRateZ, gravityX, gravityY, gravityZ
        case attitudeRoll, attitudePitch, attitudeYaw, attitudeQuaternion, magneticField, walkingFrame
        case appState, sensorSegmentId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id); sessionId = try c.decode(UUID.self, forKey: .sessionId)
        sequence = try c.decode(Int.self, forKey: .sequence); timestamp = try c.decode(Date.self, forKey: .timestamp)
        userAccelerationX = try c.decode(Double.self, forKey: .userAccelerationX)
        userAccelerationY = try c.decode(Double.self, forKey: .userAccelerationY)
        userAccelerationZ = try c.decode(Double.self, forKey: .userAccelerationZ)
        rotationRateX = try c.decode(Double.self, forKey: .rotationRateX)
        rotationRateY = try c.decode(Double.self, forKey: .rotationRateY)
        rotationRateZ = try c.decode(Double.self, forKey: .rotationRateZ)
        gravityX = try c.decode(Double.self, forKey: .gravityX); gravityY = try c.decode(Double.self, forKey: .gravityY); gravityZ = try c.decode(Double.self, forKey: .gravityZ)
        attitudeRoll = try c.decode(Double.self, forKey: .attitudeRoll); attitudePitch = try c.decode(Double.self, forKey: .attitudePitch); attitudeYaw = try c.decode(Double.self, forKey: .attitudeYaw)
        attitudeQuaternion = try c.decodeIfPresent(QuaternionD.self, forKey: .attitudeQuaternion)
        magneticField = try c.decodeIfPresent(CalibratedMagneticFieldSample.self, forKey: .magneticField)
        walkingFrame = try c.decodeIfPresent(WalkingFrameSnapshot.self, forKey: .walkingFrame)
        appState = try c.decode(CollectorAppState.self, forKey: .appState)
        sensorSegmentId = try c.decode(String.self, forKey: .sensorSegmentId)
    }
}

nonisolated struct AltimeterSample: Codable, Sendable {
    let id: UUID
    let sessionId: UUID
    let sequence: Int
    let timestamp: Date
    let relativeAltitude: Double
    let pressure: Double
    let appState: CollectorAppState
    let sensorSegmentId: String
}

nonisolated struct AbsoluteAltitudeSample: Codable, Sendable {
    let id: UUID
    let sessionId: UUID
    let sequence: Int
    let timestamp: Date
    let altitude: Double?
    let accuracy: Double?
    let precision: Double?
    let verticalReference: String
    let sensorSegmentId: String
    let captureSource: SensorCaptureSource
    let appState: CollectorAppState
    let invalidReason: String?
}

nonisolated enum SensorCaptureSource: String, Codable, Sendable {
    case live = "LIVE"
    case historicalRecovery = "HISTORICAL_RECOVERY"
}

nonisolated struct PedometerSample: Codable, Sendable {
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

nonisolated enum EventMarkerType: String, Codable, CaseIterable, Identifiable, Sendable {
    // `elevator` stays decodable for markers recorded by older builds; new ones use board/exit.
    case entrance, intersection, stairStart, stairEnd, rampStart, rampEnd, elevatorBoard, elevatorExit, stop, custom
    case elevator, sessionStart, sessionEnd
    var id: String { rawValue }
    var title: String {
        switch self {
        case .entrance: return "Entrance"
        case .intersection: return "Intersection"
        case .stairStart: return "Stair Start"
        case .stairEnd: return "Stair End"
        case .rampStart: return "Ramp Start"
        case .rampEnd: return "Ramp End"
        case .elevatorBoard: return "Elevator Board"
        case .elevatorExit: return "Elevator Exit"
        case .elevator: return "Elevator"
        case .stop: return "Stop"
        case .custom: return "Custom"
        case .sessionStart: return "Start"
        case .sessionEnd: return "End"
        }
    }
    /// The marker buttons; Start/Stop record sessionStart/sessionEnd themselves.
    static var buttons: [EventMarkerType] {
        [.entrance, .intersection, .stairStart, .stairEnd, .rampStart, .rampEnd, .elevatorBoard, .elevatorExit, .stop, .custom]
    }
}

/// Where the collector really was when a marker was pressed (server `markers/marker-anchor.ts`):
/// ground truth for the location-correction training and a height fix point for fusion.
nonisolated struct CollectionAnchor: Codable, Equatable, Sendable {
    static let outdoor = "outdoor"
    var nodeId: String? = nil
    /// campus building id, or `CollectionAnchor.outdoor`
    var buildingId: String? = nil
    var floor: String? = nil
    /// stairs and ramps: "up" / "down"
    var direction: String? = nil
    var fromFloor: String? = nil
    var toFloor: String? = nil
    /// shown in the picker only
    var nodeLabel: String? = nil
}

nonisolated enum AnchorNeeds: Sendable { case none, place, stairs, elevator, ramp }

nonisolated enum AnchorRules {
    /// B6 … B1, 1F … 15F (no 0F), the server's floor-name rule.
    static let floors: [String] = (1...6).reversed().map { "B\($0)" } + (1...15).map { "\($0)F" }
    static let verticalReminderMeters = 3.0

    static func isFloor(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.range(of: "^(B[1-9]|[1-9][0-9]?F)$", options: .regularExpression) != nil
    }

    static func floorNumber(_ name: String?) -> Int? {
        guard isFloor(name), let name else { return nil }
        if name.hasPrefix("B") { return Int(name.dropFirst()).map { -$0 } }
        return Int(name.dropLast())
    }

    static func direction(from: String?, to: String?) -> String? {
        guard let a = floorNumber(from), let b = floorNumber(to), a != b else { return nil }
        return b > a ? "up" : "down"
    }

    static func needs(_ type: EventMarkerType) -> AnchorNeeds {
        switch type {
        case .sessionStart, .sessionEnd, .entrance: return .place
        case .stairStart, .stairEnd: return .stairs
        case .elevatorBoard, .elevatorExit: return .elevator
        case .rampStart, .rampEnd: return .ramp
        default: return .none
        }
    }

    /// A place needs building + floor and a node when that floor has any (a floor without indoor
    /// nodes takes building + floor only); outside always a node; an entrance is on a building floor.
    static func isComplete(_ type: EventMarkerType, _ a: CollectionAnchor, nodesOnOffer: Bool) -> Bool {
        let directed = a.direction == "up" || a.direction == "down"
        switch needs(type) {
        case .none: return true
        case .place:
            guard let building = a.buildingId else { return false }
            if building == CollectionAnchor.outdoor { return type != .entrance && a.nodeId != nil }
            guard isFloor(a.floor) else { return false }
            return a.nodeId != nil || !nodesOnOffer
        case .stairs: return directed && isFloor(a.fromFloor) && isFloor(a.toFloor)
        case .elevator: return isFloor(a.fromFloor) && isFloor(a.toFloor)
        case .ramp: return directed
        }
    }
}

nonisolated struct EventMarker: Codable, Sendable {
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
    /// collection anchor; absent in markers recorded by older builds
    var anchor: CollectionAnchor? = nil
}

nonisolated enum MotionSamplingRate: Int, Codable, CaseIterable, Identifiable, Sendable {
    case hz10 = 10, hz20 = 20, hz50 = 50
    var id: Int { rawValue }
    var interval: TimeInterval { 1.0 / Double(rawValue) }
    var label: String { "\(rawValue) Hz" }
}

nonisolated enum LocationCollectionProfile: String, Codable, CaseIterable, Identifiable, Sendable {
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
