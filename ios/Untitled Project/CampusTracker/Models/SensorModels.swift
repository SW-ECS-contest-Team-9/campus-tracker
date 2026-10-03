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
