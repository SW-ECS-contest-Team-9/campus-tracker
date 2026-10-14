import Foundation
import Testing
@testable import CampusTracker

// MARK: - Mock transport

/// Drives `TelemetrySyncCoordinator` without a real network connection: captures every outbound
/// message and lets a test manufacture ACKs (or simulate connect/disconnect) on demand.
@MainActor
private final class MockCollectorSocket: CollectorSocket {
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

    /// Acks the most recent *unacked* message of `type` (oldest-first isn't relevant here since
    /// exactly one request is ever in flight — this just finds it by type for readability).
    func ack(type: String, ok: Bool, data: [String: Any]? = nil, error: [String: Any]? = nil) {
        guard let message = sent.last(where: { $0.type == type }) else { return }
        var object: [String: Any] = ["type": "ack", "requestId": message.requestId, "ok": ok]
        if let data { object["data"] = data }
        if let error { object["error"] = error }
        guard let json = try? JSONSerialization.data(withJSONObject: object), let text = String(data: json, encoding: .utf8) else { return }
        onTextMessage?(text)
    }
}

// MARK: - Fixtures

@MainActor
private enum Fixture {
    static let capabilities = SensorCapabilities(
        locationAvailable: true, deviceMotionAvailable: true, altimeterAvailable: false,
        stepCountingAvailable: false, distanceAvailable: false, floorCountingAvailable: false,
        paceAvailable: false, cadenceAvailable: false
    )

    static func session(id: UUID = UUID(), collectorId: String = "C01") -> CollectionSession {
        CollectionSession(
            id: id, collectorId: collectorId, deviceId: UUID(), startedAt: Date(),
            status: .recording, deviceModel: "iPhone15,2", systemVersion: "18.0",
            sensorCapabilities: capabilities, sampleCounts: SampleCounts()
        )
    }

    static func device(session: CollectionSession) -> DeviceInfo {
        DeviceInfo(deviceId: session.deviceId, deviceModel: "iPhone15,2", systemName: "iOS", systemVersion: "18.0", appVersion: "1.0", sensorCapabilities: capabilities)
    }

    static func marker(session: CollectionSession) -> EventMarker {
        EventMarker(id: UUID(), sessionId: session.id, timestamp: Date(), type: .entrance, note: nil, latitude: nil, longitude: nil, altitude: nil, horizontalAccuracy: nil, verticalAccuracy: nil)
    }

    static func tempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("SyncQueueTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

private func waitUntil(timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while await !condition(), Date() < deadline {
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

// MARK: - Single in-flight ordering (P0)

@MainActor
struct TelemetrySyncOrderingTests {
    @Test func delayedAckDoesNotLetANewerItemOvertakeAnOlderOne() async {
        let socket = MockCollectorSocket()
        let sync = TelemetrySyncCoordinator(webSocket: socket, queueDirectory: Fixture.tempDirectory())
        let session = Fixture.session()
        let owner = UploadOwner(collectorId: session.collectorId, serverKey: "http://test:3000")

        socket.connect()
        sync.start(session: session, device: Fixture.device(session: session), owner: owner)
        await waitUntil { socket.sent.contains { $0.type == "session:start" } }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
        await waitUntil { socket.sent.contains { $0.type == "marker:create" } == false } // nothing queued yet

        let markerA = Fixture.marker(session: session)
        sync.append(marker: markerA, session: session)
        await waitUntil { socket.sent.contains { $0.type == "marker:create" } }
        #expect(socket.sent.filter { $0.type == "marker:create" }.count == 1)

        // A second item is queued while markerA's ACK is still outstanding. The old `awaiting:
        // Set<String>` design would send this immediately, racing with markerA's still-in-flight
        // request; the fix must hold it until markerA resolves.
        let markerB = Fixture.marker(session: session)
        sync.append(marker: markerB, session: session)
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(socket.sent.filter { $0.type == "marker:create" }.count == 1, "a second item must not be sent while an earlier one is still awaiting its ACK")

        socket.ack(type: "marker:create", ok: true, data: ["markerId": markerA.id.uuidString, "duplicate": false])
        await waitUntil { socket.sent.filter({ $0.type == "marker:create" }).count == 2 }
        #expect(sync.pendingCount == 1) // markerB now in flight, markerA removed

        socket.ack(type: "marker:create", ok: true, data: ["markerId": markerB.id.uuidString, "duplicate": false])
        await waitUntil { sync.pendingCount == 0 }
        #expect(sync.pendingCount == 0)
    }

    @Test func disconnectWhileInFlightKeepsTheItemQueuedAndResendsAfterReconnect() async {
        let socket = MockCollectorSocket()
        let sync = TelemetrySyncCoordinator(webSocket: socket, queueDirectory: Fixture.tempDirectory())
        let session = Fixture.session()
        let owner = UploadOwner(collectorId: session.collectorId, serverKey: "http://test:3000")

        socket.connect()
        sync.start(session: session, device: Fixture.device(session: session), owner: owner)
        await waitUntil { socket.sent.contains { $0.type == "session:start" } }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])

        let marker = Fixture.marker(session: session)
        sync.append(marker: marker, session: session)
        await waitUntil { socket.sent.contains { $0.type == "marker:create" } }
        #expect(sync.pendingCount == 1)

        socket.disconnect() // ACK never arrives
        #expect(sync.pendingCount == 1, "a dropped connection must not lose or quarantine the in-flight item")

        socket.connect() // forces a session:start re-handshake before anything else can resend
        await waitUntil { socket.sent.filter({ $0.type == "session:start" }).count == 2 }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
        await waitUntil { socket.sent.filter({ $0.type == "marker:create" }).count == 2 }
        socket.ack(type: "marker:create", ok: true, data: ["markerId": marker.id.uuidString, "duplicate": false])
        await waitUntil { sync.pendingCount == 0 }
        #expect(sync.pendingCount == 0)
    }
}

// MARK: - Retry vs. quarantine (P0)

@MainActor
struct TelemetrySyncRetryTests {
    @Test func nonRetryableErrorQuarantinesInsteadOfRetryingForever() async {
        let socket = MockCollectorSocket()
        let sync = TelemetrySyncCoordinator(webSocket: socket, queueDirectory: Fixture.tempDirectory())
        let session = Fixture.session()
        let owner = UploadOwner(collectorId: session.collectorId, serverKey: "http://test:3000")

        socket.connect()
        sync.start(session: session, device: Fixture.device(session: session), owner: owner)
        await waitUntil { socket.sent.contains { $0.type == "session:start" } }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])

        let badMarker = Fixture.marker(session: session)
        sync.append(marker: badMarker, session: session)
        await waitUntil { socket.sent.contains { $0.type == "marker:create" } }
        socket.ack(type: "marker:create", ok: false, error: ["code": "VALIDATION_ERROR", "message": "bad", "status": 400, "retryable": false])
        await waitUntil { sync.quarantinedCount == 1 }
        #expect(sync.quarantinedCount == 1)
        #expect(sync.pendingCount == 0, "a quarantined item must not count as sendable pending work")

        // A later, unrelated item must still flow — the quarantined one must not block the queue.
        let goodMarker = Fixture.marker(session: session)
        sync.append(marker: goodMarker, session: session)
        await waitUntil { socket.sent.filter({ $0.type == "marker:create" }).count == 2 }
        #expect(socket.sent.filter { $0.type == "marker:create" }.count == 2, "the quarantined item must never be resent")
    }

    @Test func retryableErrorKeepsTheItemQueuedAndResendsAfterBackoff() async {
        let socket = MockCollectorSocket()
        let sync = TelemetrySyncCoordinator(webSocket: socket, queueDirectory: Fixture.tempDirectory())
        let session = Fixture.session()
        let owner = UploadOwner(collectorId: session.collectorId, serverKey: "http://test:3000")

        socket.connect()
        sync.start(session: session, device: Fixture.device(session: session), owner: owner)
        await waitUntil { socket.sent.contains { $0.type == "session:start" } }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])

        let marker = Fixture.marker(session: session)
        sync.append(marker: marker, session: session)
        await waitUntil { socket.sent.contains { $0.type == "marker:create" } }
        socket.ack(type: "marker:create", ok: false, error: ["code": "INTERNAL", "message": "db down", "status": 500, "retryable": true])
        #expect(sync.pendingCount == 1, "a retryable failure must keep the item queued, not quarantine it")

        await waitUntil(timeout: 4) { socket.sent.filter({ $0.type == "marker:create" }).count == 2 }
        #expect(socket.sent.filter { $0.type == "marker:create" }.count == 2, "a retryable failure must resend after the backoff delay")
    }
}

// MARK: - Owner scoping (P0)

@MainActor
struct TelemetrySyncOwnerScopingTests {
    @Test func dataRecordedUnderOneOwnerIsHeldWhileAnotherOwnerIsSignedIn() async {
        let socket = MockCollectorSocket()
        let sync = TelemetrySyncCoordinator(webSocket: socket, queueDirectory: Fixture.tempDirectory())
        let session = Fixture.session(collectorId: "C01")
        let ownerA = UploadOwner(collectorId: "C01", serverKey: "http://test:3000")
        let ownerB = UploadOwner(collectorId: "C02", serverKey: "http://test:3000")

        socket.connect()
        sync.start(session: session, device: Fixture.device(session: session), owner: ownerA)
        await waitUntil { socket.sent.contains { $0.type == "session:start" } }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])

        // The app switched accounts: C01's in-flight session now belongs to a different owner.
        sync.updateOwner(ownerB)
        let marker = Fixture.marker(session: session)
        sync.append(marker: marker, session: session)
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(socket.sent.contains { $0.type == "marker:create" } == false, "C01's data must not upload while C02 is signed in")

        sync.updateOwner(ownerA)
        await waitUntil { socket.sent.contains { $0.type == "marker:create" } }
        #expect(socket.sent.contains { $0.type == "marker:create" })
    }
}

// MARK: - Durability across a simulated relaunch (P0)

@MainActor
struct TelemetrySyncDurabilityTests {
    @Test func queuedDataSurvivesAProcessRelaunchAndKeepsUploading() async {
        let directory = Fixture.tempDirectory()
        let session = Fixture.session()
        let owner = UploadOwner(collectorId: session.collectorId, serverKey: "http://test:3000")

        let socketA = MockCollectorSocket()
        let syncA = TelemetrySyncCoordinator(webSocket: socketA, queueDirectory: directory)
        socketA.connect()
        syncA.start(session: session, device: Fixture.device(session: session), owner: owner)
        await waitUntil { socketA.sent.contains { $0.type == "session:start" } }
        socketA.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
        let marker = Fixture.marker(session: session)
        syncA.append(marker: marker, session: session)
        await waitUntil { socketA.sent.contains { $0.type == "marker:create" } }
        // Never acked — simulate the process dying with this item still unconfirmed. Give the
        // debounced disk write (0.1s) time to land before "relaunching".
        try? await Task.sleep(nanoseconds: 250_000_000)

        let socketB = MockCollectorSocket()
        let syncB = TelemetrySyncCoordinator(webSocket: socketB, queueDirectory: directory)
        #expect(syncB.pendingCount == 0, "without an authenticated owner restored work is held, not sendable")
        #expect(syncB.heldCount == 1, "the marker queued before relaunch must still be durably held")
        socketB.connect()
        syncB.updateOwner(owner)
        #expect(syncB.pendingCount == 1)
        await waitUntil { socketB.sent.contains { $0.type == "session:start" } }
        socketB.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
        await waitUntil { socketB.sent.contains { $0.type == "marker:create" } }
        socketB.ack(type: "marker:create", ok: true, data: ["markerId": marker.id.uuidString, "duplicate": false])
        await waitUntil { syncB.pendingCount == 0 }
        #expect(syncB.pendingCount == 0)
    }
}

// MARK: - Durable sequence high-water mark (P0/P1)

struct SequenceLeaseStoreTests {
    @Test func aSequenceIsNeverReusedAfterASimulatedCrash() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SequenceLeaseTests-\(UUID().uuidString)", isDirectory: true)
        let sessionId = UUID()

        let beforeCrash = SequenceLeaseStore(leaseBlockSize: 10, directoryOverride: directory)
        for sequence in 0..<10 {
            beforeCrash.ensureLeased(sessionId: sessionId, stream: \.location, nextSequence: sequence)
        }
        // Only sequences 0...9 were ever actually issued before the (simulated) crash; nothing
        // beyond that was persisted to the in-memory `ActiveCollectionState` snapshot either.

        let afterCrash = SequenceLeaseStore(leaseBlockSize: 10, directoryOverride: directory)
        let recoveredBoundary = afterCrash.load(sessionId: sessionId).location
        #expect(recoveredBoundary >= 10, "the durable boundary must be at or beyond every sequence actually issued")

        // Resuming from the durable boundary (not from a possibly-stale in-memory counter) must
        // never land on an already-issued number.
        #expect(recoveredBoundary > 9)
    }

    @Test func leaseAdvancesOncePerBlockNotOncePerSequence() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SequenceLeaseTests-\(UUID().uuidString)", isDirectory: true)
        let sessionId = UUID()
        let store = SequenceLeaseStore(leaseBlockSize: 5, directoryOverride: directory)

        store.ensureLeased(sessionId: sessionId, stream: \.motion, nextSequence: 0)
        #expect(store.load(sessionId: sessionId).motion == 5)

        store.ensureLeased(sessionId: sessionId, stream: \.motion, nextSequence: 4)
        #expect(store.load(sessionId: sessionId).motion == 5, "must not advance again before the boundary is reached")

        store.ensureLeased(sessionId: sessionId, stream: \.motion, nextSequence: 5)
        #expect(store.load(sessionId: sessionId).motion == 10)
    }
}

// MARK: - Per-session finish barrier and sync completion

@MainActor
struct SessionFinalizationQueueTests {
    @Test func finishWaitsForDiagnosticsThenSendsSyncComplete() async {
        let socket = MockCollectorSocket()
        let sync = TelemetrySyncCoordinator(webSocket: socket, queueDirectory: Fixture.tempDirectory())
        var session = Fixture.session()
        let owner = UploadOwner(collectorId: session.collectorId, serverKey: "http://test:3000")

        sync.start(session: session, device: Fixture.device(session: session), owner: owner)
        for sensor in ["location", "motion", "altimeter", "pedometer"] {
            sync.logDiagnostic(eventType: "SENSOR_STOPPED", metadata: ["sensor": sensor], clientSessionId: session.id.uuidString)
        }
        session.endedAt = Date()
        let last = LastSequencesPayload(location: 4, motion: 21, altimeter: -1, pedometer: -1)
        sync.finish(session: session, lastSequences: last)

        socket.connect()
        await waitUntil { socket.sent.contains { $0.type == "session:start" } }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])

        for expectedCount in 1...4 {
            await waitUntil { socket.sent.filter { $0.type == "diagnostic:event" }.count == expectedCount }
            #expect(socket.sent.contains { $0.type == "session:finish" } == false)
            socket.ack(type: "diagnostic:event", ok: true)
        }
        await waitUntil { socket.sent.contains { $0.type == "session:finish" } }
        socket.ack(type: "session:finish", ok: true)

        // The finish ACK itself is retained as a session-scoped diagnostic before syncComplete.
        await waitUntil { socket.sent.filter { $0.type == "diagnostic:event" }.count == 5 }
        socket.ack(type: "diagnostic:event", ok: true)
        await waitUntil { socket.sent.contains { $0.type == "session:syncComplete" } }
        let syncPayload = socket.sent.last { $0.type == "session:syncComplete" }?.payload
        let sequences = syncPayload?["lastSequences"] as? [String: Any]
        #expect(sequences?["altimeter"] as? Int == -1)
        #expect(sequences?["pedometer"] as? Int == -1)
        socket.ack(type: "session:syncComplete", ok: true, data: ["synchronized": true])

        // syncComplete ACK is also queued diagnostically, then the session metadata is cleaned.
        await waitUntil { socket.sent.filter { $0.type == "diagnostic:event" }.count == 6 }
        socket.ack(type: "diagnostic:event", ok: true)
        await waitUntil { sync.pendingCount == 0 }
        #expect(sync.pendingCount == 0)
        #expect(sync.quarantinedCount == 0)
    }

    @Test func diagnosticQueuedAfterFinishAckStillUploads() async {
        let socket = MockCollectorSocket()
        let sync = TelemetrySyncCoordinator(webSocket: socket, queueDirectory: Fixture.tempDirectory())
        var session = Fixture.session()
        let owner = UploadOwner(collectorId: session.collectorId, serverKey: "http://test:3000")
        socket.connect()
        sync.start(session: session, device: Fixture.device(session: session), owner: owner)
        await waitUntil { socket.sent.contains { $0.type == "session:start" } }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
        session.endedAt = Date()
        sync.finish(session: session, lastSequences: LastSequencesPayload(location: -1, motion: -1, altimeter: -1, pedometer: -1))
        await waitUntil { socket.sent.contains { $0.type == "session:finish" } }
        socket.ack(type: "session:finish", ok: true)
        sync.logDiagnostic(eventType: "UPLOAD_RETRY", clientSessionId: session.id.uuidString)
        await waitUntil { socket.sent.filter { $0.type == "diagnostic:event" }.count >= 1 }
        #expect(socket.sent.contains { $0.type == "diagnostic:event" })
    }
}
