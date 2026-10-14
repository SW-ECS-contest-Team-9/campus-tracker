import Foundation
import Testing
@testable import CampusTracker

/// A store + engine with one registered, active session whose `session:start` has been ACKed.
@MainActor
private func connectedEngine(store: CollectionStore? = nil, session: CollectionSession = TestFixture.session())
    async throws -> (MockCollectorSocket, TelemetryUploadEngine, CollectionStore, CollectionSession) {
    let store = store ?? CollectionStore(directory: TestFixture.tempDirectory("Upload"))
    try TestFixture.seed(store, session: session)
    let socket = MockCollectorSocket()
    let engine = TelemetryUploadEngine(webSocket: socket, store: store)
    await waitUntil { engine.isLoaded }
    engine.updateOwner(TestFixture.owner)
    engine.activate(sessionID: session.id)
    socket.connect()
    await waitUntil { socket.count("session:start") == 1 }
    socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
    try? await Task.sleep(nanoseconds: 30_000_000)
    return (socket, engine, store, session)
}

// MARK: - Single in-flight ordering (P0)

@MainActor
struct TelemetrySyncOrderingTests {
    @Test func delayedAckDoesNotLetANewerItemOvertakeAnOlderOne() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        let markerA = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([markerA])
        await waitUntil { socket.count("marker:create") == 1 }
        #expect(socket.count("marker:create") == 1)

        // A second item queued while markerA's ACK is outstanding must wait for it.
        let markerB = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([markerB])
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(socket.count("marker:create") == 1, "a second item must not be sent while an earlier one is still awaiting its ACK")

        socket.ack(type: "marker:create", ok: true, data: ["markerId": markerA.itemID, "duplicate": false])
        await waitUntil { socket.count("marker:create") == 2 }
        #expect(engine.pendingCount == 1)
        #expect((socket.sent.last { $0.type == "marker:create" }?.payload["markerId"] as? String) == markerB.itemID)

        socket.ack(type: "marker:create", ok: true, data: ["markerId": markerB.itemID, "duplicate": false])
        await waitUntil { engine.pendingCount == 0 }
        #expect(engine.pendingCount == 0)
        #expect(try store.sync { try $0.item(kind: .marker, itemID: markerA.itemID)?.state } == .acked)
    }

    @Test func disconnectWhileInFlightKeepsTheItemQueuedAndResendsAfterReconnect() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        let marker = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([marker])
        await waitUntil { socket.count("marker:create") == 1 }
        let staleRequest = try #require(socket.sent.last { $0.type == "marker:create" }?.requestId)

        socket.disconnect() // ACK never arrives
        #expect(engine.pendingCount == 1, "a dropped connection must not lose or quarantine the in-flight item")

        socket.connect() // forces a session:start re-handshake before anything else can resend
        await waitUntil { socket.count("session:start") == 2 }
        // A late ACK for the previous connection's request must not complete anything.
        socket.ack(requestId: staleRequest, ok: true)
        #expect(engine.pendingCount == 1)
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
        await waitUntil { socket.count("marker:create") == 2 }
        socket.ack(type: "marker:create", ok: true, data: ["markerId": marker.itemID, "duplicate": false])
        await waitUntil { engine.pendingCount == 0 }
        #expect(engine.pendingCount == 0)
    }
}

// MARK: - Retry vs. quarantine (P0)

@MainActor
struct TelemetrySyncRetryTests {
    @Test func nonRetryableErrorQuarantinesInsteadOfRetryingForever() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        let bad = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([bad])
        await waitUntil { socket.count("marker:create") == 1 }
        socket.ack(type: "marker:create", ok: false, error: ["code": "VALIDATION_ERROR", "message": "bad", "status": 400,
                                                            "retryable": false, "details": ["field": "type"]])
        await waitUntil { engine.quarantinedCount == 1 }
        #expect(engine.quarantinedCount == 1)
        #expect(engine.pendingCount == 0, "a quarantined item must not count as sendable pending work")
        let stored = try store.sync { try $0.item(kind: .marker, itemID: bad.itemID) }
        #expect(stored?.state == .quarantined)
        #expect(stored?.lastError?.code == "VALIDATION_ERROR")
        #expect(stored?.lastError?.details == .object(["field": .string("type")]))
        #expect(stored?.payload.isEmpty == false, "the original item is preserved with its error")

        let good = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([good])
        await waitUntil { socket.count("marker:create") == 2 }
        #expect(socket.count("marker:create") == 2, "the quarantined item must never be resent")
    }

    @Test func retryableErrorKeepsTheItemQueuedAndResendsAfterBackoff() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        let marker = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([marker])
        await waitUntil { socket.count("marker:create") == 1 }
        socket.ack(type: "marker:create", ok: false, error: ["code": "INTERNAL", "message": "db down", "status": 500, "retryable": true])
        #expect(engine.pendingCount == 1, "a retryable failure must keep the item queued, not quarantine it")

        // New work/commit notifications call synchronize repeatedly; none may bypass the window.
        let other = try TestFixture.insert(store, session: session, TestFixture.diagnosticDraft(type: "X"))
        engine.ingest([other])
        try? await Task.sleep(nanoseconds: 250_000_000)
        #expect(socket.count("marker:create") == 1)
        #expect(socket.count("diagnostic:event") == 0)

        await waitUntil(timeout: 4) { socket.count("marker:create") == 2 }
        #expect(socket.count("marker:create") == 2, "a retryable failure must resend after the backoff delay")
    }

    @Test func encodingFailureIsQuarantinedAsSerializationFailed() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        let broken = try TestFixture.insert(store, session: session,
            UploadItemDraft(kind: .marker, itemID: UUID().uuidString, payload: Data("not-json".utf8)))
        engine.ingest([broken])
        await waitUntil { engine.quarantinedCount == 1 }
        #expect(socket.count("marker:create") == 0)
        #expect(try store.sync { try $0.item(kind: .marker, itemID: broken.itemID)?.lastError?.code } == "SERIALIZATION_FAILED")
    }

    @Test func ackLedgerCommitFailureKeepsItemPendingAndResends() async throws {
        let failures = StoreFailureSwitch()
        let store = CollectionStore(directory: TestFixture.tempDirectory("AckCommit"), failureInjector: failures.injector)
        let (socket, engine, _, session) = try await connectedEngine(store: store)
        var storageErrors: [String] = []
        engine.onStorageError = { storageErrors.append($0) }
        let marker = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([marker])
        await waitUntil { socket.count("marker:create") == 1 }
        failures.fail(.ledgerUpdate)
        socket.ack(type: "marker:create", ok: true)
        await waitUntil { !storageErrors.isEmpty }
        #expect(engine.pendingCount == 1, "a failed ACK commit must leave the item PENDING")
        #expect(try store.sync { try $0.item(kind: .marker, itemID: marker.itemID)?.state } == .pending)
        await waitUntil(timeout: 4) { socket.count("marker:create") == 2 }
        socket.ack(type: "marker:create", ok: true)
        await waitUntil { engine.pendingCount == 0 }
        #expect(try store.sync { try $0.item(kind: .marker, itemID: marker.itemID)?.state } == .acked)
    }
}

// MARK: - Owner scoping (P0)

@MainActor
struct TelemetrySyncOwnerScopingTests {
    @Test func dataRecordedUnderOneOwnerIsHeldWhileAnotherOwnerIsSignedIn() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        // The app switched accounts: C01's session now belongs to a different owner.
        engine.updateOwner(UploadOwner(collectorId: "C02", serverKey: "http://test:3000"))
        let marker = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        engine.ingest([marker])
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(socket.count("marker:create") == 0, "C01's data must not upload while C02 is signed in")
        #expect(engine.heldCount == 1)

        engine.updateOwner(TestFixture.owner)
        await waitUntil { socket.count("marker:create") == 1 }
        #expect(socket.count("marker:create") == 1)
    }
}

// MARK: - Durability across a simulated relaunch (P0)

@MainActor
struct TelemetrySyncDurabilityTests {
    @Test func queuedDataSurvivesAProcessRelaunchAndKeepsUploading() async throws {
        let directory = TestFixture.tempDirectory("Relaunch")
        let (socketA, _, storeA, session) = try await connectedEngine(store: CollectionStore(directory: directory))
        let marker = try TestFixture.insert(storeA, session: session, TestFixture.markerDraft(session: session))
        _ = socketA // never acked — the process "dies" with the item unconfirmed

        let socketB = MockCollectorSocket()
        let engineB = TelemetryUploadEngine(webSocket: socketB, store: CollectionStore(directory: directory))
        await waitUntil { engineB.isLoaded }
        #expect(engineB.pendingCount == 0, "without an authenticated owner restored work is held, not sendable")
        #expect(engineB.heldCount == 1, "the marker committed before relaunch must still be durably held")
        socketB.connect()
        engineB.updateOwner(TestFixture.owner)
        #expect(engineB.pendingCount == 1)
        await waitUntil { socketB.count("session:start") == 1 }
        socketB.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])
        await waitUntil { socketB.count("marker:create") == 1 }
        socketB.ack(type: "marker:create", ok: true, data: ["markerId": marker.itemID, "duplicate": false])
        await waitUntil { engineB.pendingCount == 0 }
        #expect(engineB.pendingCount == 0)
    }

    @Test func unavailableStoreNeverPretendsToBeEmpty() async throws {
        let invalid = FileManager.default.temporaryDirectory.appendingPathComponent("UploadStoreFailure-\(UUID().uuidString)")
        try Data("not-a-directory".utf8).write(to: invalid)
        let socket = MockCollectorSocket()
        let engine = TelemetryUploadEngine(webSocket: socket, store: CollectionStore(directory: invalid))
        await waitUntil { engine.loadFailure != nil }
        #expect(engine.loadFailure != nil)
        #expect(!engine.isLoaded)
        socket.connect()
        engine.updateOwner(TestFixture.owner)
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(socket.sent.isEmpty)
    }
}

// MARK: - Per-session finish barrier and sync completion

@MainActor
private func finalizeSession(_ store: CollectionStore, _ session: CollectionSession, location: Int, motion: Int) throws {
    try store.sync { access in
        var records: [RawRecordDraft] = []
        for sequence in 1...max(1, location) where location > 0 {
            records.append(RawRecordDraft(stream: "location", sequence: sequence, measuredAtMs: Int64(sequence), payload: Data("{}".utf8), uploadItem: nil))
        }
        for sequence in 1...max(1, motion) where motion > 0 {
            records.append(RawRecordDraft(stream: "motion", sequence: sequence, measuredAtMs: Int64(sequence), payload: Data("{}".utf8), uploadItem: nil))
        }
        _ = try access.commitRaw(sessionID: session.id, records: records, snapshot: nil)
        let intent = StopIntent(sessionID: session.id, endedAt: Date(), reason: "user_stop", interrupted: false, requestedAt: Date())
        try access.persistStopIntent(intent, snapshot: TestFixture.snapshot(session))
        let manifest = try access.manifest(sessionID: session.id)
        let finish = FinishPayload(clientSessionId: session.id.uuidString, sessionId: nil, endedAt: intent.endedAt,
                                   lastSequences: manifest, interrupted: false)
        _ = try access.finalize(sessionID: session.id, manifest: manifest,
                                finish: UploadItemDraft(kind: .finish, itemID: session.id.uuidString,
                                                        payload: try TrackingJSONCodec.makeEncoder().encode(finish)),
                                snapshot: TestFixture.snapshot(session))
    }
}

@MainActor
struct SessionFinalizationQueueTests {
    @Test func finishWaitsForDiagnosticsThenSendsSyncComplete() async throws {
        let store = CollectionStore(directory: TestFixture.tempDirectory("Finish"))
        let session = TestFixture.session()
        try TestFixture.seed(store, session: session)
        for sensor in ["location", "motion", "altimeter", "pedometer"] {
            _ = try TestFixture.insert(store, session: session, TestFixture.diagnosticDraft(type: "SENSOR_STOPPED_\(sensor)"))
        }
        try finalizeSession(store, session, location: 4, motion: 21)
        let socket = MockCollectorSocket()
        let engine = TelemetryUploadEngine(webSocket: socket, store: store)
        await waitUntil { engine.isLoaded }
        engine.updateOwner(TestFixture.owner)
        socket.connect()
        await waitUntil { socket.count("session:start") == 1 }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "server-session-1"])

        for expectedCount in 1...4 {
            await waitUntil { socket.count("diagnostic:event") == expectedCount }
            #expect(socket.count("session:finish") == 0)
            socket.ack(type: "diagnostic:event", ok: true)
        }
        await waitUntil { socket.count("session:finish") == 1 }
        let finish = socket.sent.last { $0.type == "session:finish" }?.payload
        #expect(finish?["sessionId"] as? String == "server-session-1")
        socket.ack(type: "session:finish", ok: true)

        // The finish ACK itself is retained as a session-scoped diagnostic before syncComplete.
        await waitUntil { socket.count("diagnostic:event") == 5 }
        socket.ack(type: "diagnostic:event", ok: true)
        await waitUntil { socket.count("session:syncComplete") == 1 }
        let sequences = socket.sent.last { $0.type == "session:syncComplete" }?.payload["lastSequences"] as? [String: Any]
        #expect(sequences?["location"] as? Int == 4)
        #expect(sequences?["motion"] as? Int == 21)
        #expect(sequences?["altimeter"] as? Int == -1)
        #expect(sequences?["pedometer"] as? Int == -1)
        socket.ack(type: "session:syncComplete", ok: true, data: ["synchronized": true])

        await waitUntil { socket.count("diagnostic:event") == 6 }
        socket.ack(type: "diagnostic:event", ok: true)
        await waitUntil { engine.pendingCount == 0 }
        #expect(engine.pendingCount == 0)
        #expect(engine.quarantinedCount == 0)
        #expect(try store.sync { try $0.session(id: session.id)?.syncState } == .complete)
    }

    @Test func diagnosticQueuedAfterFinishAckStillUploads() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        try finalizeSession(store, session, location: 0, motion: 0)
        engine.ingest(try store.sync { try $0.loadUploadLedger().items })
        await waitUntil { socket.count("session:finish") == 1 }
        socket.ack(type: "session:finish", ok: true)
        engine.logDiagnostic(eventType: "UPLOAD_RETRY", clientSessionId: session.id.uuidString)
        await waitUntil { socket.count("diagnostic:event") == 1 }
        socket.ack(type: "diagnostic:event", ok: true)
        await waitUntil { socket.count("diagnostic:event") >= 2 }
        #expect(socket.count("diagnostic:event") >= 2)
    }

    @Test func syncCompleteWithoutTypedSynchronizedIsAProtocolErrorNotComplete() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        try finalizeSession(store, session, location: 1, motion: 0)
        engine.ingest(try store.sync { try $0.loadUploadLedger().items })
        await waitUntil { socket.count("session:finish") == 1 }
        socket.ack(type: "session:finish", ok: true)
        await waitUntil { socket.count("diagnostic:event") == 1 }
        socket.ack(type: "diagnostic:event", ok: true)
        await waitUntil { socket.count("session:syncComplete") == 1 }
        socket.ack(type: "session:syncComplete", ok: true, data: ["status": "ok"])
        await waitUntil { engine.quarantinedCount == 1 }
        #expect(try store.sync { try $0.session(id: session.id)?.syncState } == .protocolError)
    }

    @Test func syncCompleteFalseMarksIncomplete() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        try finalizeSession(store, session, location: 1, motion: 0)
        engine.ingest(try store.sync { try $0.loadUploadLedger().items })
        await waitUntil { socket.count("session:finish") == 1 }
        socket.ack(type: "session:finish", ok: true)
        await waitUntil { socket.count("diagnostic:event") == 1 }
        socket.ack(type: "diagnostic:event", ok: true)
        await waitUntil { socket.count("session:syncComplete") == 1 }
        socket.ack(type: "session:syncComplete", ok: true, data: ["synchronized": false, "streams": ["motion": ["expected": 3]]])
        await waitUntil { engine.unsynchronizedCount == 1 }
        #expect(try store.sync { try $0.session(id: session.id)?.syncState } == .incomplete)
    }

    @Test func finishIsNotSentWhileItsSessionStillHasEarlierItems() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        let marker = try TestFixture.insert(store, session: session, TestFixture.markerDraft(session: session))
        try finalizeSession(store, session, location: 1, motion: 0)
        engine.ingest(try store.sync { try $0.loadUploadLedger().items })
        await waitUntil { socket.count("marker:create") == 1 }
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(socket.count("session:finish") == 0)
        socket.ack(type: "marker:create", ok: true, data: ["markerId": marker.itemID])
        await waitUntil { socket.count("session:finish") == 1 }
        #expect(socket.count("session:finish") == 1)
    }
}

// MARK: - Fair scheduling (ARKit / telemetry / aux)

struct UploadSchedulerTests {
    @Test func telemetryBurstThenAuxThenArkit() {
        var scheduler = UploadScheduler()
        let all: Set<UploadScheduler.Lane> = [.telemetry, .aux, .arkit]
        var order: [UploadScheduler.Lane] = []
        var now = 10.0
        for _ in 0..<12 {
            guard let lane = scheduler.choose(available: all, now: now) else { break }
            scheduler.record(lane, now: now)
            order.append(lane)
            now += 0.05
        }
        #expect(order == [.arkit, .telemetry, .telemetry, .telemetry, .telemetry, .aux, .arkit,
                          .telemetry, .telemetry, .telemetry, .telemetry, .aux])
    }

    @Test func arkitGetsATurnAfterOneSecondEvenWithoutAux() {
        var scheduler = UploadScheduler()
        scheduler.record(.arkit, now: 0)
        #expect(scheduler.choose(available: [.telemetry, .arkit], now: 0.5) == .telemetry)
        #expect(scheduler.choose(available: [.telemetry, .arkit], now: 1.0) == .arkit)
    }

    @Test func finishOnlyWhenNothingElse() {
        let scheduler = UploadScheduler()
        #expect(scheduler.choose(available: [.finish, .aux], now: 0) == .aux)
        #expect(scheduler.choose(available: [.finish], now: 0) == .finish)
    }
}

@MainActor
struct UploadEngineFairnessTests {
    @Test func arkitBacklogDoesNotStarveTelemetryOrDiagnostics() async throws {
        let (socket, engine, store, session) = try await connectedEngine()
        var records: [UploadItemRecord] = []
        for index in 0..<10 { records.append(try TestFixture.insert(store, session: session, TestFixture.arkitDraft(session: session, sequence: index))) }
        for _ in 0..<6 { records.append(try TestFixture.insert(store, session: session, TestFixture.telemetryDraft(session: session))) }
        records.append(try TestFixture.insert(store, session: session, TestFixture.diagnosticDraft(type: "D")))
        engine.ingest(records)
        var types: [String] = []
        func requests() -> [MockCollectorSocket.Sent] { socket.sent.filter { $0.type != "collector:status" } }
        for _ in 0..<8 {
            let before = requests().count
            await waitUntil { requests().count > before }
            guard requests().count > before, let last = requests().last else { break }
            types.append(last.type)
            socket.ack(requestId: last.requestId, ok: true)
        }
        #expect(types == ["arkit:pose", "telemetry:batch", "telemetry:batch", "telemetry:batch", "telemetry:batch",
                          "diagnostic:event", "arkit:pose", "telemetry:batch"])
        #expect(engine.arkitBacklog(sessionID: session.id).count == 8)
    }
}
