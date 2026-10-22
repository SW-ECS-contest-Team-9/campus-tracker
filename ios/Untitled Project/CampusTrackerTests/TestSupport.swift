import Foundation
import Testing
@testable import CampusTracker

// MARK: - Mock transport

/// Drives `TelemetryUploadEngine` without a real network connection: captures every outbound
/// message and lets a test manufacture ACKs (or simulate connect/disconnect) on demand.
@MainActor
final class MockCollectorSocket: CollectorSocket {
    struct Sent {
        let requestId: String
        let type: String
        let payload: [String: Any]
    }

    var state: WebSocketConnectionState = .disconnected
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onTextMessage: ((String) -> Void)?
    private(set) var sent: [Sent] = []

    func send(text: String, completion: @escaping (Error?) -> Void) {
        completion(nil)
        guard let data = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let requestId = object["requestId"] as? String,
              let type = object["type"] as? String else { return }
        sent.append(Sent(requestId: requestId, type: type, payload: object["payload"] as? [String: Any] ?? [:]))
    }

    func connect() {
        state = .connected
        onConnected?()
    }

    func disconnect() {
        state = .disconnected
        onDisconnected?()
    }

    func count(_ type: String) -> Int { sent.filter { $0.type == type }.count }

    /// ACKs the most recent message of `type` (exactly one request is ever in flight).
    func ack(type: String, ok: Bool, data: Any? = nil, error: [String: Any]? = nil) {
        guard let message = sent.last(where: { $0.type == type }) else { return }
        ack(requestId: message.requestId, ok: ok, data: data, error: error)
    }

    func ack(requestId: String, ok: Bool, data: Any? = nil, error: [String: Any]? = nil) {
        var object: [String: Any] = ["type": "ack", "requestId": requestId, "ok": ok]
        if let data { object["data"] = data }
        if let error { object["error"] = error }
        guard let json = try? JSONSerialization.data(withJSONObject: object), let text = String(data: json, encoding: .utf8) else { return }
        onTextMessage?(text)
    }
}

// MARK: - Failure injection

nonisolated final class StoreFailureSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: [StoreFailurePoint: Int] = [:]
    private var hits: [StoreFailurePoint: Int] = [:]

    func fail(_ point: StoreFailurePoint, times: Int = 1) {
        lock.lock(); defer { lock.unlock() }
        remaining[point] = times
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        remaining.removeAll()
    }

    func hitCount(_ point: StoreFailurePoint) -> Int {
        lock.lock(); defer { lock.unlock() }
        return hits[point] ?? 0
    }

    var injector: @Sendable (StoreFailurePoint) throws -> Void {
        { [self] point in
            lock.lock(); defer { lock.unlock() }
            hits[point, default: 0] += 1
            guard let count = remaining[point], count > 0 else { return }
            remaining[point] = count - 1
            throw CollectionStoreError.injected(String(describing: point))
        }
    }
}

/// Collects core events delivered on the core queue.
nonisolated final class CoreEventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [CollectionCoreEvent] = []

    var handler: @Sendable (CollectionCoreEvent) -> Void {
        { [self] event in
            lock.lock(); defer { lock.unlock() }
            events.append(event)
        }
    }

    var all: [CollectionCoreEvent] {
        lock.lock(); defer { lock.unlock() }
        return events
    }

    var storageFailures: [String] {
        all.compactMap { if case let .storageFailure(_, code, _) = $0 { return code } else { return nil } }
    }

    var diagnostics: [String] {
        all.compactMap { if case let .diagnostic(_, type, _) = $0 { return type } else { return nil } }
    }

    var committedItems: [UploadItemRecord] {
        all.flatMap { event -> [UploadItemRecord] in
            if case let .uploadItemsCommitted(items) = event { return items } else { return [] }
        }
    }

    var arkitPaused: Bool {
        all.contains { if case .arkitBackpressurePaused = $0 { return true } else { return false } }
    }
}

// MARK: - Fixtures

nonisolated enum TestFixture {
    static let capabilities = SensorCapabilities(
        locationAvailable: true, deviceMotionAvailable: true, altimeterAvailable: true,
        stepCountingAvailable: true, distanceAvailable: false, floorCountingAvailable: false,
        paceAvailable: false, cadenceAvailable: false
    )

    static let noSensors = SensorCapabilities(
        locationAvailable: false, deviceMotionAvailable: false, altimeterAvailable: false,
        stepCountingAvailable: false, distanceAvailable: false, floorCountingAvailable: false,
        paceAvailable: false, cadenceAvailable: false
    )

    static let owner = UploadOwner(collectorId: "C01", serverKey: "http://test:3000")

    static func tempDirectory(_ name: String = "Test") -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func session(id: UUID = UUID(), collectorId: String = "C01",
                        startedAt: Date = Date(timeIntervalSince1970: 1_700_000_000)) -> CollectionSession {
        CollectionSession(id: id, collectorId: collectorId, deviceId: UUID(), startedAt: startedAt,
                          status: .recording, deviceModel: "iPhone15,2", systemVersion: "18.0",
                          sensorCapabilities: capabilities, sampleCounts: SampleCounts())
    }

    static func snapshot(_ session: CollectionSession, motionRate: MotionSamplingRate = .hz50) -> ActiveCollectionState {
        ActiveCollectionState(session: session, motionRate: motionRate, locationProfile: .highAccuracy,
                              distanceFilter: 0, locationSequence: 0, motionSequence: 0, altimeterSequence: 0,
                              pedometerSequence: 0, lastPersistedAt: session.startedAt,
                              diagnostics: CollectionDiagnostics())
    }

    static func startPayload(_ session: CollectionSession) -> Data {
        let payload = SessionStartPayload(clientSessionId: session.id.uuidString, deviceId: session.deviceId.uuidString,
                                          deviceModel: session.deviceModel, systemVersion: session.systemVersion,
                                          appVersion: "1.0", sensorCapabilities: session.sensorCapabilities,
                                          startedAt: session.startedAt, strideCalibration: nil)
        return try! TrackingJSONCodec.makeEncoder().encode(payload)
    }

    /// Creates the session row the way `CollectionCore.beginSession` does.
    static func seed(_ store: CollectionStore, session: CollectionSession, owner: UploadOwner = owner) throws {
        try store.sync {
            try $0.createSession(snapshot: snapshot(session), owner: owner, startPayload: startPayload(session),
                                 streams: CaptureStream.allCases.map(\.rawValue) + ["marker"])
        }
    }

    static func markerDraft(session: CollectionSession) -> UploadItemDraft {
        let marker = EventMarker(id: UUID(), sessionId: session.id, timestamp: Date(), type: .entrance, note: nil,
                                 latitude: nil, longitude: nil, altitude: nil, horizontalAccuracy: nil, verticalAccuracy: nil)
        return UploadItemDraft(kind: .marker, itemID: marker.id.uuidString,
                               payload: try! TrackingJSONCodec.makeEncoder().encode(MarkerPayload(marker: marker)))
    }

    static func diagnosticDraft(type: String) -> UploadItemDraft {
        let event = DiagnosticEventItem(eventId: UUID().uuidString, eventType: type, clientTimestamp: Date(), metadata: [:])
        return UploadItemDraft(kind: .diagnostic, itemID: event.eventId, payload: try! TrackingJSONCodec.makeEncoder().encode(event))
    }

    static func telemetryDraft(session: CollectionSession) -> UploadItemDraft {
        let id = UUID().uuidString
        let batch = try! RawSampleDecoding.telemetryBatch(batchID: id, clientSessionID: session.id.uuidString, rows: [], createdAt: Date())
        return UploadItemDraft(kind: .telemetry, itemID: id, payload: try! TrackingJSONCodec.makeEncoder().encode(batch))
    }

    static func arkitDraft(session: CollectionSession, sequence: Int) -> UploadItemDraft {
        let wire = ArkitPoseWire(sessionId: "", arSessionId: UUID().uuidString, deviceId: session.deviceId.uuidString,
                                 sequence: sequence, timestamp: 1, frameTimestamp: 1,
                                 position: Vector3Payload(x: 0, y: 0, z: 0),
                                 rotation: QuaternionPayload(x: 0, y: 0, z: 0, w: 1), trackingState: "normal")
        return UploadItemDraft(kind: .arkit, itemID: wire.itemID, payload: try! TrackingJSONCodec.makeEncoder().encode(wire))
    }

    static func insert(_ store: CollectionStore, session: CollectionSession, _ draft: UploadItemDraft) throws -> UploadItemRecord {
        try store.sync { try $0.insertUploadItem(sessionID: session.id.uuidString, draft: draft) }
    }

    static func clocks(epoch: Date = Date(timeIntervalSince1970: 1_700_000_000), uptime: TimeInterval = 100) -> SensorRunClocks {
        let anchor = try! TrackingClockAnchor(epochAtAnchor: epoch, uptimeAtAnchor: uptime)
        return SensorRunClocks(motion: anchor, altimeter: anchor, arkit: anchor)
    }

    static func beginRequest(_ session: CollectionSession, streams: Set<CaptureStream> = [.motion, .location, .altimeter, .pedometer],
                             clocks: SensorRunClocks = clocks(), walking: WalkingFrameEstimatorConfiguration? = nil) -> SessionBeginRequest {
        SessionBeginRequest(snapshot: snapshot(session), owner: owner, startPayload: startPayload(session), clocks: clocks,
                            streams: streams, walkingFrame: walking, deviceID: session.deviceId)
    }

    static func motion(native: TimeInterval) -> CapturedPayload {
        let zero = Vector3D(x: 0, y: 0, z: 0)
        return .motion(MotionCapture(nativeTimestamp: native, userAcceleration: zero, rotationRate: zero,
                                     gravity: Vector3D(x: 0, y: 0, z: -1), roll: 0, pitch: 0, yaw: 0,
                                     quaternion: QuaternionD(x: 0, y: 0, z: 0, w: 1), magneticField: nil))
    }

    static func pedometer(endDate: Date, steps: Int, source: SensorCaptureSource = .live) -> CapturedPayload {
        .pedometer(PedometerCapture(endDate: endDate, numberOfSteps: steps, distance: nil, currentPace: nil,
                                    currentCadence: nil, floorsAscended: nil, floorsDescended: nil, source: source))
    }

    static func pose(sequence: Int, frameTimestamp: TimeInterval, arSession: UUID = UUID()) -> CapturedPayload {
        .arkit(ARKitPoseSample(arSessionId: arSession, sequence: sequence, frameTimestamp: frameTimestamp,
                               positionX: 0, positionY: 0, positionZ: 0, rotationX: 0, rotationY: 0, rotationZ: 0,
                               rotationW: 1, trackingState: .normal, trackingStateReason: nil))
    }

    static func captured(_ payload: CapturedPayload, callbackEpoch: Date = Date(timeIntervalSince1970: 1_700_000_001)) -> CapturedSample {
        CapturedSample(payload: payload, callbackUptime: 101, callbackEpoch: callbackEpoch, appState: .foreground)
    }
}

@MainActor
func waitUntil(timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

/// Bridges a `CoreCompletion` into async/await.
@MainActor
func awaitCore<T: Sendable>(_ start: (@escaping CoreCompletion<T>) -> Void) async -> Result<T, Error> {
    await withCheckedContinuation { continuation in
        start { continuation.resume(returning: $0) }
    }
}
