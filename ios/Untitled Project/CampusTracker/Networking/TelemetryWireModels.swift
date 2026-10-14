import Foundation

// Server WebSocket contract models. Field names are a network contract and must not change.
// Local-only capture metadata lives in `RawSampleEnvelope`, never in these types.

nonisolated struct WebSocketRequest<Payload: Encodable>: Encodable {
    let requestId: String
    let type: String
    let payload: Payload
}

nonisolated extension Double {
    /// JSONEncoder rejects NaN and infinity. Raw local samples remain untouched; only network DTOs are normalized.
    var finiteOrNil: Double? { isFinite ? self : nil }
}

nonisolated struct WebSocketAck: Decodable {
    let requestId: String
    let ok: Bool
}

nonisolated struct SessionStartPayload: Codable, Sendable {
    let clientSessionId: String
    let deviceId: String
    var platform = "ios"
    let deviceModel: String
    let systemVersion: String
    let appVersion: String
    let sensorCapabilities: SensorCapabilities
    let startedAt: Date
    // Top-level per the server contract (docs/HEALTH_STRIDE_SERVER_PLAN.md), not nested under
    // sensorCapabilities. Omitted (nil) when no fresh candidate was ready at session start.
    let strideCalibration: StrideCalibration?
}

nonisolated struct SessionStartResponse: Decodable {
    let sessionId: String
    let supportedTelemetryFeatures: [String]?
    // Decoded as plain strings (see StrideCalibrationAck) so a future status/reason value this
    // build doesn't know about still decodes instead of failing the whole ACK. Absent on old
    // servers, which is also just `nil` here, not an error.
    let strideCalibration: StrideCalibrationAck?
}

nonisolated struct SyncCompleteResponse: Decodable {
    let synchronized: Bool
}

nonisolated struct AxisPayload: Codable, Sendable {
    let x: Double?
    let y: Double?
    let z: Double?
}

nonisolated struct Vector3Payload: Codable, Sendable {
    let x: Double
    let y: Double
    let z: Double
}

nonisolated struct QuaternionPayload: Codable, Sendable {
    let x: Double
    let y: Double
    let z: Double
    let w: Double
}

/// Matches the server's `ArkitPose` zod schema (`arkit.dto.ts`) exactly — that schema is
/// `.strict()`, so no extra fields (not even a `clientSessionId`) may appear here. The owning
/// client session is the upload ledger row's `session_id` column instead.
nonisolated struct ArkitPoseWire: Codable, Sendable {
    var type = "arkit.pose"
    var schemaVersion = 1
    var sessionId: String
    let arSessionId: String
    let deviceId: String
    let sequence: Int
    let timestamp: Int64
    let frameTimestamp: Double
    let position: Vector3Payload
    let rotation: QuaternionPayload
    let trackingState: String

    var itemID: String { "\(arSessionId)-\(sequence)" }
}

nonisolated struct LocationPayload: Codable, Sendable {
    let sequence: Int
    let timestamp: Date
    let latitude: Double?
    let longitude: Double?
    let altitude: Double?
    let ellipsoidalAltitude: Double?
    let horizontalAccuracy: Double?
    let verticalAccuracy: Double?
    let speed: Double?
    let course: Double?
    let speedAccuracy: Double?
    let courseAccuracy: Double?
    let floor: Int?
    let appState: String
    let sensorSegmentId: String

    init(_ sample: LocationSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        latitude = sample.latitude.finiteOrNil
        longitude = sample.longitude.finiteOrNil
        altitude = sample.altitude.finiteOrNil
        ellipsoidalAltitude = sample.ellipsoidalAltitude?.finiteOrNil
        horizontalAccuracy = sample.horizontalAccuracy.finiteOrNil
        verticalAccuracy = sample.verticalAccuracy.finiteOrNil
        speed = sample.speed.finiteOrNil
        course = sample.course.finiteOrNil
        speedAccuracy = sample.speedAccuracy.finiteOrNil
        courseAccuracy = sample.courseAccuracy.finiteOrNil
        floor = sample.floor
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated struct MotionPayload: Codable, Sendable {
    let sequence: Int
    let timestamp: Date
    let userAcceleration: AxisPayload
    let rotationRate: AxisPayload
    let gravity: AxisPayload
    let attitude: AttitudePayload
    let appState: String
    let sensorSegmentId: String

    struct AttitudePayload: Codable, Sendable {
        let roll: Double?
        let pitch: Double?
        let yaw: Double?
    }

    init(_ sample: MotionSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        userAcceleration = AxisPayload(x: sample.userAccelerationX.finiteOrNil, y: sample.userAccelerationY.finiteOrNil, z: sample.userAccelerationZ.finiteOrNil)
        rotationRate = AxisPayload(x: sample.rotationRateX.finiteOrNil, y: sample.rotationRateY.finiteOrNil, z: sample.rotationRateZ.finiteOrNil)
        gravity = AxisPayload(x: sample.gravityX.finiteOrNil, y: sample.gravityY.finiteOrNil, z: sample.gravityZ.finiteOrNil)
        attitude = AttitudePayload(roll: sample.attitudeRoll.finiteOrNil, pitch: sample.attitudePitch.finiteOrNil, yaw: sample.attitudeYaw.finiteOrNil)
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated struct AltimeterPayload: Codable, Sendable {
    let sequence: Int
    let timestamp: Date
    let relativeAltitude: Double?
    let pressure: Double?
    let appState: String
    let sensorSegmentId: String

    init(_ sample: AltimeterSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        relativeAltitude = sample.relativeAltitude.finiteOrNil
        pressure = sample.pressure.finiteOrNil
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated struct AbsoluteAltitudePayload: Codable, Sendable {
    let sequence: Int
    let timestamp: Date
    let altitude: Double?
    let accuracy: Double?
    let precision: Double?
    let verticalReference: String
    let sensorSegmentId: String
    let captureSource: String
    let appState: String
    let invalidReason: String?

    init(_ sample: AbsoluteAltitudeSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        altitude = sample.altitude?.finiteOrNil
        accuracy = sample.accuracy?.finiteOrNil
        precision = sample.precision?.finiteOrNil
        verticalReference = sample.verticalReference
        sensorSegmentId = sample.sensorSegmentId
        captureSource = sample.captureSource.rawValue
        appState = sample.appState.rawValue.uppercased()
        invalidReason = sample.invalidReason
    }
}

nonisolated struct PedometerPayload: Codable, Sendable {
    let sequence: Int
    let timestamp: Date
    let captureSource: String
    let numberOfSteps: Int?
    let distance: Double?
    let currentPace: Double?
    let currentCadence: Double?
    let floorsAscended: Int?
    let floorsDescended: Int?
    let appState: String
    let sensorSegmentId: String

    init(_ sample: PedometerSample) {
        sequence = sample.sequence
        timestamp = sample.timestamp
        captureSource = sample.captureSource.rawValue
        numberOfSteps = sample.numberOfSteps
        distance = sample.distance?.finiteOrNil
        currentPace = sample.currentPace?.finiteOrNil
        currentCadence = sample.currentCadence?.finiteOrNil
        floorsAscended = sample.floorsAscended
        floorsDescended = sample.floorsDescended
        appState = sample.appState.rawValue.uppercased()
        sensorSegmentId = sample.sensorSegmentId
    }
}

nonisolated struct TelemetryBatchPayload: Codable, Identifiable, Sendable {
    let batchId: String
    var sessionId: String?
    let clientSessionId: String
    let createdAt: Date
    let locations: [LocationPayload]
    let motion: [MotionPayload]
    let altimeter: [AltimeterPayload]
    let absoluteAltitude: [AbsoluteAltitudePayload]?
    let pedometer: [PedometerPayload]

    var id: String { batchId }
    var sampleCount: Int { locations.count + motion.count + altimeter.count + (absoluteAltitude?.count ?? 0) + pedometer.count }

    init(batchId: String, sessionId: String?, clientSessionId: String, createdAt: Date,
         locations: [LocationPayload], motion: [MotionPayload], altimeter: [AltimeterPayload],
         pedometer: [PedometerPayload]) {
        self.init(batchId: batchId, sessionId: sessionId, clientSessionId: clientSessionId,
                  createdAt: createdAt, locations: locations, motion: motion, altimeter: altimeter,
                  absoluteAltitude: nil, pedometer: pedometer)
    }

    init(batchId: String, sessionId: String?, clientSessionId: String, createdAt: Date,
         locations: [LocationPayload], motion: [MotionPayload], altimeter: [AltimeterPayload],
         absoluteAltitude: [AbsoluteAltitudePayload]?, pedometer: [PedometerPayload]) {
        self.batchId = batchId; self.sessionId = sessionId; self.clientSessionId = clientSessionId
        self.createdAt = createdAt; self.locations = locations; self.motion = motion
        self.altimeter = altimeter; self.absoluteAltitude = absoluteAltitude; self.pedometer = pedometer
    }
}

nonisolated struct MarkerPayload: Codable, Identifiable, Sendable {
    let markerId: String
    var sessionId: String?
    let clientSessionId: String
    let timestamp: Date
    let type: String
    let note: String?
    let latitude: Double?
    let longitude: Double?
    let altitude: Double?
    var ellipsoidalAltitude: Double? = nil
    let horizontalAccuracy: Double?
    let verticalAccuracy: Double?

    var id: String { markerId }

    init(marker: EventMarker) {
        markerId = marker.id.uuidString
        sessionId = nil
        clientSessionId = marker.sessionId.uuidString
        timestamp = marker.timestamp
        type = marker.type.rawValue
        note = marker.note
        latitude = marker.latitude?.finiteOrNil
        longitude = marker.longitude?.finiteOrNil
        altitude = marker.altitude?.finiteOrNil
        horizontalAccuracy = marker.horizontalAccuracy?.finiteOrNil
        verticalAccuracy = marker.verticalAccuracy?.finiteOrNil
    }
}

nonisolated struct LastSequencesPayload: Codable, Equatable, Sendable {
    let location: Int
    let motion: Int
    let altimeter: Int
    let pedometer: Int
    var absoluteAltitude: Int? = nil

    init(location: Int, motion: Int, altimeter: Int, pedometer: Int) {
        self.init(location: location, motion: motion, altimeter: altimeter,
                  pedometer: pedometer, absoluteAltitude: nil)
    }

    init(location: Int, motion: Int, altimeter: Int, pedometer: Int, absoluteAltitude: Int?) {
        self.location = location; self.motion = motion; self.altimeter = altimeter
        self.pedometer = pedometer; self.absoluteAltitude = absoluteAltitude
    }
}

nonisolated struct FinishPayload: Codable, Identifiable, Sendable {
    let clientSessionId: String
    var sessionId: String?
    let endedAt: Date
    // Optional so a queue file persisted before this field existed still decodes instead of
    // throwing and silently dropping every queued upload (session starts, batches, markers).
    let lastSequences: LastSequencesPayload?
    let interrupted: Bool?

    var id: String { clientSessionId }
}

nonisolated struct SyncCompletePayload: Codable, Sendable {
    let clientSessionId: String
    let sessionId: String?
    let lastSequences: LastSequencesPayload
}

nonisolated struct DiagnosticEventItem: Codable, Sendable {
    let eventId: String
    let eventType: String
    let clientTimestamp: Date
    let metadata: [String: String]
}

nonisolated struct DiagnosticEventPayload: Codable, Sendable {
    let clientSessionId: String
    let events: [DiagnosticEventItem]
}

nonisolated struct CollectorStatusPayload: Codable, Sendable {
    let sessionId: String
    let collecting: Bool
    let locationSampleCount: Int
    let motionSampleCount: Int
    let pendingBatchCount: Int
}

/// Which collector + which server a queued session belongs to. Captured once per session at
/// `session:start` time and compared against the *live* current owner before every send: if the
/// app logs into a different collector or points at a different server, data recorded under the
/// old owner is held (never silently uploaded to the new one) until that owner is current again.
nonisolated struct UploadOwner: Codable, Equatable, Hashable, Sendable {
    let collectorId: String
    let serverKey: String
}

/// A JSON value that can be stored and re-encoded without losing structure (used for the
/// server's free-form `error.details`).
nonisolated enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

/// Server ACK error detail (`{ code, message, status, retryable, details }`), preserved instead of
/// collapsing every failure to a single Bool — `retryable` and `code` decide retry vs. quarantine.
nonisolated struct AckError: Codable, Equatable, Sendable {
    let code: String?
    let message: String?
    let status: Int?
    let retryable: Bool?
    var details: JSONValue? = nil
}

/// Upload ledger item kinds. `kind` is part of the unique key so start/finish items that share a
/// client session id never collide.
nonisolated enum UploadKind: String, Codable, CaseIterable, Sendable {
    case telemetry
    case marker
    case arkit
    case diagnostic
    case finish

    var messageType: String {
        switch self {
        case .telemetry: return "telemetry:batch"
        case .marker: return "marker:create"
        case .arkit: return "arkit:pose"
        case .diagnostic: return "diagnostic:event"
        case .finish: return "session:finish"
        }
    }
}

nonisolated enum TelemetryWireEncoding {
    enum EncodingFailure: Error { case utf8 }

    /// Builds the exact request text for one ledger item. The stored payload never contains the
    /// server session id (it can change after a re-handshake); it is injected here, at send time.
    static func requestText(kind: UploadKind, payload: Data, serverSessionId: String,
                            clientSessionId: String, requestId: String) throws -> String {
        let decoder = TrackingJSONCodec.makeDecoder()
        let encoder = TrackingJSONCodec.makeEncoder()
        let data: Data
        switch kind {
        case .telemetry:
            var value = try decoder.decode(TelemetryBatchPayload.self, from: payload)
            value.sessionId = serverSessionId
            data = try encoder.encode(WebSocketRequest(requestId: requestId, type: kind.messageType, payload: value))
        case .marker:
            var value = try decoder.decode(MarkerPayload.self, from: payload)
            value.sessionId = serverSessionId
            data = try encoder.encode(WebSocketRequest(requestId: requestId, type: kind.messageType, payload: value))
        case .arkit:
            var value = try decoder.decode(ArkitPoseWire.self, from: payload)
            value.sessionId = serverSessionId
            data = try encoder.encode(WebSocketRequest(requestId: requestId, type: kind.messageType, payload: value))
        case .diagnostic:
            let value = try decoder.decode(DiagnosticEventItem.self, from: payload)
            data = try encoder.encode(WebSocketRequest(requestId: requestId, type: kind.messageType,
                payload: DiagnosticEventPayload(clientSessionId: clientSessionId, events: [value])))
        case .finish:
            var value = try decoder.decode(FinishPayload.self, from: payload)
            value.sessionId = serverSessionId
            data = try encoder.encode(WebSocketRequest(requestId: requestId, type: kind.messageType, payload: value))
        }
        guard let text = String(data: data, encoding: .utf8) else { throw EncodingFailure.utf8 }
        return text
    }

    static func requestText<Payload: Encodable>(type: String, payload: Payload, requestId: String) throws -> String {
        let data = try TrackingJSONCodec.makeEncoder().encode(WebSocketRequest(requestId: requestId, type: type, payload: payload))
        guard let text = String(data: data, encoding: .utf8) else { throw EncodingFailure.utf8 }
        return text
    }
}
