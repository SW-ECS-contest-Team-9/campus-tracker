import Foundation
import Testing
@testable import CampusTracker

// MARK: - Store transactions

@MainActor
struct CollectionStoreTests {
    private func raw(_ stream: String, _ sequence: Int, _ text: String = "{}") -> RawRecordDraft {
        RawRecordDraft(stream: stream, sequence: sequence, measuredAtMs: Int64(sequence), payload: Data(text.utf8), uploadItem: nil)
    }

    @Test func failedCommitLeavesNothingAndRetryWithSameSequencesIsIdempotent() throws {
        let failures = StoreFailureSwitch()
        let store = CollectionStore(directory: TestFixture.tempDirectory("StoreCommit"), failureInjector: failures.injector)
        let session = TestFixture.session()
        try TestFixture.seed(store, session: session)
        let records = [raw("motion", 1), raw("motion", 2)]
        failures.fail(.rawCommit)
        #expect(throws: CollectionStoreError.self) {
            _ = try store.sync { try $0.commitRaw(sessionID: session.id, records: records, snapshot: nil) }
        }
        #expect(try store.sync { try $0.rawRows(sessionID: session.id) }.isEmpty)
        _ = try store.sync { try $0.commitRaw(sessionID: session.id, records: records, snapshot: nil) }
        _ = try store.sync { try $0.commitRaw(sessionID: session.id, records: records, snapshot: nil) }
        #expect(try store.sync { try $0.rawRows(sessionID: session.id) }.map(\.sequence) == [1, 2])
        #expect(try store.sync { try $0.leases(sessionID: session.id)["motion"] } == StreamLeaseRow(reservedExclusive: 0, lastRecorded: 2, recordedCount: 2))
    }

    @Test func differentPayloadUnderAStoredSequenceIsAConflictNotAnOverwrite() throws {
        let store = CollectionStore(directory: TestFixture.tempDirectory("StoreConflict"))
        let session = TestFixture.session()
        try TestFixture.seed(store, session: session)
        _ = try store.sync { try $0.commitRaw(sessionID: session.id, records: [raw("motion", 1, "{\"a\":1}")], snapshot: nil) }
        #expect(throws: CollectionStoreError.rawConflict(stream: "motion", sequence: 1)) {
            _ = try store.sync { try $0.commitRaw(sessionID: session.id, records: [raw("motion", 1, "{\"a\":2}")], snapshot: nil) }
        }
        #expect(try store.sync { try $0.rawRows(sessionID: session.id) }.first?.payload == Data("{\"a\":1}".utf8))
    }

    @Test func batchCreationIsAtomicAndNeverLinksARowTwice() throws {
        let failures = StoreFailureSwitch()
        let store = CollectionStore(directory: TestFixture.tempDirectory("StoreBatch"), failureInjector: failures.injector)
        let session = TestFixture.session()
        try TestFixture.seed(store, session: session)
        _ = try store.sync { try $0.commitRaw(sessionID: session.id, records: (1...70).map { raw("motion", $0) }, snapshot: nil) }
        func build(_ id: String, _ rows: [RawRow]) throws -> Data { Data("{\"n\":\(rows.count)}".utf8) }
        failures.fail(.batchCommit)
        #expect(throws: CollectionStoreError.self) {
            _ = try store.sync { try $0.createTelemetryBatches(sessionID: session.id, maximumSamples: 64, minimumSamples: 1, build: build) }
        }
        #expect(try store.sync { try $0.loadUploadLedger().items }.isEmpty, "no batch item without its raw links")
        #expect(try store.sync { try $0.unbatchedTelemetryCount(sessionID: session.id) } == 70)
        let created = try store.sync { try $0.createTelemetryBatches(sessionID: session.id, maximumSamples: 64, minimumSamples: 1, build: build) }
        #expect(created.count == 2)
        #expect(created.map { String(decoding: $0.payload, as: UTF8.self) } == ["{\"n\":64}", "{\"n\":6}"])
        let rows = try store.sync { try $0.rawRows(sessionID: session.id) }
        #expect(rows.allSatisfy { $0.batchID != nil })
        #expect(Dictionary(grouping: rows, by: { $0.batchID! }).mapValues(\.count) == [created[0].itemID: 64, created[1].itemID: 6])
        #expect(try store.sync { try $0.createTelemetryBatches(sessionID: session.id, maximumSamples: 64, minimumSamples: 1, build: build) }.isEmpty)
    }

    @Test func corruptDatabaseIsReportedAndNotReplacedWithAnEmptyOne() async throws {
        let directory = TestFixture.tempDirectory("StoreCorrupt")
        let file = directory.appendingPathComponent(CollectionStore.databaseFileName)
        let garbage = Data(repeating: 0x42, count: 8_192)
        try garbage.write(to: file)
        let store = CollectionStore(directory: directory)
        #expect(throws: CollectionStoreError.self) { _ = try store.sync { try $0.count("sessions") } }
        #expect(try Data(contentsOf: file) == garbage, "the damaged file is preserved for recovery")
    }

    @Test func exportWritesNDJSONWithFractionalTimestamps() async throws {
        let store = CollectionStore(directory: TestFixture.tempDirectory("StoreExport"))
        let core = CollectionCore(store: store)
        let session = TestFixture.session()
        let opened = await awaitCore { core.beginSession(TestFixture.beginRequest(session), completion: $0) }
        let context = try #require(try opened.get().contexts[.motion])
        core.submit(TestFixture.captured(TestFixture.motion(native: 100.5)), context: context)
        _ = await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }
        let output = TestFixture.tempDirectory("Export")
        try store.sync { try $0.exportNDJSON(sessionID: session.id, to: output) }
        let text = try String(contentsOf: output.appendingPathComponent("motion.ndjson"), encoding: .utf8)
        #expect(text.contains("2023-11-14T22:13:20.500Z"))
        #expect(FileManager.default.fileExists(atPath: output.appendingPathComponent("metadata.json").path))
    }
}

// MARK: - CollectionCore

@MainActor
struct CollectionCoreTests {
    private func core(_ name: String, failures: StoreFailureSwitch? = nil, configuration: CollectionCoreConfiguration = .init(),
                      directory: URL? = nil) -> (CollectionCore, CollectionStore, CoreEventRecorder) {
        let store = CollectionStore(directory: directory ?? TestFixture.tempDirectory(name), failureInjector: failures?.injector)
        let core = CollectionCore(store: store, configuration: configuration)
        let recorder = CoreEventRecorder()
        core.setEventHandler(recorder.handler)
        return (core, store, recorder)
    }

    private func begin(_ core: CollectionCore, _ session: CollectionSession,
                       streams: Set<CaptureStream> = [.motion, .location, .altimeter, .pedometer, .arkit],
                       clocks: SensorRunClocks = TestFixture.clocks()) async throws -> [CaptureStream: TrackingCaptureContext] {
        try await awaitCore { core.beginSession(TestFixture.beginRequest(session, streams: streams, clocks: clocks), completion: $0) }.get().contexts
    }

    @Test func callbacksAreCommittedByCountAndByTheTailTimer() async throws {
        let (core, store, _) = core("CoreCommit")
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        for index in 0..<40 { core.submit(TestFixture.captured(TestFixture.motion(native: 101 + Double(index) * 0.02)), context: contexts[.motion]!) }
        core.waitUntilIdleForTesting()
        #expect(try store.sync { try $0.rawRows(sessionID: session.id, stream: "motion") }.count == 32, "32 samples commit immediately")
        try? await Task.sleep(nanoseconds: 400_000_000)
        core.waitUntilIdleForTesting()
        let rows = try store.sync { try $0.rawRows(sessionID: session.id, stream: "motion") }
        #expect(rows.map(\.sequence) == Array(1...40), "the tail commits within 250 ms of its first sample")
        #expect(rows.first?.measuredAtMs == 1_700_000_001_000, "measuredAt = anchor + (native - uptime)")
        let leases = try store.sync { try $0.leases(sessionID: session.id) }
        #expect(leases["motion"] == StreamLeaseRow(reservedExclusive: 201, lastRecorded: 40, recordedCount: 40))
    }

    @Test func stopDrainsEveryAdmittedCallbackAndRejectsLateOnes() async throws {
        let (core, store, _) = core("CoreStop")
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        let motion = contexts[.motion]!
        DispatchQueue.concurrentPerform(iterations: 100) { index in
            core.submit(TestFixture.captured(TestFixture.motion(native: 101 + Double(index) * 0.001)), context: motion)
        }
        let result = try await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }.get()
        core.submit(TestFixture.captured(TestFixture.motion(native: 200)), context: motion) // late
        core.waitUntilIdleForTesting()
        #expect(result.manifest == LastSequencesPayload(location: -1, motion: 100, altimeter: -1, pedometer: -1))
        #expect(try store.sync { try $0.rawRows(sessionID: session.id, stream: "motion") }.count == 100)
        #expect(result.items.last?.kind == .finish)
        let batches = try store.sync { try $0.loadUploadLedger().items }.filter { $0.kind == .telemetry }
        #expect(batches.count == 2, "100 samples → batches of 64 + 36")
        let stored = try #require(try store.sync { try $0.session(id: session.id) })
        #expect(stored.captureState == .stopped)
        #expect(stored.snapshot?.session.sampleCounts.motion == 100)
        #expect(try store.sync { try $0.unbatchedTelemetryCount(sessionID: session.id) } == 0)
    }

    @Test func commitFailureKeepsBufferAndStopRetryUsesTheSameSequences() async throws {
        let failures = StoreFailureSwitch()
        let (core, store, events) = core("CoreCommitFailure", failures: failures)
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        failures.fail(.rawCommit, times: 2)
        for index in 0..<32 { core.submit(TestFixture.captured(TestFixture.motion(native: 101 + Double(index) * 0.02)), context: contexts[.motion]!) }
        core.waitUntilIdleForTesting()
        #expect(events.storageFailures == ["RAW_COMMIT_FAILED"])
        // Admission is closed after a storage failure: nothing new is attributed to the session.
        core.submit(TestFixture.captured(TestFixture.motion(native: 150)), context: contexts[.motion]!)
        let failed = await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }
        guard case .failure = failed else { Issue.record("Stop must fail while the raw commit fails"); return }
        #expect(try store.sync { try $0.session(id: session.id)?.captureState } == .stopping, "stop intent persisted")
        let retried = try await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }.get()
        #expect(try store.sync { try $0.rawRows(sessionID: session.id, stream: "motion") }.map(\.sequence) == Array(1...32))
        #expect(retried.manifest.motion == 32)
    }

    @Test func leaseReservationFailureIssuesNothing() async throws {
        let failures = StoreFailureSwitch()
        let (core, store, events) = core("CoreLease", failures: failures)
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        failures.fail(.leaseReserve)
        core.submit(TestFixture.captured(TestFixture.motion(native: 101)), context: contexts[.motion]!)
        core.waitUntilIdleForTesting()
        #expect(events.storageFailures == ["SEQUENCE_LEASE_RESERVATION_FAILED"])
        let result = try await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }.get()
        #expect(result.manifest.motion == -1)
        #expect(try store.sync { try $0.rawRows(sessionID: session.id) }.isEmpty)
    }

    @Test func crashThenResumeNeverReusesASequenceAndManifestUsesRealLastSample() async throws {
        let directory = TestFixture.tempDirectory("CoreResume")
        let (first, _, _) = core("unused", directory: directory)
        let session = TestFixture.session()
        let contexts = try await begin(first, session)
        for index in 0..<5 { first.submit(TestFixture.captured(TestFixture.motion(native: 101 + Double(index) * 0.02)), context: contexts[.motion]!) }
        try? await Task.sleep(nanoseconds: 400_000_000)
        first.waitUntilIdleForTesting()
        // "Crash": a new process opens the database; the old core never stops.
        let (second, store, _) = core("unused", directory: directory)
        let resumed = try await awaitCore {
            second.resumeSession(SessionResumeRequest(sessionID: session.id, clocks: TestFixture.clocks(uptime: 50),
                                                      streams: [.motion], walkingFrame: nil, deviceID: session.deviceId), completion: $0)
        }.get()
        #expect(resumed.contexts[.motion] != contexts[.motion], "a resumed run gets a new segment/generation")
        // Resume immediately followed by Stop: the reserved boundary is not reported as a sample.
        let noNewSamples = try await awaitCore { second.beginStop(reason: "user_stop", completion: $0) }.get()
        #expect(noNewSamples.manifest.motion == 5)
        #expect(noNewSamples.manifest.location == -1)
        #expect(try store.sync { try $0.rawRows(sessionID: session.id, stream: "motion") }.map(\.sequence) == [1, 2, 3, 4, 5])
    }

    @Test func resumedRunSkipsPastTheDurableBoundary() async throws {
        let directory = TestFixture.tempDirectory("CoreResumeIssue")
        let (first, _, _) = core("unused", directory: directory)
        let session = TestFixture.session()
        let contexts = try await begin(first, session)
        for index in 0..<3 { first.submit(TestFixture.captured(TestFixture.motion(native: 101 + Double(index) * 0.02)), context: contexts[.motion]!) }
        try? await Task.sleep(nanoseconds: 400_000_000)
        first.waitUntilIdleForTesting()
        let (second, store, _) = core("unused", directory: directory)
        let resumed = try await awaitCore {
            second.resumeSession(SessionResumeRequest(sessionID: session.id, clocks: TestFixture.clocks(),
                                                      streams: [.motion], walkingFrame: nil, deviceID: session.deviceId), completion: $0)
        }.get()
        second.submit(TestFixture.captured(TestFixture.motion(native: 105)), context: resumed.contexts[.motion]!)
        let result = try await awaitCore { second.beginStop(reason: "user_stop", completion: $0) }.get()
        let sequences = try store.sync { try $0.rawRows(sessionID: session.id, stream: "motion") }.map(\.sequence)
        #expect(sequences == [1, 2, 3, 201], "the first resumed sequence is the reserved boundary, never 4")
        #expect(result.manifest.motion == 201)
    }

    @Test func pedometerDuplicatesAreCheckedBeforeASequenceIsIssued() async throws {
        let (core, store, events) = core("CorePedometer")
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        let end = Date(timeIntervalSince1970: 1_700_000_010.1231)
        let pedometer = contexts[.pedometer]!
        core.submit(TestFixture.captured(TestFixture.pedometer(endDate: end, steps: 10)), context: pedometer)
        core.submit(TestFixture.captured(TestFixture.pedometer(endDate: end.addingTimeInterval(0.0002), steps: 10, source: .historicalRecovery)), context: pedometer)
        core.submit(TestFixture.captured(TestFixture.pedometer(endDate: end, steps: 12)), context: pedometer)
        core.submit(TestFixture.captured(TestFixture.pedometer(endDate: end.addingTimeInterval(5), steps: 15)), context: pedometer)
        let result = try await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }.get()
        #expect(try store.sync { try $0.rawRows(sessionID: session.id, stream: "pedometer") }.map(\.sequence) == [1, 2])
        #expect(result.manifest.pedometer == 2)
        #expect(events.diagnostics.contains("PEDOMETER_DUPLICATE_CONFLICT"))
        #expect(try store.sync { try $0.auditCount(sessionID: session.id, reason: "PEDOMETER_DUPLICATE_CONFLICT") } == 1)
        #expect(result.snapshot.diagnostics.pedometerDuplicateDrops == 1)
    }

    @Test func clockResidualIsFlaggedButNeverRewritesTheMapping() async throws {
        let (core, store, events) = core("CoreClock")
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        // Callback arrives 3 s after the nominal measurement time.
        core.submit(TestFixture.captured(TestFixture.motion(native: 101), callbackEpoch: Date(timeIntervalSince1970: 1_700_000_004)),
                    context: contexts[.motion]!)
        core.submit(TestFixture.captured(TestFixture.motion(native: 102), callbackEpoch: Date(timeIntervalSince1970: 1_700_000_002.1)),
                    context: contexts[.motion]!)
        let result = try await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }.get()
        let rows = try store.sync { try $0.rawRows(sessionID: session.id, stream: "motion") }
        #expect(rows.map(\.measuredAtMs) == [1_700_000_001_000, 1_700_000_002_000])
        #expect(events.diagnostics.filter { $0 == "CLOCK_MAPPING_UNCERTAIN" }.count == 1)
        let envelope = try TrackingJSONCodec.makeDecoder().decode(RawSampleEnvelope<MotionSample>.self, from: rows[0].payload)
        #expect(envelope.capture.clockQuality == "uncertain")
        #expect(envelope.capture.verifiedOffsetSeconds == 0)
        #expect(result.snapshot.diagnostics.clock?["motion"]?.firstResidualSeconds == 3)
    }

    @Test func telemetryBatchKeepsTheServerContractWithoutLocalMetadata() async throws {
        let (core, store, _) = core("CoreWire")
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        core.submit(TestFixture.captured(TestFixture.motion(native: 101)), context: contexts[.motion]!)
        let result = try await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }.get()
        let batch = try #require(result.items.first { $0.kind == .telemetry })
        let object = try JSONSerialization.jsonObject(with: batch.payload) as? [String: Any]
        let motion = (object?["motion"] as? [[String: Any]])?.first
        #expect(Set(motion?.keys.map { $0 } ?? []) == ["sequence", "timestamp", "userAcceleration", "rotationRate", "gravity", "attitude", "appState", "sensorSegmentId"])
        #expect(motion?["timestamp"] as? String == "2023-11-14T22:13:21.000Z")
        let text = try TelemetryWireEncoding.requestText(kind: .telemetry, payload: batch.payload, serverSessionId: "srv",
                                                         clientSessionId: session.id.uuidString, requestId: "r1")
        #expect(text.contains("\"sessionId\":\"srv\""))
        _ = store
    }

    @Test func arkitBackpressurePausesCaptureKeepsPosesAndResumesOnlyBelowThreshold() async throws {
        var configuration = CollectionCoreConfiguration()
        configuration.arkitPauseCount = 5
        configuration.arkitResumeCount = 3
        configuration.commitCount = 1
        let (core, store, events) = core("CoreArkit", configuration: configuration)
        let session = TestFixture.session()
        let contexts = try await begin(core, session)
        let arSession = UUID()
        for index in 1...7 {
            core.submit(TestFixture.captured(TestFixture.pose(sequence: index, frameTimestamp: 101 + Double(index) * 0.1, arSession: arSession)),
                        context: contexts[.arkit]!)
        }
        core.waitUntilIdleForTesting()
        #expect(events.arkitPaused)
        let pending = try store.sync { try $0.pendingItemBacklog(sessionID: session.id, kind: .arkit) }
        #expect(pending.count == 5, "poses admitted before the pause are kept; later callbacks are rejected, not stored")
        let tooEarly = await awaitCore { core.reopenArkit(completion: $0) }
        guard case .failure = tooEarly else { Issue.record("resume must wait for the backlog to drain"); return }
        for item in try store.sync({ try $0.loadUploadLedger().items }).filter({ $0.kind == .arkit }).prefix(3) {
            try store.sync { try $0.markAcked(item.key) }
        }
        let context = try await awaitCore { core.reopenArkit(completion: $0) }.get()
        #expect(context != contexts[.arkit])
        core.submit(TestFixture.captured(TestFixture.pose(sequence: 1, frameTimestamp: 120, arSession: UUID())), context: context)
        core.waitUntilIdleForTesting()
        #expect(try store.sync { try $0.rawRows(sessionID: session.id, stream: "arkit") }.count == 6)
    }

    @Test func markerIsStoredWithItsLedgerItemInOneCommit() async throws {
        let (core, store, events) = core("CoreMarker")
        let session = TestFixture.session()
        _ = try await begin(core, session)
        let marker = EventMarker(id: UUID(), sessionId: session.id, timestamp: Date(), type: .stairStart, note: "n",
                                 latitude: nil, longitude: nil, altitude: nil, horizontalAccuracy: nil, verticalAccuracy: nil)
        core.addMarker(marker)
        core.waitUntilIdleForTesting()
        #expect(events.committedItems.map(\.itemID) == [marker.id.uuidString])
        #expect(try store.sync { try $0.rawRows(sessionID: session.id, stream: "marker") }.first?.batchID == marker.id.uuidString)
    }
}

// MARK: - Legacy migration

@MainActor
struct LegacyMigrationTests {
    private struct Legacy {
        let root: URL
        let active: CollectionSession
        let other: UUID
        let batchID: String
        let markerID: String
        let quarantinedMarkerID: String
    }

    /// Writes files exactly as the pre-SQLite build did (second-precision dates in the active
    /// snapshot, fractional elsewhere).
    private func writeLegacyFiles() throws -> Legacy {
        let root = TestFixture.tempDirectory("Legacy")
        let encoder = TrackingJSONCodec.makeEncoder()
        let active = TestFixture.session()
        let other = UUID()
        var queue = LegacyUploadQueueState()
        queue.sessionStarts[active.id.uuidString] = try TrackingJSONCodec.makeDecoder().decode(SessionStartPayload.self, from: TestFixture.startPayload(active))
        queue.sessionOwners[active.id.uuidString] = TestFixture.owner
        queue.serverSessionIds[active.id.uuidString] = "srv-1"
        let batchMotion = MotionSample(id: UUID(), sessionId: active.id, sequence: 2, timestamp: Date(timeIntervalSince1970: 1_700_000_002),
            userAccelerationX: 0, userAccelerationY: 0, userAccelerationZ: 0, rotationRateX: 0, rotationRateY: 0, rotationRateZ: 0,
            gravityX: 0, gravityY: 0, gravityZ: -1, attitudeRoll: 0, attitudePitch: 0, attitudeYaw: 0,
            appState: .foreground, sensorSegmentId: "s")
        let batch = TelemetryBatchPayload(batchId: UUID().uuidString, sessionId: nil, clientSessionId: active.id.uuidString,
                                          createdAt: Date(), locations: [], motion: [MotionPayload(batchMotion)], altimeter: [], pedometer: [])
        queue.telemetry = [batch]
        let markerA = EventMarker(id: UUID(), sessionId: active.id, timestamp: Date(), type: .entrance, note: nil, latitude: nil, longitude: nil, altitude: nil, horizontalAccuracy: nil, verticalAccuracy: nil)
        let markerB = EventMarker(id: UUID(), sessionId: active.id, timestamp: Date(), type: .stop, note: nil, latitude: nil, longitude: nil, altitude: nil, horizontalAccuracy: nil, verticalAccuracy: nil)
        queue.markers = [MarkerPayload(marker: markerA), MarkerPayload(marker: markerB)]
        queue.quarantinedMarkerIds = [markerB.id.uuidString]
        queue.lastErrorCodes[markerB.id.uuidString] = "VALIDATION_ERROR"
        // A finished session from an unknown owner (no sessionOwners entry).
        queue.finishes = [FinishPayload(clientSessionId: other.uuidString, sessionId: nil, endedAt: Date(),
                                        lastSequences: LastSequencesPayload(location: 1, motion: -1, altimeter: -1, pedometer: -1), interrupted: false)]
        queue.diagnosticEvents = [LegacyQueuedDiagnosticEvent(clientSessionId: other.uuidString,
            event: DiagnosticEventItem(eventId: UUID().uuidString, eventType: "SENSOR_STOPPED", clientTimestamp: Date(), metadata: [:]))]
        try encoder.encode(queue).write(to: root.appendingPathComponent(LegacyMigrator.queueFile))

        var state = TestFixture.snapshot(active)
        state.motionSequence = 3
        state.session.sampleCounts.motion = 3
        var activeJSON = String(decoding: try encoder.encode(state), as: UTF8.self)
        activeJSON = activeJSON.replacingOccurrences(of: ".000Z", with: "Z") // legacy second precision
        try Data(activeJSON.utf8).write(to: root.appendingPathComponent(LegacyMigrator.activeFile))

        let leases = root.appendingPathComponent(LegacyMigrator.leaseDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: leases, withIntermediateDirectories: true)
        try JSONEncoder().encode(SequenceLease(location: 0, motion: 200, altimeter: 0, pedometer: 0))
            .write(to: leases.appendingPathComponent("\(active.id.uuidString).json"))

        let sessionDirectory = LegacySessionArchive.sessionsDirectory(root: root).appendingPathComponent(active.id.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: sessionDirectory, withIntermediateDirectories: true)
        var ndjson = Data()
        for sequence in 1...2 {
            let sample = MotionSample(id: UUID(), sessionId: active.id, sequence: sequence, timestamp: Date(timeIntervalSince1970: 1_700_000_000 + Double(sequence)),
                userAccelerationX: 0, userAccelerationY: 0, userAccelerationZ: 0, rotationRateX: 0, rotationRateY: 0, rotationRateZ: 0,
                gravityX: 0, gravityY: 0, gravityZ: -1, attitudeRoll: 0, attitudePitch: 0, attitudeYaw: 0, appState: .foreground, sensorSegmentId: "s")
            ndjson.append(try encoder.encode(sample)); ndjson.append(0x0A)
        }
        ndjson.append(Data("{\"id\":\"torn".utf8)) // crash mid-append
        try ndjson.write(to: sessionDirectory.appendingPathComponent("motion.ndjson"))
        try encoder.encode(active).write(to: sessionDirectory.appendingPathComponent("metadata.json"))
        return Legacy(root: root, active: active, other: other, batchID: batch.batchId,
                      markerID: markerA.id.uuidString, quarantinedMarkerID: markerB.id.uuidString)
    }

    @Test func legacyFilesAreImportedOnceWithIdsStatesOwnersAndLeases() async throws {
        let legacy = try writeLegacyFiles()
        let store = CollectionStore(directory: legacy.root)
        let ledger = try store.sync { try $0.loadUploadLedger() }
        let items = Dictionary(uniqueKeysWithValues: ledger.items.map { ($0.itemID, $0) })
        #expect(items[legacy.batchID]?.state == .pending)
        #expect(items[legacy.markerID]?.state == .pending)
        #expect(items[legacy.quarantinedMarkerID]?.state == .quarantined)
        #expect(items[legacy.quarantinedMarkerID]?.lastError?.code == "VALIDATION_ERROR")
        #expect(items[legacy.other.uuidString]?.state == .heldOrphaned, "owner-less legacy work is never sent under the current login")
        #expect(ledger.items.filter { $0.sessionID == legacy.other.uuidString }.allSatisfy { $0.state == .heldOrphaned })
        let activeSync = try #require(ledger.sessions.first { $0.sessionID == legacy.active.id.uuidString })
        #expect(activeSync.owner == TestFixture.owner)
        #expect(activeSync.serverSessionID == "srv-1")
        #expect(ledger.sessions.first { $0.sessionID == legacy.other.uuidString }?.owner == nil)

        let stored = try #require(try store.sync { try $0.session(id: legacy.active.id) })
        #expect(stored.captureState == .recording, "the interrupted session is offered for Resume/Finish")
        #expect(stored.snapshot?.lastPersistedAt == legacy.active.startedAt, "second-precision legacy dates decode")
        let raw = try store.sync { try $0.rawRows(sessionID: legacy.active.id, stream: "motion") }
        #expect(raw.map(\.sequence) == [1, 2])
        #expect(raw.first { $0.sequence == 2 }?.batchID == legacy.batchID, "rows still in a pending legacy batch keep that batch id")
        #expect(raw.first { $0.sequence == 1 }?.batchID == LegacyMigrator.legacyBatchMarker)
        #expect(try store.sync { try $0.auditCount(sessionID: legacy.active.id, reason: "LEGACY_NDJSON_UNREADABLE_LINE") } == 1)
        let lease = try #require(try store.sync { try $0.leases(sessionID: legacy.active.id)["motion"] })
        #expect(lease.reservedExclusive == 200)
        #expect(lease.lastRecorded == 3, "the snapshot's issued sequence is a floor for the manifest")

        let fileManager = FileManager.default
        #expect(!fileManager.fileExists(atPath: legacy.root.appendingPathComponent(LegacyMigrator.queueFile).path))
        #expect(fileManager.fileExists(atPath: legacy.root.appendingPathComponent(LegacyMigrator.queueFile + LegacyMigrator.backupSuffix).path))
        #expect(fileManager.fileExists(atPath: legacy.root.appendingPathComponent(LegacyMigrator.activeFile + LegacyMigrator.backupSuffix).path))
        #expect(try store.sync { try $0.migrationRows() }.keys.contains(LegacyMigrator.queueFile))

        // Re-running (e.g. a crash after COMMIT but before the rename) imports nothing twice.
        let counts = try store.sync { access in (try access.count("upload_items"), try access.count("raw_samples"), try access.count("sessions")) }
        try fileManager.copyItem(at: legacy.root.appendingPathComponent(LegacyMigrator.queueFile + LegacyMigrator.backupSuffix),
                                 to: legacy.root.appendingPathComponent(LegacyMigrator.queueFile))
        try fileManager.copyItem(at: legacy.root.appendingPathComponent(LegacyMigrator.activeFile + LegacyMigrator.backupSuffix),
                                 to: legacy.root.appendingPathComponent(LegacyMigrator.activeFile))
        let reopened = CollectionStore(directory: legacy.root)
        let again = try reopened.sync { access in (try access.count("upload_items"), try access.count("raw_samples"), try access.count("sessions")) }
        #expect(again == counts)
    }

    @Test func unreadableLegacyQueueFailsMigrationAndKeepsTheOriginal() async throws {
        let root = TestFixture.tempDirectory("LegacyCorrupt")
        let original = Data("{\"telemetry\": [ {\"batchId\": 1".utf8)
        try original.write(to: root.appendingPathComponent(LegacyMigrator.queueFile))
        let store = CollectionStore(directory: root)
        #expect(throws: CollectionStoreError.self) { _ = try store.sync { try $0.count("upload_items") } }
        #expect(try Data(contentsOf: root.appendingPathComponent(LegacyMigrator.queueFile)) == original)
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent(LegacyMigrator.queueFile + LegacyMigrator.backupSuffix).path))
    }

    @Test func migratedInterruptedSessionResumesAndFinishesWithTheLegacyFloor() async throws {
        let legacy = try writeLegacyFiles()
        let store = CollectionStore(directory: legacy.root)
        let core = CollectionCore(store: store)
        let resumed = try await awaitCore {
            core.resumeSession(SessionResumeRequest(sessionID: legacy.active.id, clocks: TestFixture.clocks(), streams: [.motion],
                                                    walkingFrame: nil, deviceID: legacy.active.deviceId), completion: $0)
        }.get()
        core.submit(TestFixture.captured(TestFixture.motion(native: 103)), context: resumed.contexts[.motion]!)
        let stop = try await awaitCore { core.beginStop(reason: "user_stop", completion: $0) }.get()
        #expect(stop.manifest.motion == 200, "first post-migration sequence starts at the legacy lease boundary")
        #expect(try store.sync { try $0.rawRows(sessionID: legacy.active.id, stream: "motion") }.map(\.sequence) == [1, 2, 200])
    }
}
