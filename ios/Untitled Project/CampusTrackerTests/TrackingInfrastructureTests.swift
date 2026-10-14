import Foundation
import Testing
@testable import CampusTracker

private struct TrackingDateFixture: Codable {
    let date: Date
}

struct SensorClockMapperTests {
    @Test func callbackDelayDoesNotChangeMapping() throws {
        let epoch = Date(timeIntervalSince1970: 1_700_000_000)
        let anchor = try TrackingClockAnchor(epochAtAnchor: epoch, uptimeAtAnchor: 100)
        #expect(try anchor.map(nativeTimestamp: 101) == epoch.addingTimeInterval(1))
        #expect(try anchor.deliveryResidual(nativeTimestamp: 101,
            callbackEpoch: epoch.addingTimeInterval(4)) == 3)
        #expect(try anchor.map(nativeTimestamp: 102) == epoch.addingTimeInterval(2))
    }

    @Test func derivedTimesShareVerifiedOffset() throws {
        let epoch = Date(timeIntervalSince1970: 1_700_000_000)
        let anchor = try TrackingClockAnchor(epochAtAnchor: epoch, uptimeAtAnchor: 100,
                                             verifiedOffsetSeconds: 40)
        let measured = try anchor.map(nativeTimestamp: 101)
        #expect(try anchor.mapDerived(nativeTimestamp: 100.5, owningNativeTimestamp: 101,
                                      owningMeasuredAt: measured) == measured.addingTimeInterval(-0.5))
    }
}

struct TrackingJSONCodecTests {
    @Test func fractionalDatesRoundTripAndLegacyDatesDecode() throws {
        let epoch = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try TrackingJSONCodec.makeEncoder().encode(
            TrackingDateFixture(date: epoch.addingTimeInterval(0.123)))
        let second = try TrackingJSONCodec.makeEncoder().encode(
            TrackingDateFixture(date: epoch.addingTimeInterval(0.143)))
        #expect(first != second)
        let decoded = try TrackingJSONCodec.makeDecoder().decode(TrackingDateFixture.self, from: first)
        #expect(abs(decoded.date.timeIntervalSince(epoch.addingTimeInterval(0.123))) < 0.001)
        let legacy = Data("{\"date\":\"2023-11-14T22:13:20Z\"}".utf8)
        #expect(try TrackingJSONCodec.makeDecoder().decode(TrackingDateFixture.self,
                                                           from: legacy).date == epoch)
    }
}

private final class AdmissionRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func append(_ value: String) { lock.lock(); defer { lock.unlock() }; entries.append(value) }
    func values() -> [String] { lock.lock(); defer { lock.unlock() }; return entries }
}

struct CaptureIngressTests {
    @Test func concurrentAdmissionsDrainBeforeStopAndRejectOldGeneration() throws {
        let queue = DispatchQueue(label: "TrackingInfrastructureTests.ingress")
        let ingress = TrackingCaptureIngress(processorQueue: queue)
        let recorder = AdmissionRecorder()
        let context = TrackingCaptureContext(sessionID: UUID(), streamSegmentID: UUID(), generation: UUID())
        try ingress.open(context)
        DispatchQueue.concurrentPerform(iterations: 100) { _ in
            #expect(ingress.submit(context: context) { recorder.append(String($0.ordinal)) })
        }
        try ingress.close(context: context) { recorder.append("stop:\($0.lastAdmissionOrdinal)") }
        #expect(!ingress.submit(context: context) { _ in })
        queue.sync {}
        #expect(recorder.values() == (1...100).map(String.init) + ["stop:100"])
    }
}

struct TrackingRatePolicyTests {
    @Test func supportedRegularRatesQualifyAndSparseInputDoesNot() throws {
        for rate in [10, 20, 50] {
            let policy = try TrackingRatePolicy(nominalHz: rate)
            let timestamps = (0...Int(Double(rate) * 2.5)).map { Double($0) / Double(rate) }
            #expect(policy.evaluate(originalTimestamps: timestamps).eligible)
        }
        let policy = try TrackingRatePolicy(nominalHz: 50)
        #expect(!policy.evaluate(originalTimestamps: (0...25).map { Double($0) * 0.1 }).eligible)
        #expect(!policy.evaluate(originalTimestamps: [0, 0.02, 0.02, 0.04]).eligible)
    }
}

// MARK: - Coordinator lifecycle through the real ingress → core → SQLite path

@MainActor
private func makeCoordinator(store: CollectionStore, anchorEpoch: Date = Date(timeIntervalSince1970: 1_700_000_000),
                             clock: (() throws -> TrackingClockAnchor)? = nil) -> CollectionCoordinator {
    CollectionCoordinator(store: store,
                          clockFactory: clock ?? { try TrackingClockAnchor(epochAtAnchor: anchorEpoch, uptimeAtAnchor: 100) },
                          capabilityDetector: { TestFixture.capabilities }, startsHardwareSensors: false)
}

@MainActor
private func startRecording(_ coordinator: CollectionCoordinator) async {
    coordinator.startSession(collectorId: "C04", serverKey: "test", motionRate: .hz50,
                             locationProfile: .highAccuracy, distanceFilter: 0)
    await waitUntil { coordinator.captureState == .recording }
}

@MainActor
private func motionRows(_ store: CollectionStore, _ id: UUID) throws -> [RawRow] {
    try store.sync { try $0.rawRows(sessionID: id, stream: "motion") }
}

@MainActor
struct CoordinatorRecoveryRegressionTests {
    @Test func newCoordinatorResumePreparesClocksAndSyntheticMotionReachesStore() async throws {
        let directory = TestFixture.tempDirectory("CoordinatorResume")
        let first = makeCoordinator(store: CollectionStore(directory: directory))
        await startRecording(first)
        let sessionID = try #require(first.activeSession?.id)
        for index in 0..<3 { first.ingestSyntheticMotionForTesting(nativeTimestamp: 101 + Double(index) * 0.02) }
        first.waitForCaptureIdleForTesting()
        try? await Task.sleep(nanoseconds: 400_000_000)
        first.waitForCaptureIdleForTesting()
        // Process "dies" here: no Stop. A new process opens the same database.
        let store = CollectionStore(directory: directory)
        var anchorIndex = 0
        let second = makeCoordinator(store: store) {
            anchorIndex += 1
            return try TrackingClockAnchor(epochAtAnchor: Date(timeIntervalSince1970: 1_700_000_100 + Double(anchorIndex)), uptimeAtAnchor: 100)
        }
        await waitUntil { second.interruptedCollection != nil }
        #expect(second.interruptedCollection?.session.id == sessionID)
        second.resumeInterruptedCollection(serverKey: "test")
        await waitUntil { second.captureState == .recording }
        #expect(second.sensorRunClockIdentityForTesting != nil)
        #expect(anchorIndex == 4, "motion, relative altitude, absolute altitude and ARKit each get a fresh anchor for the new run")
        second.ingestSyntheticMotionForTesting(nativeTimestamp: 101)
        second.waitForCaptureIdleForTesting()
        try? await Task.sleep(nanoseconds: 400_000_000)
        second.waitForCaptureIdleForTesting()
        let sequences = try motionRows(store, sessionID).map(\.sequence)
        #expect(sequences.prefix(3) == [1, 2, 3])
        #expect(sequences.count == 4)
        #expect((sequences.last ?? 0) > 3, "a resumed run never reuses an issued sequence")
        #expect(second.captureStorageError == nil)
        #expect(second.captureContextsForTesting[.motion] != nil)
    }

    @Test func resumeClockFailureKeepsInterruptedSnapshotAndDoesNotRecord() async throws {
        let directory = TestFixture.tempDirectory("CoordinatorClockFailure")
        let store = CollectionStore(directory: directory)
        let session = TestFixture.session()
        try TestFixture.seed(store, session: session)
        let coordinator = makeCoordinator(store: store) { throw CoordinatorFixtureError.clock }
        await waitUntil { coordinator.interruptedCollection != nil }
        coordinator.resumeInterruptedCollection(serverKey: "test")
        #expect(coordinator.activeSession == nil)
        #expect(coordinator.captureState == .idle)
        #expect(coordinator.interruptedCollection?.session.id == session.id)
        #expect(coordinator.captureStorageError?.contains("CLOCK_ANCHOR_INITIALIZATION_FAILED") == true)
        #expect(try store.sync { try $0.session(id: session.id)?.captureState } == .recording)
    }

    @Test func motionLeaseWriteFailureDoesNotAppendOrAdvanceCounts() async throws {
        let failures = StoreFailureSwitch()
        let store = CollectionStore(directory: TestFixture.tempDirectory("CoordinatorLease"), failureInjector: failures.injector)
        let coordinator = makeCoordinator(store: store)
        await startRecording(coordinator)
        let sessionID = try #require(coordinator.activeSession?.id)
        failures.fail(.leaseReserve)
        coordinator.ingestSyntheticMotionForTesting(nativeTimestamp: 101)
        coordinator.waitForCaptureIdleForTesting()
        await waitUntil { coordinator.captureState == .storageFailure }
        #expect(coordinator.captureStorageError?.contains("SEQUENCE_LEASE_RESERVATION_FAILED") == true)
        #expect(try motionRows(store, sessionID).isEmpty)
        #expect(coordinator.uiCounts.motion == 0)
        #expect(try store.sync { try $0.leases(sessionID: sessionID)["motion"]?.reservedExclusive } == 0)
    }

    @Test func failedStopKeepsSessionAndRetryUsesTheSameStopIntent() async throws {
        let failures = StoreFailureSwitch()
        let store = CollectionStore(directory: TestFixture.tempDirectory("CoordinatorStop"), failureInjector: failures.injector)
        let coordinator = makeCoordinator(store: store)
        await startRecording(coordinator)
        let sessionID = try #require(coordinator.activeSession?.id)
        coordinator.ingestSyntheticMotionForTesting(nativeTimestamp: 101)
        failures.fail(.finalize)
        coordinator.stopSession()
        await waitUntil { coordinator.captureState == .storageFailure }
        #expect(coordinator.captureStorageError?.contains("STOP_FINALIZATION_FAILED") == true)
        #expect(coordinator.activeSession?.id == sessionID)
        let stored = try #require(try store.sync { try $0.session(id: sessionID) })
        #expect(stored.captureState == .stopping)
        let intent = try #require(stored.stopIntent)
        #expect(try motionRows(store, sessionID).map(\.sequence) == [1], "the drained sample was committed before finalization")

        coordinator.stopSession() // retry
        await waitUntil { coordinator.captureState == .idle }
        #expect(coordinator.activeSession == nil)
        let finished = try #require(try store.sync { try $0.session(id: sessionID) })
        #expect(finished.captureState == .stopped)
        #expect(finished.stopIntent == intent, "a retried Stop must not create a new endedAt")
        #expect(finished.manifest == LastSequencesPayload(location: -1, motion: 1, altimeter: -1, pedometer: -1))
        let finish = try #require(try store.sync { try $0.item(kind: .finish, itemID: sessionID.uuidString) })
        let payload = try TrackingJSONCodec.makeDecoder().decode(FinishPayload.self, from: finish.payload)
        #expect(payload.endedAt == intent.endedAt)
        #expect(payload.lastSequences == finished.manifest)
    }

    @Test func startIsBlockedWhileAnInterruptedSessionExists() async throws {
        let store = CollectionStore(directory: TestFixture.tempDirectory("CoordinatorBlocked"))
        try TestFixture.seed(store, session: TestFixture.session())
        let coordinator = makeCoordinator(store: store)
        await waitUntil { coordinator.interruptedCollection != nil }
        coordinator.startSession(collectorId: "C04", serverKey: "test", motionRate: .hz50, locationProfile: .highAccuracy, distanceFilter: 0)
        #expect(coordinator.captureState == .idle)
        #expect(coordinator.captureStorageError?.contains("START_BLOCKED_INTERRUPTED_SESSION") == true)
    }

    @Test func finishInterruptedUsesDurableRowsAndLastKnownTimestamp() async throws {
        let directory = TestFixture.tempDirectory("CoordinatorFinishInterrupted")
        let first = makeCoordinator(store: CollectionStore(directory: directory))
        await startRecording(first)
        let sessionID = try #require(first.activeSession?.id)
        first.ingestSyntheticMotionForTesting(nativeTimestamp: 102)
        try? await Task.sleep(nanoseconds: 400_000_000)
        first.waitForCaptureIdleForTesting()
        let store = CollectionStore(directory: directory)
        let second = makeCoordinator(store: store)
        await waitUntil { second.interruptedCollection != nil }
        second.finishInterruptedCollection(serverKey: "test")
        await waitUntil { second.interruptedCollection == nil && second.captureState == .idle }
        let stored = try #require(try store.sync { try $0.session(id: sessionID) })
        #expect(stored.captureState == .stopped)
        #expect(stored.stopIntent?.interrupted == true)
        // The single motion sample was measured at anchor + (102 - 100) s.
        #expect(stored.stopIntent?.endedAt == Date(timeIntervalSince1970: 1_700_000_002))
        #expect(stored.manifest?.motion == 1)
        let rows = try store.sync { try $0.rawRows(sessionID: sessionID) }
        #expect(rows.allSatisfy { $0.batchID != nil }, "raw a crashed process committed is batched before finish")
    }
}

@MainActor
struct CollectionEndToEndTests {
    /// callback → ingress → core commit → batch transaction → upload → Stop drain → finish →
    /// syncComplete, with no sensor hardware and a mock socket.
    @Test func capturedSamplesFlowThroughCommitBatchUploadFinishAndSyncComplete() async throws {
        let store = CollectionStore(directory: TestFixture.tempDirectory("EndToEnd"))
        let coordinator = makeCoordinator(store: store)
        let socket = MockCollectorSocket()
        coordinator.bind(socket: socket)
        coordinator.updateUploadOwner(collectorId: "C04", serverKey: "test")
        socket.connect()
        await startRecording(coordinator)
        let sessionID = try #require(coordinator.activeSession?.id)
        await waitUntil { socket.count("session:start") == 1 }
        socket.ack(type: "session:start", ok: true, data: ["sessionId": "srv-e2e"])
        func requests() -> [MockCollectorSocket.Sent] { socket.sent.filter { $0.type != "collector:status" } }
        func ackAll(until done: () -> Bool) async {
            var seen = Set<String>()
            let deadline = Date().addingTimeInterval(5)
            while !done(), Date() < deadline {
                if let last = requests().last, !seen.contains(last.requestId), last.type != "session:syncComplete" {
                    seen.insert(last.requestId)
                    socket.ack(requestId: last.requestId, ok: true)
                }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
        for index in 0..<70 { coordinator.ingestSyntheticMotionForTesting(nativeTimestamp: 101 + Double(index) * 0.02) }
        coordinator.ingestSyntheticForTesting(.location(LocationCapture(timestamp: Date(timeIntervalSince1970: 1_700_000_001.25),
            latitude: 37.5, longitude: 127.0, altitude: 50, ellipsoidalAltitude: 70, horizontalAccuracy: 5, verticalAccuracy: 3,
            speed: 1.2, course: 90, speedAccuracy: 0.5, courseAccuracy: 10, floor: nil)))
        coordinator.addMarker(type: .entrance)
        await ackAll { requests().filter { $0.type == "telemetry:batch" }.count >= 1 && requests().contains { $0.type == "marker:create" } }

        coordinator.stopSession()
        await waitUntil { coordinator.captureState == .idle }
        await ackAll { socket.count("session:syncComplete") == 1 }
        let batches = socket.sent.filter { $0.type == "telemetry:batch" }
        let motion = batches.flatMap { ($0.payload["motion"] as? [[String: Any]]) ?? [] }.compactMap { $0["sequence"] as? Int }
        #expect(motion.sorted() == Array(1...70), "every captured motion sample is uploaded exactly once")
        #expect(batches.allSatisfy { $0.payload["sessionId"] as? String == "srv-e2e" })
        let finishIndex = try #require(socket.sent.lastIndex { $0.type == "session:finish" })
        #expect(socket.sent.lastIndex { $0.type == "telemetry:batch" }! < finishIndex, "finish follows every batch")
        let manifest = socket.sent[finishIndex].payload["lastSequences"] as? [String: Int]
        #expect(manifest == ["location": 1, "motion": 70, "altimeter": -1, "pedometer": -1])
        socket.ack(type: "session:syncComplete", ok: true, data: ["synchronized": true])
        await waitUntil { (try? store.sync { try $0.session(id: sessionID)?.syncState }) == .complete }
        #expect(try store.sync { try $0.session(id: sessionID)?.syncState } == .complete)
    }
}

private enum CoordinatorFixtureError: Error { case clock }
